import { analyzePush } from "./analyze";
import { buildWeavePlan } from "./plan";
import { scoreCandidate } from "./scoring";
import MISSION_CONTROL_HTML from "./ui.html";
import type { ArtifactsPushEvent, Env } from "./types";

import { Swarm } from "./swarm";

export { SwarmCoordinatorDO } from "./coordinator";

const DEFAULT_BASELINE = "core-platform";
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const SYMBOL_ID = /^[^#\s]+#[^#\s]+$/;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

/**
 * Dashboard state fans out to every shard (64 DO calls). Serve it stale-while-revalidate from
 * isolate memory: polls return the last snapshot instantly and at most one refresh per baseline
 * runs in the background. Snapshots are at most a few seconds old.
 */
const STATE_FRESH_MS = 1500;
const STATE_MAX_STALE_MS = 20_000;
const stateCache = new Map<string, { at: number; body: string; refreshing?: Promise<void> }>();

async function cachedState(env: Env, baseline: string, ctx: ExecutionContext, force: boolean): Promise<Response> {
  const refresh = async () => {
    const t0 = Date.now();
    const body = JSON.stringify({ ...(await new Swarm(env, baseline).state()), generatedAt: Date.now(), buildMs: Date.now() - t0 });
    stateCache.set(baseline, { at: Date.now(), body });
  };
  const hit = stateCache.get(baseline);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (!hit || force || age > STATE_MAX_STALE_MS) {
    await refresh();
  } else if (age > STATE_FRESH_MS && !hit.refreshing) {
    hit.refreshing = refresh().finally(() => {
      const cur = stateCache.get(baseline);
      if (cur) delete cur.refreshing;
    });
    ctx.waitUntil(hit.refreshing);
  }
  const body = stateCache.get(baseline)!.body;
  return new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function coordinator(env: Env, baselineRepo: string) {
  return new Swarm(env, baselineRepo);
}

function errCode(e: unknown): string | null {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : null;
}

const TRANSIENT = new Set(["INTERNAL_ERROR", "FORK_IN_PROGRESS", "CREATE_IN_PROGRESS", "UPSTREAM_UNAVAILABLE"]);

/** Retry transient Artifacts errors with jittered exponential backoff (~0.2s, 0.4s, 0.8s, 1.6s). */
async function withRetry<T>(fn: (attempt: number) => Promise<T>, attempts = 5, extra: string[] = []): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn(i);
    } catch (e) {
      const code = errCode(e) ?? "";
      if (i >= attempts - 1 || !(TRANSIENT.has(code) || extra.includes(code))) throw e;
      await new Promise((r) => setTimeout(r, 200 * 2 ** i * (0.5 + Math.random())));
    }
  }
}

function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "code" in e) return `${(e as { code: string }).code}: ${(e as unknown as Error).message}`;
  return e instanceof Error ? e.message : String(e);
}

function requireAuth(request: Request, env: Env) {
  const key = env.AETHER_API_KEY;
  if (!key) throw new HttpError(503, "AETHER_API_KEY is not configured; refusing to serve mutating routes");
  const got = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = new TextEncoder().encode(got);
  const b = new TextEncoder().encode(key);
  if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b)) throw new HttpError(401, "missing or invalid bearer token");
}

async function body<T>(request: Request): Promise<Partial<T>> {
  try {
    return ((await request.json()) ?? {}) as Partial<T>;
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
}

/** Shared by the push-receipt route and the event-subscription queue consumer. */
async function processPush(env: Env, forkRepo: string, claimedSha?: string) {
  // Leases live in the coordinator for their baseline; the fork name doesn't tell us which,
  // so the fork's own metadata (`source`) does.
  using fork = await env.ARTIFACTS.get(forkRepo);
  const info = await fork.info();
  const baselineRepo = info.source?.split("/").pop() ?? DEFAULT_BASELINE;
  const coord = coordinator(env, baselineRepo);
  const lease = await coord.getLease(forkRepo);
  if (!lease) throw new HttpError(404, `no lease for ${forkRepo}`);

  // Never trust the reported sha: read the fork's actual branch tip.
  const tip = (await fork.log({ ref: info.defaultBranch, limit: 1 }))[0]?.hash;
  if (!tip) throw new HttpError(409, `${forkRepo} has no commits on ${info.defaultBranch}`);
  if (claimedSha && claimedSha !== tip) throw new HttpError(409, `reported ${claimedSha.slice(0, 8)} but ${info.defaultBranch} is at ${tip.slice(0, 8)}`);
  if (tip === lease.baseSha) throw new HttpError(409, `${forkRepo} has not moved past its base commit`);
  if (tip === lease.latestCommit) return { lease, duplicate: true };

  const analysis = await analyzePush(fork, lease, tip);
  const score = scoreCandidate(analysis, lease);
  return { lease: await coord.recordPush(forkRepo, analysis, score), duplicate: false };
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (method === "GET" && pathname === "/") {
    return new Response(MISSION_CONTROL_HTML, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" } });
  }

  // Read-only state for the dashboard. Contains no tokens.
  if (method === "GET" && (pathname === "/api/state" || pathname === "/api/swarm/state")) {
    const baseline = url.searchParams.get("baseline") || DEFAULT_BASELINE;
    return cachedState(env, baseline, ctx, url.searchParams.has("fresh"));
  }

  if (!pathname.startsWith("/api/")) throw new HttpError(404, "not found");
  requireAuth(request, env);

  if (method === "GET" && pathname === "/api/repos") {
    const page = await env.ARTIFACTS.list({ limit: 200, cursor: url.searchParams.get("cursor") ?? undefined });
    return json({ repos: page.repos, total: page.total, cursor: page.cursor ?? null });
  }

  if (method === "POST" && pathname === "/api/repos/init-baseline") {
    const b = await body<{ name: string; importUrl: string; branch: string }>(request);
    const name = b.name || DEFAULT_BASELINE;
    if (!REPO_NAME.test(name)) throw new HttpError(400, "invalid repo name");
    const existing = await env.ARTIFACTS.get(name).catch(() => null);
    if (existing) {
      using repo = existing;
      const info = await repo.info();
      const token = await repo.createToken("write", 3600);
      return json({ name, remote: info.remote, defaultBranch: info.defaultBranch, token: token.plaintext, existed: true });
    }
    const created = b.importUrl
      ? await env.ARTIFACTS.import({ source: { url: b.importUrl, branch: b.branch }, target: { name, opts: { description: "AetherGit baseline" } } })
      : await env.ARTIFACTS.create(name, { description: "AetherGit baseline", setDefaultBranch: "main" });
    await coordinator(env, name).logEvent("baseline.created", name, b.importUrl ? `imported from ${b.importUrl}` : "created empty");
    return json({ name: created.name, remote: created.remote, defaultBranch: created.defaultBranch, token: created.token }, 201);
  }

  if (method === "POST" && pathname === "/api/leases/claim") {
    const b = await body<{ agentId: string; taskIntent: string; symbols: string[]; baselineRepo: string; ttlSeconds: number }>(request);
    const agentId = (b.agentId ?? "").trim();
    const baselineRepo = b.baselineRepo || DEFAULT_BASELINE;
    const symbols = Array.isArray(b.symbols) ? b.symbols.map(String) : [];
    const ttlSeconds = Math.min(Math.max(Number(b.ttlSeconds) || 3600, 60), 86400);
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(agentId)) throw new HttpError(400, "agentId must be 1-40 chars of [A-Za-z0-9._-]");
    if (!symbols.length || symbols.length > 50 || !symbols.every((s) => SYMBOL_ID.test(s)))
      throw new HttpError(400, "symbols must be 1-50 ids of the form path/to/file.ts#symbol (use file#* for a whole file)");
    if (!b.taskIntent) throw new HttpError(400, "taskIntent is required");

    using baseline = await env.ARTIFACTS.get(baselineRepo);
    const info = await baseline.info();
    const baseSha = (await baseline.log({ ref: info.defaultBranch, limit: 1 }))[0]?.hash;
    if (!baseSha) throw new HttpError(409, `baseline ${baselineRepo} has no commits yet; push an initial commit first`);

    // Provision a fork that is actually readable before recording any lease. Under load,
    // fork() can transiently fail, or report success for a repo that never materialises; in
    // the latter case the name is abandoned and a fresh one is tried.
    let forkRepo = "";
    let remote = "";
    let token: ArtifactsCreateTokenResult | null = null;
    for (let attempt = 0; attempt < 3 && !token; attempt++) {
      forkRepo = `${agentId}-${crypto.randomUUID().slice(0, 8)}`.slice(0, 63);
      const name = forkRepo;
      try {
        const forked = await withRetry(async (i) => {
          try {
            return await baseline.fork(name, { description: `${agentId}: ${b.taskIntent}`.slice(0, 200), defaultBranchOnly: true });
          } catch (e) {
            if (i > 0 && errCode(e) === "ALREADY_EXISTS") return null; // an earlier "failed" attempt created it
            throw e;
          }
        });
        using fork = await withRetry(() => env.ARTIFACTS.get(name), 6, ["NOT_FOUND"]);
        remote = forked?.remote ?? (await fork.info()).remote;
        token = await withRetry(() => fork.createToken("write", ttlSeconds));
      } catch (e) {
        if (errCode(e) !== "NOT_FOUND" || attempt === 2) throw e;
        await env.ARTIFACTS.delete(name).catch(() => {});
      }
    }
    if (!token) throw new HttpError(502, "could not provision a fork");

    try {
      const { lease, rivals } = await coordinator(env, baselineRepo).claim({
        forkRepo,
        agentId,
        baselineRepo,
        baseSha,
        remote,
        taskIntent: String(b.taskIntent).slice(0, 500),
        symbols,
        ttlSeconds,
      });
      const agentsMd = await baseline.readFile({ ref: baseSha, path: "AGENTS.md" });
      return json(
        {
          lease,
          rivals,
          git: { remote, branch: info.defaultBranch, token: token.plaintext, expiresAt: token.expiresAt },
          instructions: agentsMd ? await agentsMd.text() : null,
        },
        201
      );
    } catch (e) {
      // Don't leave an orphaned fork behind if the lease step failed.
      await env.ARTIFACTS.delete(forkRepo).catch(() => {});
      await coordinator(env, baselineRepo).release(forkRepo, "released");
      throw e;
    }
  }

  // Coordination-plane load test: claim leases for up to 500 agents per request WITHOUT creating
  // Artifacts forks (forking is bounded by the Artifacts namespace rate limit, see README).
  if (method === "POST" && pathname === "/api/leases/claim-batch") {
    const b = await body<{ baselineRepo: string; forkless: boolean; agents: Array<{ agentId: string; symbols: string[]; taskIntent?: string }> }>(request);
    if (b.forkless !== true) throw new HttpError(400, "claim-batch only supports forkless: true (load testing the lease plane)");
    const baselineRepo = b.baselineRepo || "scale-test";
    const agents = Array.isArray(b.agents) ? b.agents.slice(0, 500) : [];
    for (const a of agents) {
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(a.agentId ?? "") || !Array.isArray(a.symbols) || !a.symbols.length || a.symbols.length > 50 || !a.symbols.every((s) => SYMBOL_ID.test(s)))
        throw new HttpError(400, `invalid agent ${a.agentId}`);
    }
    const t0 = Date.now();
    const results = await coordinator(env, baselineRepo).claimMany(
      agents.map((a) => ({
        forkRepo: `${a.agentId}-${crypto.randomUUID().slice(0, 8)}`.slice(0, 63),
        agentId: a.agentId,
        baselineRepo,
        baseSha: "forkless",
        remote: "",
        taskIntent: String(a.taskIntent ?? "load test").slice(0, 200),
        symbols: a.symbols,
        ttlSeconds: 3600,
      })),
      true
    );
    const modes: Record<string, number> = {};
    for (const r of results) modes[r.mode] = (modes[r.mode] ?? 0) + 1;
    return json({ claimed: results.length, modes, ms: Date.now() - t0 });
  }

  if (method === "POST" && pathname === "/api/push") {
    const b = await body<{ forkRepo: string; commitSha: string }>(request);
    if (!b.forkRepo || !REPO_NAME.test(b.forkRepo)) throw new HttpError(400, "forkRepo is required");
    const result = await processPush(env, b.forkRepo, b.commitSha);
    return json(result);
  }

  if (method === "POST" && pathname === "/api/leases/release") {
    const b = await body<{ forkRepo: string; baselineRepo: string }>(request);
    if (!b.forkRepo) throw new HttpError(400, "forkRepo is required");
    await coordinator(env, b.baselineRepo || DEFAULT_BASELINE).release(b.forkRepo);
    return json({ released: b.forkRepo });
  }

  if (method === "POST" && pathname === "/api/weave/plan") {
    const b = await body<{ baselineRepo: string; maxCandidates: number }>(request);
    const baselineRepo = b.baselineRepo || DEFAULT_BASELINE;
    const candidates = await coordinator(env, baselineRepo).candidates(Math.min(Number(b.maxCandidates) || 150, 500));
    const plan = await buildWeavePlan(env, baselineRepo, candidates);
    using baseline = await env.ARTIFACTS.get(baselineRepo);
    const token = plan.merged.length ? await baseline.createToken("write", 600) : null;
    const remote = (await baseline.info()).remote;
    return json({ plan, git: token ? { remote, branch: plan.defaultBranch, token: token.plaintext } : null });
  }

  if (method === "POST" && pathname === "/api/weave/complete") {
    const b = await body<{
      baselineRepo: string;
      baselineSha: string;
      resultSha: string;
      merged: string[];
      lost: Array<{ forkRepo: string; reason: string }>;
      rejected: Array<{ forkRepo: string; reason: string }>;
    }>(request);
    const baselineRepo = b.baselineRepo || DEFAULT_BASELINE;
    if (!b.resultSha || !b.baselineSha || !Array.isArray(b.merged)) throw new HttpError(400, "baselineSha, resultSha and merged[] are required");
    using baseline = await env.ARTIFACTS.get(baselineRepo);
    const info = await baseline.info();
    const tip = (await baseline.log({ ref: info.defaultBranch, limit: 2 })).map((c) => c.hash);
    if (tip[0] !== b.resultSha) throw new HttpError(409, `baseline tip is ${tip[0]?.slice(0, 8)}, not ${b.resultSha.slice(0, 8)}`);
    await coordinator(env, baselineRepo).completeWeave({
      baselineSha: b.baselineSha,
      resultSha: b.resultSha,
      merged: b.merged,
      lost: b.lost ?? [],
      rejected: b.rejected ?? [],
    });
    return json({ ok: true });
  }

  if (method === "POST" && pathname === "/api/reset") {
    const b = await body<{ baselineRepo: string }>(request);
    await coordinator(env, b.baselineRepo || DEFAULT_BASELINE).reset();
    return json({ ok: true });
  }

  throw new HttpError(404, "not found");
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      const code = e && typeof e === "object" && "code" in e ? (e as { code: string }).code : null;
      const status = code === "NOT_FOUND" ? 404 : code === "ALREADY_EXISTS" ? 409 : code?.startsWith("INVALID") ? 400 : 502;
      return json({ error: errMessage(e) }, status);
    }
  },

  /** Consumer for Artifacts `pushed` event subscriptions. */
  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      const event = message.body;
      if (event.type !== "cf.artifacts.repo.pushed") {
        message.ack();
        continue;
      }
      const repo = event.source.repoName;
      try {
        await processPush(env, repo, event.payload.after);
        message.ack();
      } catch (e) {
        if (e instanceof HttpError && (e.status === 404 || e.status === 409)) {
          // Not a leased fork (e.g. the baseline itself after a weave) or a superseded push: record and drop.
          await coordinator(env, DEFAULT_BASELINE).logEvent("push.observed", repo, `${event.payload.after?.slice(0, 8) ?? "?"}: ${e.message}`);
          message.ack();
        } else {
          message.retry({ delaySeconds: 5 });
        }
      }
    }
  },
} satisfies ExportedHandler<Env, ArtifactsPushEvent>;
