import type { Lease, PushAnalysis } from "./types";

/**
 * Tournament score for one pushed candidate. Higher wins.
 *
 * When several agents race on the same symbol, the weave keeps the highest-scoring candidate
 * and marks the rest as `lost`. Every input below is computed by the control plane from the
 * pushed git objects — none of it is self-reported by the agent (provenance is only compared
 * against what we observed).
 *
 * Available signals:
 *   a.violations.length   edits outside the agent's leased symbols (hard rejects happen in plan.ts,
 *                         but you may still want them to tank the score for the dashboard)
 *   a.syntaxErrors        new parse errors introduced by the push
 *   a.linesChanged        diff footprint (smaller = more surgical)
 *   a.touchedSymbols      how many AST units actually changed
 *   a.provenanceHonest    true / false / null (no manifest or no symbolsModified)
 *   lease.createdAt       when the agent claimed the lease (earlier = got there first)
 *
 * Return a number in roughly 0..100.
 */
export function scoreCandidate(a: PushAnalysis, _lease: Lease): number {
  // Policy: "cleanest honest change wins".
  //  - Broken code or lease violations can't win (they are also hard-rejected in plan.ts).
  //  - Lying in the provenance manifest costs more than any diff size could.
  //  - Otherwise, the smaller, more surgical diff wins.
  // Push time is deliberately NOT a factor: rewarding speed would reward lock-grabbing.
  if (a.syntaxErrors > 0 || a.violations.length > 0) return 0;
  let score = 100;
  score -= Math.min(30, a.linesChanged * 0.5); // footprint: up to -30
  score -= Math.min(10, Math.max(0, a.touchedSymbols.length - 1) * 2); // spread across symbols: up to -10
  if (a.provenanceHonest === false) score -= 50; // misreported what it changed
  if (a.provenanceHonest === null) score -= 5; // no manifest / no symbolsModified
  return Math.max(0, Math.round(score * 10) / 10);
}
