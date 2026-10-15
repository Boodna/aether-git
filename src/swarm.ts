import type { ClaimInput, SwarmCoordinatorDO } from "./coordinator";
import { splitSymbolId } from "./symbols";
import type { Env, Lease, LeaseMode, LeaseStatus, PushAnalysis, SwarmEvent } from "./types";

/** FNV-1a: stable, fast, good-enough spread for shard routing. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const groupBy = <T>(items: T[], key: (t: T) => number) => {
  const m = new Map<number, T[]>();
  for (const it of items) m.set(key(it), [...(m.get(key(it)) ?? []), it]);
  return m;
};

/**
 * Routes one baseline's coordination state across sharded Durable Objects.
 * Symbol shards are keyed by file path; lease shards by fork name.
 */
export class Swarm {
  readonly symbolShards: number;
  readonly leaseShards: number;

  constructor(private env: Env, readonly baseline: string) {
    this.symbolShards = Math.max(1, Number(env.SYMBOL_SHARDS) || 32);
    this.leaseShards = Math.max(1, Number(env.LEASE_SHARDS) || 32);
  }

  private stub(name: string): DurableObjectStub<SwarmCoordinatorDO> {
    return this.env.SWARM_COORDINATOR.get(this.env.SWARM_COORDINATOR.idFromName(`${this.baseline}/${name}`));
  }
  private symShardOf = (file: string) => hash(file) % this.symbolShards;
  private leaseShardOf = (forkRepo: string) => hash(forkRepo) % this.leaseShards;
  private sym = (i: number) => this.stub(`sym/${i}`);
  private lease = (i: number) => this.stub(`lease/${i}`);
  /** Weave history and baseline-level events live on lease shard 0. */
  private meta = () => this.lease(0);

  /**
   * Claim leases for many agents at once. Each agent's symbols are split by symbol shard; every
   * shard processes its slice of the batch in one RPC. Results are combined per agent, then
   * lease records (and any rival escalations) are written to lease shards in one RPC each.
   */
  async claimMany(inputs: ClaimInput[], quiet = false) {
    type Part = { forkRepo: string; symbols: string[] };
    const parts: Array<{ shard: number; part: Part }> = [];
    for (const input of inputs) {
      for (const [shard, ids] of groupBy(input.symbols, (s) => this.symShardOf(splitSymbolId(s).file))) {
        parts.push({ shard, part: { forkRepo: input.forkRepo, symbols: ids } });
      }
    }
    const perShard = groupBy(parts, (p) => p.shard);
    const results = (
      await Promise.all([...perShard].map(([shard, ps]) => this.sym(shard).claimSymbols(ps.map((p) => p.part))))
    ).flat();

    const combined = new Map<string, { sameSymbol: number; sameFile: number; sample: string[] }>();
    const escalations = new Map<string, LeaseMode>();
    for (const r of results) {
      const c = combined.get(r.forkRepo) ?? { sameSymbol: 0, sameFile: 0, sample: [] };
      c.sameSymbol += r.sameSymbol;
      c.sameFile += r.sameFile;
      c.sample.push(...r.sample);
      combined.set(r.forkRepo, c);
      for (const e of r.escalate) {
        const prev = escalations.get(e.forkRepo);
        if (!prev || (prev !== "TOURNAMENT" && e.mode === "TOURNAMENT")) escalations.set(e.forkRepo, e.mode);
      }
    }

    const records = inputs.map((input) => {
      const c = combined.get(input.forkRepo)!;
      const mode: LeaseMode = c.sameSymbol ? "TOURNAMENT" : c.sameFile ? "ORTHOGONAL_SHARED_FILE" : "AST_LOCK";
      const detail = `${input.agentId} → ${mode} on ${input.symbols.join(", ")}` + (c.sameSymbol ? ` (vs ${c.sameSymbol} rival${c.sameSymbol > 1 ? "s" : ""})` : "");
      return { input, mode, detail, rivals: c };
    });
    // Write lease rows first, then escalations: an earlier agent in this batch can be escalated by
    // a later one, so its row must exist before the escalation lands.
    await Promise.all(
      [...groupBy(records, (r) => this.leaseShardOf(r.input.forkRepo))].map(([shard, rs]) =>
        this.lease(shard).putLeases(rs.map(({ input, mode, detail }) => ({ input, mode, detail })), quiet)
      )
    );
    await Promise.all(
      [...groupBy([...escalations].map(([forkRepo, mode]) => ({ forkRepo, mode })), (e) => this.leaseShardOf(e.forkRepo))].map(([shard, es]) =>
        this.lease(shard).escalate(es)
      )
    );
    return records.map((r) => ({ forkRepo: r.input.forkRepo, mode: r.mode, rivals: r.rivals }));
  }

  async claim(input: ClaimInput) {
    const [r] = await this.claimMany([input]);
    return { lease: (await this.getLease(input.forkRepo))!, rivals: r.rivals };
  }

  getLease(forkRepo: string): Promise<Lease | null> {
    return this.lease(this.leaseShardOf(forkRepo)).getLease(forkRepo) as Promise<Lease | null>;
  }

  recordPush(forkRepo: string, analysis: PushAnalysis, score: number): Promise<Lease | null> {
    return this.lease(this.leaseShardOf(forkRepo)).recordPush(forkRepo, analysis, score) as Promise<Lease | null>;
  }

  /** Top pushed candidates across all lease shards, best first. */
  async candidates(limit = 200): Promise<Lease[]> {
    const all = (await Promise.all(Array.from({ length: this.leaseShards }, (_, i) => this.lease(i).candidates(limit)))).flat() as Lease[];
    return all.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.createdAt - b.createdAt).slice(0, limit);
  }

  async releaseSymbolsFor(leases: Array<{ forkRepo: string; symbols: string[] }>) {
    const byShard = new Map<number, Set<string>>();
    for (const l of leases) {
      for (const s of l.symbols) {
        const shard = this.symShardOf(splitSymbolId(s).file);
        byShard.set(shard, (byShard.get(shard) ?? new Set()).add(l.forkRepo));
      }
    }
    await Promise.all([...byShard].map(([shard, forks]) => this.sym(shard).releaseSymbols([...forks])));
  }

  /** Settle leases after a weave (or a release) and free their symbols. */
  async settle(items: Array<{ forkRepo: string; status: LeaseStatus }>) {
    const leases = (await Promise.all(items.map((i) => this.getLease(i.forkRepo)))).filter((l): l is Lease => !!l);
    await Promise.all([
      ...[...groupBy(items, (i) => this.leaseShardOf(i.forkRepo))].map(([shard, is]) => this.lease(shard).setStatus(is)),
      this.releaseSymbolsFor(leases),
    ]);
  }

  async completeWeave(input: {
    baselineSha: string;
    resultSha: string;
    merged: string[];
    lost: Array<{ forkRepo: string; reason: string }>;
    rejected: Array<{ forkRepo: string; reason: string }>;
  }) {
    await this.settle([
      ...input.merged.map((forkRepo) => ({ forkRepo, status: "merged" as const })),
      ...input.lost.map((l) => ({ forkRepo: l.forkRepo, status: "lost" as const })),
      ...input.rejected.map((r) => ({ forkRepo: r.forkRepo, status: "rejected" as const })),
    ]);
    await this.meta().recordWeave(input);
  }

  release(forkRepo: string, status: LeaseStatus = "released") {
    return this.settle([{ forkRepo, status }]);
  }

  logEvent(type: string, repo: string, detail: string) {
    return this.meta().logEvent(type, repo, detail);
  }

  async state(limit = 150) {
    type ShardState = {
      counts: Record<string, number>;
      modes: Record<string, number>;
      leases: Lease[];
      events: SwarmEvent[];
      weaves: Array<{ ts: number; baseline_sha: string; result_sha: string; summary: unknown }>;
    };
    type SymStats = { symbols: number; contested: number; files: number; hot: Array<{ file: string; symbol: string; n: number }> };
    const [leaseParts, symParts] = (await Promise.all([
      // Hash routing spreads forks evenly, so each shard only needs ~2x its fair share of the newest
      // rows (plus slack) for the merged top-N to be exact in practice. Shard 0 also holds weave
      // and baseline events, so it gets the full event budget.
      Promise.all(Array.from({ length: this.leaseShards }, (_, i) => {
        const share = Math.ceil((2 * limit) / this.leaseShards) + 8;
        return this.lease(i).state(share, i === 0 ? 60 : Math.ceil(200 / this.leaseShards) + 4) as unknown as Promise<ShardState>;
      })),
      Promise.all(Array.from({ length: this.symbolShards }, (_, i) => this.sym(i).symbolStats() as unknown as Promise<SymStats>)),
    ])) as [ShardState[], SymStats[]];
    const sum = (objs: Record<string, number>[]) => objs.reduce<Record<string, number>>((acc, o) => {
      for (const [k, v] of Object.entries(o)) acc[k] = (acc[k] ?? 0) + (v as number);
      return acc;
    }, {});
    const hot = symParts
      .flatMap((s) => s.hot)
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);
    return {
      shards: { symbol: this.symbolShards, lease: this.leaseShards },
      counts: sum(leaseParts.map((p) => p.counts)),
      modes: sum(leaseParts.map((p) => p.modes)),
      symbols: {
        live: symParts.reduce((a, s) => a + s.symbols, 0),
        contested: symParts.reduce((a, s) => a + s.contested, 0),
        files: symParts.reduce((a, s) => a + s.files, 0),
        hot,
      },
      leases: leaseParts
        .flatMap((p) => p.leases)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit),
      events: leaseParts
        .flatMap((p) => p.events)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 100),
      weaves: leaseParts.flatMap((p) => p.weaves).sort((a, b) => b.ts - a.ts),
    };
  }

  async reset() {
    await Promise.all([
      ...Array.from({ length: this.leaseShards }, (_, i) => this.lease(i).reset()),
      ...Array.from({ length: this.symbolShards }, (_, i) => this.sym(i).reset()),
    ]);
    await this.logEvent("swarm.reset", "-", `coordinator state cleared (${this.symbolShards} symbol + ${this.leaseShards} lease shards)`);
  }
}
