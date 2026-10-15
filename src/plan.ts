import { isParseable } from "./symbols";
import type { Env, Lease } from "./types";
import { weaveFile } from "./weave";
import { PROVENANCE_PATH } from "./analyze";

export interface WeavePlan {
  baselineRepo: string;
  defaultBranch: string;
  headSha: string | null;
  /** path → new contents, or null to delete. */
  files: Record<string, string | null>;
  merged: Array<{ forkRepo: string; agentId: string; score: number | null; commitSha: string; symbols: string[]; intent: string }>;
  lost: Array<{ forkRepo: string; reason: string }>;
  rejected: Array<{ forkRepo: string; reason: string }>;
}

async function readText(repo: ArtifactsRepo, ref: string | null, path: string): Promise<string | null> {
  if (!ref) return null;
  const b = await repo.readFile({ ref, path });
  return b ? b.text() : null;
}

/**
 * Pick tournament winners and weave every surviving fork onto the current baseline tip.
 *
 * 1. Reject candidates that broke their lease or the parser.
 * 2. Walk the rest best-score-first; a candidate whose touched symbols overlap an already
 *    accepted one loses its tournament (all-or-nothing per agent — no half-applied changes).
 * 3. Weave winners one at a time onto the evolving result, three-way at symbol granularity,
 *    each against its own fork base. A candidate that can't apply cleanly is rejected as stale
 *    and its partial edits are discarded.
 */
export async function buildWeavePlan(env: Env, baselineRepo: string, candidates: Lease[]): Promise<WeavePlan> {
  using baseline = await env.ARTIFACTS.get(baselineRepo);
  const info = await baseline.info();
  const headSha = (await baseline.log({ ref: info.defaultBranch, limit: 1 }))[0]?.hash ?? null;

  const plan: WeavePlan = { baselineRepo, defaultBranch: info.defaultBranch, headSha, files: {}, merged: [], lost: [], rejected: [] };
  const owners = new Map<string, string>(); // touched symbol → winning fork

  for (const c of candidates) {
    const a = c.analysis;
    if (!a || !c.latestCommit) continue;
    if (a.violations.length) {
      plan.rejected.push({ forkRepo: c.forkRepo, reason: `lease violation: ${a.violations.join(", ")}` });
      continue;
    }
    if (a.provenanceHonest === false) {
      const declared = a.provenance?.symbolsModified?.join(", ") || "nothing";
      plan.rejected.push({ forkRepo: c.forkRepo, reason: `provenance mismatch: declared ${declared}, actually touched ${a.touchedSymbols.join(", ")}` });
      continue;
    }
    if (a.syntaxErrors) {
      plan.rejected.push({ forkRepo: c.forkRepo, reason: `introduced ${a.syntaxErrors} syntax error(s)` });
      continue;
    }
    const clash = a.touchedSymbols.find((s) => owners.has(s));
    if (clash) {
      plan.lost.push({ forkRepo: c.forkRepo, reason: `lost ${clash} to ${owners.get(clash)}` });
      continue;
    }

    using fork = await env.ARTIFACTS.get(c.forkRepo);
    const staged: Record<string, string | null> = {};
    let failure: string | null = null;
    let superseded = false;

    for (const path of a.changedFiles) {
      if (path === PROVENANCE_PATH) continue;
      const [base, next] = await Promise.all([readText(fork, c.baseSha, path), readText(fork, c.latestCommit, path)]);
      const head = path in plan.files ? plan.files[path] : await readText(baseline, headSha, path);

      if (base === null) {
        // New file.
        if (head !== null && head !== next) failure = `${path} was created upstream concurrently`;
        else staged[path] = next;
      } else if (next === null) {
        // Deleted file.
        if (head !== null && head !== base) failure = `${path} changed upstream; refusing to delete`;
        else staged[path] = null;
      } else if (head === null) {
        failure = `${path} was deleted upstream`;
      } else if (!isParseable(path)) {
        // Opaque files only merge if untouched upstream (lease must have been path#*).
        if (head !== base) failure = `${path} changed upstream (not AST-mergeable)`;
        else staged[path] = next;
      } else {
        const r = weaveFile(path, base, head, [{ id: c.forkRepo, source: next }]);
        if (r.conflicts.length) {
          failure = r.conflicts.map((x) => `${path}#${x.unit}: ${x.reason}`).join("; ");
          // Every conflict is "baseline already changed this symbol since you forked": an earlier
          // weave took the symbol, so this agent lost its tournament rather than misbehaving.
          superseded = r.conflicts.every((x) => x.reason === "stale_baseline");
        }
        else staged[path] = r.merged;
      }
      if (failure) break;
    }

    if (failure) {
      if (superseded) plan.lost.push({ forkRepo: c.forkRepo, reason: `superseded by an earlier weave (${failure})` });
      else plan.rejected.push({ forkRepo: c.forkRepo, reason: failure });
      continue;
    }
    Object.assign(plan.files, staged);
    for (const s of a.touchedSymbols) owners.set(s, c.forkRepo);
    plan.merged.push({
      forkRepo: c.forkRepo,
      agentId: c.agentId,
      score: c.score,
      commitSha: c.latestCommit,
      symbols: a.touchedSymbols,
      intent: a.provenance?.promptIntent ?? c.taskIntent,
    });
  }

  return plan;
}
