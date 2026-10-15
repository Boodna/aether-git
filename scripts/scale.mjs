#!/usr/bin/env node
// Coordination-plane load test: N agents claim AST-symbol leases against the deployed, sharded
// Durable Objects. Forks are skipped (forkless batch claims) because fork throughput is bounded by
// the Artifacts namespace rate limit, not by AetherGit — see README "Scaling".
//
// Symbol popularity follows a Zipf distribution over a virtual codebase, so a handful of files and
// functions become genuine hotspots (tournaments) while the long tail stays uncontested.
//
//   AGENTS=100000 node scripts/scale.mjs
import { api, c } from "./lib.mjs";

const AGENTS = Number(process.env.AGENTS || 100_000);
const FILES = Number(process.env.FILES || 20_000);
const SYMBOLS_PER_FILE = Number(process.env.SYMBOLS_PER_FILE || 24);
const BATCH = Number(process.env.BATCH || 500);
const CONCURRENCY = Number(process.env.CONCURRENCY || 24);
const BASELINE = process.env.SCALE_BASELINE || "scale-test";
const ZIPF_S = Number(process.env.ZIPF_S || 1.05);

// Seeded PRNG so runs are reproducible.
let seed = 0x9e3779b9;
const rand = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32);

function zipfSampler(n, s) {
  const cdf = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) cdf[i] = acc += 1 / Math.pow(i + 1, s);
  return () => {
    const x = rand() * acc;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

const pickFile = zipfSampler(FILES, ZIPF_S);
const pickSymbol = zipfSampler(SYMBOLS_PER_FILE, 0.8);
const dirs = ["api", "auth", "billing", "core", "data", "edge", "jobs", "ml", "search", "ui"];
const fileName = (i) => `src/${dirs[i % dirs.length]}/module_${i}.ts`;
const symbolName = (j) => (j < 4 ? `Service.method${j}` : `fn${j}`);

function agent(i) {
  const file = pickFile();
  const n = rand() < 0.8 ? 1 : rand() < 0.75 ? 2 : 3;
  const symbols = new Set();
  while (symbols.size < n) symbols.add(`${fileName(file)}#${symbolName(pickSymbol())}`);
  return { agentId: `a${i}`, symbols: [...symbols], taskIntent: "scale test" };
}

console.log(c.bold(`\nAetherGit coordination-plane load test`));
console.log(c.dim(`${AGENTS.toLocaleString()} agents · ${FILES.toLocaleString()} files × ${SYMBOLS_PER_FILE} symbols · Zipf s=${ZIPF_S} · batches of ${BATCH} · ${CONCURRENCY} in flight\n`));

await api("/api/reset", { baselineRepo: BASELINE });

const batches = [];
for (let i = 0; i < AGENTS; i += BATCH) batches.push(Array.from({ length: Math.min(BATCH, AGENTS - i) }, (_, k) => agent(i + k)));

const modes = {};
const latencies = [];
let done = 0;
let next = 0;
const t0 = performance.now();
let lastPrint = 0;

async function worker() {
  while (next < batches.length) {
    const b = batches[next++];
    const s = performance.now();
    let r;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await api("/api/leases/claim-batch", { baselineRepo: BASELINE, forkless: true, agents: b });
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
      }
    }
    latencies.push(performance.now() - s);
    for (const [m, n] of Object.entries(r.modes)) modes[m] = (modes[m] ?? 0) + n;
    done += r.claimed;
    const now = performance.now();
    if (now - lastPrint > 1000) {
      lastPrint = now;
      process.stdout.write(`\r  ${done.toLocaleString().padStart(9)} / ${AGENTS.toLocaleString()} leases · ${Math.round(done / ((now - t0) / 1000)).toLocaleString()} claims/s   `);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const secs = (performance.now() - t0) / 1000;
latencies.sort((a, b) => a - b);
const pct = (p) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]);

const state = await api(`/api/state?baseline=${encodeURIComponent(BASELINE)}`);
Object.assign(modes, state.modes); // final modes, after later claims escalated earlier ones
console.log(`\r${" ".repeat(70)}\r`);
console.log(`  ${c.bold(done.toLocaleString())} agents claimed leases in ${c.bold(secs.toFixed(1) + "s")} → ${c.green(Math.round(done / secs).toLocaleString() + " claims/s")}`);
console.log(`  batch latency p50 ${pct(0.5)} ms · p99 ${pct(0.99)} ms  (${BATCH} agents per request)`);
console.log(`  shards: ${state.shards.symbol} symbol + ${state.shards.lease} lease Durable Objects\n`);
console.log(`  ${c.green("AST_LOCK")}        ${String(modes.AST_LOCK ?? 0).padStart(8)}  sole owner of every symbol it touches`);
console.log(`  ${c.yellow("ORTHOGONAL")}      ${String(modes.ORTHOGONAL_SHARED_FILE ?? 0).padStart(8)}  shares a file, not a symbol → auto-woven`);
console.log(`  ${c.magenta("TOURNAMENT")}      ${String(modes.TOURNAMENT ?? 0).padStart(8)}  races other agents on the same symbol\n`);
console.log(`  live symbols ${state.symbols.live.toLocaleString()} across ${state.symbols.files.toLocaleString()} files · ${state.symbols.contested.toLocaleString()} contested`);
console.log(`  hottest symbols:`);
for (const h of state.symbols.hot.slice(0, 5)) console.log(`    ${String(h.n).padStart(6)} agents  ${h.file}#${h.symbol}`);
console.log(c.dim(`\n  Dashboard: ${process.env.AETHER_URL}/?baseline=${BASELINE}\n`));
