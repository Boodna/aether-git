#!/usr/bin/env node
// Full-path scale run: N agents, each with a REAL Artifacts fork, git clone, commit, push,
// server-side AST analysis — then `npm run weave` merges the survivors.
//
// A generated codebase (FILES × FUNCS functions) is pushed to its own baseline. Agents pick
// functions with a Zipf skew, so popular functions turn into tournaments. Each agent tunes its
// function by inserting 1-3 lines; the tournament keeps the smallest clean change.
//
//   AGENTS=1000 AETHER_BASELINE=scale-real node scripts/real-scale.mjs
import { api, c, git, removeDir, runAgent, tempDir, writeText, readText } from "./lib.mjs";

const AGENTS = Number(process.env.AGENTS || 1000);
const FILES = Number(process.env.FILES || 60);
const FUNCS = Number(process.env.FUNCS || 12);
const CONCURRENCY = Number(process.env.CONCURRENCY || 40);
const BASELINE = process.env.AETHER_BASELINE || "scale-real";

let seed = 0x1234567;
const rand = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32);
function zipf(n, s) {
  const cdf = [];
  let acc = 0;
  for (let i = 0; i < n; i++) cdf.push((acc += 1 / Math.pow(i + 1, s)));
  return () => {
    const x = rand() * acc;
    return cdf.findIndex((v) => v >= x);
  };
}
const pickFile = zipf(FILES, 0.9);
const pickFunc = zipf(FUNCS, 0.6);

const filePath = (f) => `src/mod${String(f).padStart(3, "0")}.ts`;
const fnName = (k) => `compute${k}`;
function generateFile(f) {
  const fns = Array.from(
    { length: FUNCS },
    (_, k) => `export function ${fnName(k)}(input: number): number {\n  const base = input * ${k + 1};\n  return base + ${f};\n}\n`
  );
  return `// Generated module ${f}\n\n${fns.join("\n")}`;
}

// 1. Baseline with the generated codebase (created once; reused afterwards).
const repo = await api("/api/repos/init-baseline", { name: BASELINE });
{
  const dir = await tempDir("gen");
  try {
    await git(["clone", "--quiet", repo.remote, dir], { token: repo.token });
    const hasCommits = await git(["rev-parse", "--verify", "-q", "HEAD"], { cwd: dir }).then(() => true, () => false);
    if (!hasCommits || process.argv.includes("--reseed")) {
      if (!hasCommits) await git(["checkout", "--quiet", "-b", repo.defaultBranch], { cwd: dir });
      for (let f = 0; f < FILES; f++) await writeText(dir, filePath(f), generateFile(f));
      await git(["add", "-A"], { cwd: dir });
      await git(["commit", "--quiet", "--allow-empty", "-m", `Generate ${FILES} modules × ${FUNCS} functions`], { cwd: dir });
      await git(["push", "--quiet", "--force", "origin", `HEAD:${repo.defaultBranch}`], { cwd: dir, token: repo.token });
      console.log(c.green(`Seeded ${BASELINE} with ${FILES * FUNCS} functions`));
    }
  } finally {
    await removeDir(dir);
  }
}
await api("/api/reset", { baselineRepo: BASELINE });

// 2. Agents.
const agents = Array.from({ length: AGENTS }, (_, i) => {
  const f = pickFile();
  const k = pickFunc();
  const lines = 1 + Math.floor(rand() * 3);
  return { i, f, k, lines };
});

console.log(c.bold(`\n${AGENTS} real agents · ${CONCURRENCY} in flight · each: fork → clone → commit → push → AST analysis\n`));
const stats = { ok: 0, failed: 0, modes: {}, violations: 0, errors: {} };
const t0 = Date.now();
let next = 0;
let lastPrint = 0;

async function worker() {
  while (next < agents.length) {
    const a = agents[next++];
    const path = filePath(a.f);
    const fn = fnName(a.k);
    try {
      const lease = await runAgent({
        baseline: BASELINE,
        agentId: `agent-${a.i}`,
        taskIntent: `Tune ${fn} in ${path}`,
        symbols: [`${path}#${fn}`],
        log: () => {},
        edit: async (dir) => {
          const text = await readText(dir, path);
          const anchor = `export function ${fn}(input: number): number {\n`;
          const extra = Array.from({ length: a.lines }, (_, j) => `  const tune${a.i}_${j} = ${j + 1};\n`).join("");
          await writeText(dir, path, text.replace(anchor, anchor + extra));
          return { message: `agent-${a.i}: tune ${fn}` };
        },
      });
      stats.ok++;
      stats.modes[lease.mode] = (stats.modes[lease.mode] ?? 0) + 1;
      if (lease.analysis?.violations?.length) stats.violations++;
    } catch (e) {
      stats.failed++;
      const key = String(e.message).replace(/agent-\d+[-\w]*/g, "agent").slice(0, 90);
      stats.errors[key] = (stats.errors[key] ?? 0) + 1;
    }
    const now = Date.now();
    if (now - lastPrint > 1000) {
      lastPrint = now;
      const done = stats.ok + stats.failed;
      process.stdout.write(`\r  ${String(done).padStart(5)} / ${AGENTS} agents done · ${(done / ((now - t0) / 1000)).toFixed(1)} agents/s · ${stats.failed} failed   `);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const secs = (Date.now() - t0) / 1000;

console.log(`\r${" ".repeat(80)}\r`);
console.log(`  ${c.bold(stats.ok)} agents forked, pushed and were analysed in ${c.bold(secs.toFixed(1) + "s")} (${(stats.ok / secs).toFixed(1)} agents/s end to end)`);
console.log(`  modes at claim time: ${Object.entries(stats.modes).map(([m, n]) => `${m} ${n}`).join(" · ")}`);
if (stats.failed) {
  console.log(c.red(`  ${stats.failed} failed:`));
  for (const [k, n] of Object.entries(stats.errors)) console.log(c.dim(`    ${n}× ${k}`));
}
console.log(c.dim(`\n  Next: AETHER_BASELINE=${BASELINE} npm run weave -- --quiet\n`));
