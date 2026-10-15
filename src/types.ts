export type LeaseMode = "AST_LOCK" | "ORTHOGONAL_SHARED_FILE" | "TOURNAMENT";
export type LeaseStatus = "active" | "pushed" | "merged" | "lost" | "rejected" | "expired" | "released";

export interface Lease {
  forkRepo: string;
  agentId: string;
  baselineRepo: string;
  baseSha: string;
  remote: string;
  taskIntent: string;
  symbols: string[];
  mode: LeaseMode;
  status: LeaseStatus;
  createdAt: number;
  expiresAt: number;
  latestCommit: string | null;
  score: number | null;
  analysis: PushAnalysis | null;
}

export interface ProvenanceManifest {
  agentId?: string;
  promptIntent?: string;
  symbolsModified?: string[];
  verification?: Record<string, string | number | boolean | null>;
}

/** Everything the control plane derives *itself* from a pushed commit. Nothing here is agent-reported except `provenance`. */
export interface PushAnalysis {
  commitSha: string;
  message: string;
  changedFiles: string[];
  /** `path#unit` ids whose content actually changed vs the fork's base commit. */
  touchedSymbols: string[];
  /** Touched symbols not covered by any lease the agent holds. */
  violations: string[];
  /** Non-parseable files changed (outside the semantic layer — always counted as violations of an AST lease). */
  opaqueFiles: string[];
  syntaxErrors: number;
  linesChanged: number;
  provenance: ProvenanceManifest | null;
  /** Did the provenance manifest's declared symbols match what actually changed? */
  provenanceHonest: boolean | null;
}

export interface SwarmEvent {
  id: number;
  ts: number;
  type: string;
  repo: string;
  detail: string;
}

export interface ArtifactsPushEvent {
  type: string;
  source: { type?: string; namespace: string; repoName: string };
  payload: { ref?: string; before?: string; after?: string };
}

export interface Env {
  ARTIFACTS: Artifacts;
  SWARM_COORDINATOR: DurableObjectNamespace<import("./coordinator").SwarmCoordinatorDO>;
  /** Bearer token required on mutating /api routes. */
  AETHER_API_KEY?: string;
  ARTIFACTS_NAMESPACE?: string;
  /** Optional: lets the Worker create per-fork `pushed` event subscriptions via the REST API. */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  SYMBOL_SHARDS?: string;
  LEASE_SHARDS?: string;
}
