// Shared helpers for AetherGit CLI scripts: control-plane API calls and token-authenticated git.
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const AETHER_URL = (process.env.AETHER_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
export const API_KEY = process.env.AETHER_API_KEY || "";
export const BASELINE = process.env.AETHER_BASELINE || "core-platform";

export async function api(path, body) {
  const res = await fetch(AETHER_URL + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${data.error ?? text}`);
  return data;
}

/** Run git with the Artifacts repo token as a Bearer header (keeps the secret out of remote URLs and .git/config). */
export async function git(args, { cwd, token } = {}) {
  const auth = token ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`] : [];
  const ident = ["-c", "user.name=AetherGit Agent", "-c", "user.email=agents@aethergit.dev", "-c", "core.autocrlf=false"];
  // Network operations retry: remote hiccups ("hung up unexpectedly", 503) and local resource
  // pressure are transient. Clone into a non-empty dir would fail on retry, so clean it first.
  const network = ["clone", "push", "fetch"].includes(args[0]);
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout } = await exec("git", [...auth, ...ident, ...args], { cwd, maxBuffer: 32 * 1024 * 1024 });
      return stdout.trim();
    } catch (e) {
      const msg = (e.stderr || e.message || "").replaceAll(token ?? "\0", "***");
      if (!network || attempt >= 3) throw new Error(`git ${args[0]} failed: ${msg.trim()}`);
      if (args[0] === "clone") await rm(args[args.length - 1], { recursive: true, force: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

export async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), `aether-${prefix}-`));
}

export async function writeText(root, path, text) {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, text);
}

export const readText = (root, path) => readFile(join(root, path), "utf8");
export const removeDir = (dir) => rm(dir, { recursive: true, force: true });

export const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
};

/**
 * Full agent lifecycle against a real Artifacts fork:
 * claim lease → clone fork → edit(dir) → write provenance → commit → push → push receipt.
 * `edit` returns { message, symbolsModified? } after mutating files in `dir`.
 */
export async function runAgent({ agentId, taskIntent, symbols, edit, log = console.log, keep = false, baseline = BASELINE }) {
  const claim = await api("/api/leases/claim", { agentId, taskIntent, symbols, baselineRepo: baseline });
  const { lease, git: g } = claim;
  log(`${c.cyan(agentId)} leased ${symbols.join(", ")} → ${modeLabel(lease.mode)} ${c.dim(lease.forkRepo)}`);

  const dir = await tempDir(agentId);
  try {
    await git(["clone", "--quiet", "--branch", g.branch, g.remote, dir], { token: g.token });
    const result = await edit(dir);
    const manifest = {
      agentId,
      promptIntent: taskIntent,
      // null = agent does not know exactly which units it touched (e.g. LLM agents); omit the claim.
      ...(result.symbolsModified === null ? {} : { symbolsModified: result.symbolsModified ?? symbols }),
      verification: result.verification ?? {},
    };
    await writeText(dir, ".aether/provenance.json", JSON.stringify(manifest, null, 2) + "\n");
    await git(["add", "-A"], { cwd: dir });
    await git(["commit", "--quiet", "-m", result.message], { cwd: dir });
    const sha = await git(["rev-parse", "HEAD"], { cwd: dir });
    await git(["push", "--quiet", "origin", `HEAD:${g.branch}`], { cwd: dir, token: g.token });
    const receipt = await api("/api/push", { forkRepo: lease.forkRepo, commitSha: sha });
    const a = receipt.lease.analysis;
    const verdict = a.violations.length
      ? c.red(`✗ LEASE VIOLATION ${a.violations.join(", ")}`)
      : a.provenanceHonest === false
        ? c.yellow("⚠ provenance did not match the diff")
        : c.green("✓ lease-compliant");
    log(`${c.cyan(agentId)} pushed ${sha.slice(0, 8)} · touched ${a.touchedSymbols.join(", ") || "(nothing)"} · ${verdict} · score ${c.bold(receipt.lease.score)}`);
    return receipt.lease;
  } finally {
    if (!keep) await removeDir(dir);
  }
}

export function modeLabel(mode) {
  return mode === "TOURNAMENT" ? c.magenta("TOURNAMENT") : mode === "ORTHOGONAL_SHARED_FILE" ? c.yellow("ORTHOGONAL") : c.green("AST_LOCK");
}

/** Replace exactly one occurrence of `from` in a file; throws if the anchor is missing (so scripted edits fail loudly). */
export async function patch(dir, path, from, to) {
  const text = await readText(dir, path);
  if (!text.includes(from)) throw new Error(`patch anchor not found in ${path}: ${from.slice(0, 60)}`);
  await writeText(dir, path, text.replace(from, to));
}
