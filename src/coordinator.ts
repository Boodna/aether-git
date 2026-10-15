import { DurableObject } from "cloudflare:workers";
import { splitSymbolId } from "./symbols";
import type { Env, Lease, LeaseMode, LeaseStatus, PushAnalysis, SwarmEvent } from "./types";

const MAX_EVENTS = 300;
const RANK: Record<LeaseMode, number> = { AST_LOCK: 0, ORTHOGONAL_SHARED_FILE: 1, TOURNAMENT: 2 };

export interface ClaimInput {
  forkRepo: string;
  agentId: string;
  baselineRepo: string;
  baseSha: string;
  remote: string;
  taskIntent: string;
  symbols: string[];
  ttlSeconds: number;
}

export interface SymbolClaimResult {
  forkRepo: string;
  /** Live rivals on the same symbol (or a covering class/file lease). */
  sameSymbol: number;
  /** Live rivals on other symbols of the same file. */
  sameFile: number;
  sample: string[];
  /** Existing leases whose mode must be raised because of this claim. */
  escalate: Array<{ forkRepo: string; mode: LeaseMode }>;
}

/**
 * One class, two shard roles (a given instance only ever plays one):
 *
 *  - **Symbol shard** (`<baseline>/sym/<n>`, routed by hash of file path): the lock graph for a
 *    slice of the codebase. All symbols of a file live in one shard, so same-file detection is
 *    exact. Live-claim counters per symbol make collision checks O(symbols in the file) instead of
 *    O(agents holding them), so a hotspot with 10,000 rivals costs the same as one with 1.
 *
 *  - **Lease shard** (`<baseline>/lease/<n>`, routed by hash of fork name): per-agent records,
 *    push analyses, scores, events and TTL alarms.
 *
 * Leases never block (contention becomes a tournament), so a claim spanning several symbol
 * shards needs no distributed transaction: each shard records its part independently.
 */
export class SwarmCoordinatorDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS symbol_claims (
        file TEXT NOT NULL, symbol TEXT NOT NULL, fork_repo TEXT NOT NULL,
        live INTEGER NOT NULL DEFAULT 1, mode TEXT NOT NULL,
        PRIMARY KEY (file, symbol, fork_repo)
      );
      CREATE INDEX IF NOT EXISTS claims_by_fork ON symbol_claims(fork_repo);
      -- Escalation looks up live claims by mode; without this a hotspot with N rivals is O(N) per claim.
      CREATE INDEX IF NOT EXISTS claims_by_mode ON symbol_claims(file, symbol, live, mode);
      CREATE TABLE IF NOT EXISTS symbol_counts (
        file TEXT NOT NULL, symbol TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (file, symbol)
      );
      CREATE TABLE IF NOT EXISTS leases (
        fork_repo TEXT PRIMARY KEY, agent_id TEXT NOT NULL, baseline_repo TEXT NOT NULL,
        base_sha TEXT NOT NULL, remote TEXT NOT NULL, task_intent TEXT NOT NULL, symbols TEXT NOT NULL,
        mode TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        latest_commit TEXT, score REAL, analysis TEXT
      );
      CREATE INDEX IF NOT EXISTS leases_status ON leases(status, score);
      CREATE INDEX IF NOT EXISTS leases_created ON leases(created_at);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, repo TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS weaves (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, baseline_sha TEXT NOT NULL, result_sha TEXT, summary TEXT NOT NULL
      );
    `);
  }

  // ───────────────────────────── symbol shard ─────────────────────────────

  private bump(file: string, symbol: string, delta: number) {
    this.sql.exec(
      `INSERT INTO symbol_counts (file, symbol, n) VALUES (?, ?, ?)
       ON CONFLICT(file, symbol) DO UPDATE SET n = MAX(0, n + excluded.n)`,
      file,
      symbol,
      delta
    );
  }

  /** Process a batch of claims in order; later claims in the batch see earlier ones. */
  claimSymbols(batch: Array<{ forkRepo: string; symbols: string[] }>): SymbolClaimResult[] {
    const out: SymbolClaimResult[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const { forkRepo, symbols } of batch) {
        let sameSymbol = 0;
        let sameFile = 0;
        const sample = new Set<string>();
        const escalate = new Map<string, LeaseMode>();
        const byFile = new Map<string, string[]>();
        for (const id of symbols) {
          const { file, symbol } = splitSymbolId(id);
          byFile.set(file, [...(byFile.get(file) ?? []), symbol]);
        }

        for (const [file, mine] of byFile) {
          // Counters for every live symbol in this file: small (symbols per file), not agents per symbol.
          const counts = this.sql.exec("SELECT symbol, n FROM symbol_counts WHERE file = ? AND n > 0", file).toArray();
          const overlaps = (other: string) =>
            mine.some((s) => s === "*" || other === "*" || s === other || other.startsWith(s + ".") || s.startsWith(other + "."));
          const contested = counts.filter((r) => overlaps(r.symbol as string));
          sameSymbol += contested.reduce((a, r) => a + (r.n as number), 0);
          sameFile += counts.filter((r) => !overlaps(r.symbol as string)).reduce((a, r) => a + (r.n as number), 0);

          // Escalate rivals whose recorded mode is below what this claim implies. Each claim row is
          // escalated at most twice over its lifetime, so this stays O(1) amortised per claim.
          for (const r of contested) {
            const rows = this.sql
              .exec("SELECT fork_repo FROM symbol_claims WHERE file = ? AND symbol = ? AND live = 1 AND mode IN ('AST_LOCK', 'ORTHOGONAL_SHARED_FILE') LIMIT 1000", file, r.symbol)
              .toArray();
            for (const row of rows) {
              escalate.set(row.fork_repo as string, "TOURNAMENT");
              this.sql.exec("UPDATE symbol_claims SET mode = 'TOURNAMENT' WHERE file = ? AND symbol = ? AND fork_repo = ?", file, r.symbol, row.fork_repo);
            }
            for (const row of this.sql.exec("SELECT fork_repo FROM symbol_claims WHERE file = ? AND symbol = ? AND live = 1 LIMIT 3", file, r.symbol).toArray())
              sample.add(row.fork_repo as string);
          }
          for (const r of counts.filter((c) => !overlaps(c.symbol as string))) {
            const rows = this.sql
              .exec("SELECT fork_repo FROM symbol_claims WHERE file = ? AND symbol = ? AND live = 1 AND mode = 'AST_LOCK' LIMIT 1000", file, r.symbol)
              .toArray();
            for (const row of rows) {
              if (!escalate.has(row.fork_repo as string)) escalate.set(row.fork_repo as string, "ORTHOGONAL_SHARED_FILE");
              this.sql.exec("UPDATE symbol_claims SET mode = 'ORTHOGONAL_SHARED_FILE' WHERE file = ? AND symbol = ? AND fork_repo = ?", file, r.symbol, row.fork_repo);
            }
          }
        }

        const mode: LeaseMode = sameSymbol ? "TOURNAMENT" : sameFile ? "ORTHOGONAL_SHARED_FILE" : "AST_LOCK";
        for (const [file, mine] of byFile) {
          for (const s of new Set(mine)) {
            this.sql.exec("INSERT OR IGNORE INTO symbol_claims (file, symbol, fork_repo, live, mode) VALUES (?, ?, ?, 1, ?)", file, s, forkRepo, mode);
            this.bump(file, s, 1);
          }
        }
        escalate.delete(forkRepo);
        out.push({ forkRepo, sameSymbol, sameFile, sample: [...sample].filter((f) => f !== forkRepo).slice(0, 5), escalate: [...escalate].map(([f, m]) => ({ forkRepo: f, mode: m })) });
      }
    });
    return out;
  }

  /** Mark a fork's claims dead (merged, lost, rejected, expired, released). Idempotent. */
  releaseSymbols(forkRepos: string[]) {
    this.ctx.storage.transactionSync(() => {
      for (const f of forkRepos) {
        for (const r of this.sql.exec("SELECT file, symbol FROM symbol_claims WHERE fork_repo = ? AND live = 1", f).toArray()) {
          this.bump(r.file as string, r.symbol as string, -1);
        }
        this.sql.exec("UPDATE symbol_claims SET live = 0 WHERE fork_repo = ?", f);
      }
    });
  }

  symbolStats() {
    const r = this.sql
      .exec(
        `SELECT COUNT(*) AS symbols, COALESCE(SUM(n > 1), 0) AS contested, COALESCE(MAX(n), 0) AS hottest,
                COUNT(DISTINCT file) AS files
         FROM symbol_counts WHERE n > 0`
      )
      .one();
    const hot = this.sql.exec("SELECT file, symbol, n FROM symbol_counts WHERE n > 1 ORDER BY n DESC LIMIT 5").toArray();
    return { symbols: r.symbols as number, contested: r.contested as number, hottest: r.hottest as number, files: r.files as number, hot };
  }

  // ───────────────────────────── lease shard ─────────────────────────────

  private log(type: string, repo: string, detail: string) {
    this.sql.exec("INSERT INTO events (ts, type, repo, detail) VALUES (?, ?, ?, ?)", Date.now(), type, repo, detail);
    if (Math.random() < 0.05) this.sql.exec("DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?", MAX_EVENTS);
  }

  private row(r: Record<string, SqlStorageValue>): Lease {
    return {
      forkRepo: r.fork_repo as string,
      agentId: r.agent_id as string,
      baselineRepo: r.baseline_repo as string,
      baseSha: r.base_sha as string,
      remote: r.remote as string,
      taskIntent: r.task_intent as string,
      symbols: JSON.parse(r.symbols as string),
      mode: r.mode as LeaseMode,
      status: r.status as LeaseStatus,
      createdAt: r.created_at as number,
      expiresAt: r.expires_at as number,
      latestCommit: (r.latest_commit as string) ?? null,
      score: (r.score as number) ?? null,
      analysis: r.analysis ? JSON.parse(r.analysis as string) : null,
    };
  }

  getLease(forkRepo: string): Lease | null {
    const r = this.sql.exec("SELECT * FROM leases WHERE fork_repo = ?", forkRepo).toArray()[0];
    return r ? this.row(r) : null;
  }

  putLeases(items: Array<{ input: ClaimInput; mode: LeaseMode; detail: string }>, quiet = false) {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const { input, mode, detail } of items) {
        this.sql.exec(
          `INSERT INTO leases (fork_repo, agent_id, baseline_repo, base_sha, remote, task_intent, symbols, mode, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          input.forkRepo,
          input.agentId,
          input.baselineRepo,
          input.baseSha,
          input.remote,
          input.taskIntent,
          JSON.stringify(input.symbols),
          mode,
          now,
          now + input.ttlSeconds * 1000
        );
        if (!quiet) this.log("lease.claimed", input.forkRepo, detail);
      }
    });
    if (quiet && items.length) this.log("lease.batch", `${items.length} leases`, `${items.length} forkless leases claimed (load test)`);
    void this.scheduleExpiry();
  }

  escalate(items: Array<{ forkRepo: string; mode: LeaseMode }>) {
    for (const { forkRepo, mode } of items) {
      const cur = this.sql.exec("SELECT mode FROM leases WHERE fork_repo = ?", forkRepo).toArray()[0];
      if (cur && RANK[mode] > RANK[cur.mode as LeaseMode]) this.sql.exec("UPDATE leases SET mode = ? WHERE fork_repo = ?", mode, forkRepo);
    }
  }

  recordPush(forkRepo: string, analysis: PushAnalysis, score: number): Lease | null {
    const lease = this.getLease(forkRepo);
    if (!lease) return null;
    if (lease.status !== "active" && lease.status !== "pushed") {
      this.log("push.ignored", forkRepo, `push ${analysis.commitSha.slice(0, 8)} after lease ${lease.status}`);
      return lease;
    }
    this.sql.exec(
      "UPDATE leases SET status = 'pushed', latest_commit = ?, score = ?, analysis = ? WHERE fork_repo = ?",
      analysis.commitSha,
      score,
      JSON.stringify(analysis),
      forkRepo
    );
    const v = analysis.violations.length;
    this.log(
      "push.analyzed",
      forkRepo,
      `${analysis.commitSha.slice(0, 8)} touched ${analysis.touchedSymbols.length} symbol(s), ` +
        (v ? `${v} LEASE VIOLATION(S): ${analysis.violations.join(", ")}` : "lease-compliant") +
        ` · score ${score.toFixed(1)}`
    );
    return this.getLease(forkRepo);
  }

  /** Best pushed candidates in this shard. */
  candidates(limit: number): Lease[] {
    return this.sql
      .exec("SELECT * FROM leases WHERE status = 'pushed' ORDER BY score DESC, created_at ASC LIMIT ?", limit)
      .toArray()
      .map((r) => this.row(r));
  }

  setStatus(items: Array<{ forkRepo: string; status: LeaseStatus }>) {
    this.ctx.storage.transactionSync(() => {
      for (const { forkRepo, status } of items) this.sql.exec("UPDATE leases SET status = ? WHERE fork_repo = ?", status, forkRepo);
    });
  }

  recordWeave(input: { baselineSha: string; resultSha: string; merged: string[]; lost: unknown[]; rejected: unknown[] }) {
    this.sql.exec("INSERT INTO weaves (ts, baseline_sha, result_sha, summary) VALUES (?, ?, ?, ?)", Date.now(), input.baselineSha, input.resultSha, JSON.stringify(input));
    this.log(
      "weave.committed",
      input.resultSha.slice(0, 8),
      `wove ${input.merged.length} fork(s) onto ${input.baselineSha.slice(0, 8)}; ${input.lost.length} lost tournament(s), ${input.rejected.length} rejected`
    );
  }

  logEvent(type: string, repo: string, detail: string) {
    this.log(type, repo, detail);
  }

  /** This shard's slice of the dashboard state. */
  state(limit: number, eventLimit = 60) {
    return {
      counts: Object.fromEntries(this.sql.exec("SELECT status, COUNT(*) AS n FROM leases GROUP BY status").toArray().map((r) => [r.status, r.n])),
      modes: Object.fromEntries(this.sql.exec("SELECT mode, COUNT(*) AS n FROM leases GROUP BY mode").toArray().map((r) => [r.mode, r.n])),
      leases: this.sql.exec("SELECT * FROM leases ORDER BY created_at DESC LIMIT ?", limit).toArray().map((r) => this.row(r)),
      events: this.sql.exec("SELECT * FROM events ORDER BY id DESC LIMIT ?", eventLimit).toArray() as unknown as SwarmEvent[],
      weaves: this.sql
        .exec("SELECT * FROM weaves ORDER BY id DESC LIMIT 10")
        .toArray()
        .map((w) => ({ ...w, summary: JSON.parse(w.summary as string) })),
    };
  }

  reset() {
    this.sql.exec("DELETE FROM leases; DELETE FROM symbol_claims; DELETE FROM symbol_counts; DELETE FROM events; DELETE FROM weaves;");
  }

  private async scheduleExpiry() {
    const next = this.sql.exec("SELECT MIN(expires_at) AS t FROM leases WHERE status = 'active'").one().t as number | null;
    if (next && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(next);
  }

  async alarm() {
    const rows = this.sql.exec("SELECT fork_repo, baseline_repo, symbols FROM leases WHERE status = 'active' AND expires_at <= ?", Date.now()).toArray();
    if (rows.length) {
      this.sql.exec("UPDATE leases SET status = 'expired' WHERE status = 'active' AND expires_at <= ?", Date.now());
      const { Swarm } = await import("./swarm");
      const byBaseline = new Map<string, Array<{ forkRepo: string; symbols: string[] }>>();
      for (const r of rows) {
        const list = byBaseline.get(r.baseline_repo as string) ?? [];
        list.push({ forkRepo: r.fork_repo as string, symbols: JSON.parse(r.symbols as string) });
        byBaseline.set(r.baseline_repo as string, list);
      }
      for (const [baseline, leases] of byBaseline) await new Swarm(this.env, baseline).releaseSymbolsFor(leases);
      this.log("lease.expired", `${rows.length} lease(s)`, "TTL elapsed without a push; symbols released");
    }
    const next = this.sql.exec("SELECT MIN(expires_at) AS t FROM leases WHERE status = 'active'").one().t as number | null;
    if (next) await this.ctx.storage.setAlarm(next);
  }
}
