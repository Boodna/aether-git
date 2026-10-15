import { claimCovers, diffUnits, isParseable, parseFile, splitSymbolId } from "./symbols";
import type { Lease, ProvenanceManifest, PushAnalysis } from "./types";

export const PROVENANCE_PATH = ".aether/provenance.json";
const MAX_CHANGED_FILES = 200;

/**
 * Recursively diff two git trees by object hash. Identical subtree hashes are skipped without
 * being read, so cost scales with the size of the change, not the size of the repo.
 */
export async function diffTrees(repo: ArtifactsRepo, a: string | null, b: string | null, prefix = "", out: string[] = []): Promise<string[]> {
  if (a === b || out.length >= MAX_CHANGED_FILES) return out;
  const [ea, eb] = await Promise.all([a ? repo.readTree(a) : [], b ? repo.readTree(b) : []]);
  const ma = new Map((ea ?? []).map((e) => [e.name, e]));
  const mb = new Map((eb ?? []).map((e) => [e.name, e]));
  const names = new Set([...ma.keys(), ...mb.keys()]);
  const subdirs: Promise<string[]>[] = [];
  for (const name of names) {
    const x = ma.get(name);
    const y = mb.get(name);
    if (x?.hash === y?.hash) continue;
    const path = prefix + name;
    const xTree = x?.type === "tree";
    const yTree = y?.type === "tree";
    if (xTree || yTree) {
      subdirs.push(diffTrees(repo, xTree ? x!.hash : null, yTree ? y!.hash : null, path + "/", out));
      if (x && !xTree) out.push(path);
      if (y && !yTree) out.push(path);
    } else {
      out.push(path);
    }
  }
  await Promise.all(subdirs);
  return out;
}

async function readText(repo: ArtifactsRepo, ref: string, path: string): Promise<string | null> {
  const blob = await repo.readFile({ ref, path });
  return blob ? blob.text() : null;
}

function changedLines(a: string, b: string): number {
  const la = a.split("\n");
  const lb = b.split("\n");
  const sa = new Set(la);
  const sb = new Set(lb);
  return la.filter((l) => !sb.has(l)).length + lb.filter((l) => !sa.has(l)).length;
}

/**
 * Derive what a push *actually* did, independent of anything the agent claims:
 * which files changed, which AST units changed, whether those were covered by its leases,
 * whether the result still parses, and whether its provenance manifest told the truth.
 */
export async function analyzePush(fork: ArtifactsRepo, lease: Lease, commitSha: string): Promise<PushAnalysis> {
  const [commit, base] = await Promise.all([fork.readCommit(commitSha), fork.readCommit(lease.baseSha)]);
  if (!commit) throw new Error(`commit ${commitSha} not found in ${lease.forkRepo}`);
  if (!base) throw new Error(`base ${lease.baseSha} not found in ${lease.forkRepo}`);

  const changed = (await diffTrees(fork, base.treeHash, commit.treeHash)).sort();
  const codeFiles = changed.filter((p) => p !== PROVENANCE_PATH);

  const claims = lease.symbols.map(splitSymbolId);
  const covered = (file: string, unit: string) => claims.some((c) => c.file === file && claimCovers(c.symbol, unit));

  const touched: string[] = [];
  const violations: string[] = [];
  const opaque: string[] = [];
  let syntaxErrors = 0;
  let lines = 0;

  await Promise.all(
    codeFiles.map(async (path) => {
      if (!isParseable(path)) {
        opaque.push(path);
        if (!covered(path, "*")) violations.push(`${path}#*`);
        return;
      }
      const [before, after] = await Promise.all([readText(fork, lease.baseSha, path), readText(fork, commitSha, path)]);
      const pb = before === null ? null : parseFile(path, before);
      const pa = after === null ? null : parseFile(path, after);
      syntaxErrors += Math.max(0, (pa?.syntaxErrors ?? 0) - (pb?.syntaxErrors ?? 0));
      lines += changedLines(before ?? "", after ?? "");
      const d = diffUnits(pb, pa);
      const units = [...d.added, ...d.modified, ...d.removed];
      // Import-only edits ride along with whatever symbol needed them; they are not a violation.
      for (const u of units) {
        const id = `${path}#${u}`;
        touched.push(id);
        if (!covered(path, u)) violations.push(id);
      }
    })
  );

  let provenance: ProvenanceManifest | null = null;
  let provenanceHonest: boolean | null = null;
  try {
    const raw = await readText(fork, commitSha, PROVENANCE_PATH);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") provenance = parsed as ProvenanceManifest;
    }
  } catch {
    provenance = null;
  }
  if (provenance && Array.isArray(provenance.symbolsModified)) {
    const declared = new Set(provenance.symbolsModified.map(String));
    provenanceHonest = touched.every((t) => declared.has(t)) && [...declared].every((d) => touched.includes(d));
  }

  return {
    commitSha,
    message: commit.message,
    changedFiles: changed,
    touchedSymbols: touched.sort(),
    violations: violations.sort(),
    opaqueFiles: opaque.sort(),
    syntaxErrors,
    linesChanged: lines,
    provenance,
    provenanceHonest,
  };
}
