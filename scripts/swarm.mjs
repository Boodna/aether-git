#!/usr/bin/env node
// Launch a wave of concurrent scripted agents. Every agent gets its own Artifacts fork, makes a
// real commit and pushes it; the control plane analyses each push from the git objects.
import { c, patch, runAgent } from "./lib.mjs";

const RL = "src/security/rateLimiter.ts";

const AGENTS = [
  // ── Tournament: three agents race to rewrite the same method ──────────────────────────────
  {
    agentId: "perf-kv-cache",
    taskIntent: "Speed up checkQuota by caching the bucket key",
    symbols: [`${RL}#EdgeRateLimiter.checkQuota`],
    edit: async (dir) => {
      await patch(
        dir,
        RL,
        "const count = (await getCounter(`${key}:${bucket}`)) ?? 0;",
        "const bucketKey = `${key}:${bucket}`;\n    const count = (await getCounter(bucketKey)) ?? 0;"
      );
      await patch(dir, RL, "await putCounter(`${key}:${bucket}`, count + 1);", "await putCounter(bucketKey, count + 1);");
      return { message: "perf: reuse bucket key in checkQuota" };
    },
  },
  {
    agentId: "perf-sliding-window",
    taskIntent: "Rewrite checkQuota as a sliding window across two buckets",
    symbols: [`${RL}#EdgeRateLimiter.checkQuota`],
    edit: async (dir) => {
      await patch(
        dir,
        RL,
        "    const count = (await getCounter(`${key}:${bucket}`)) ?? 0;\n",
        [
          "    const now = Date.now();",
          "    const elapsed = (now % this.windowMs) / this.windowMs;",
          "    const previous = (await getCounter(`${key}:${bucket - 1}`)) ?? 0;",
          "    const current = (await getCounter(`${key}:${bucket}`)) ?? 0;",
          "    // Weight the previous window by how much of it still overlaps the sliding window.",
          "    const count = Math.floor(previous * (1 - elapsed)) + current;",
          "",
        ].join("\n")
      );
      await patch(dir, RL, "await putCounter(`${key}:${bucket}`, count + 1);", "await putCounter(`${key}:${bucket}`, current + 1);");
      return { message: "perf: sliding-window checkQuota" };
    },
  },
  {
    agentId: "perf-early-exit",
    taskIntent: "Short-circuit checkQuota for zero limits",
    symbols: [`${RL}#EdgeRateLimiter.checkQuota`],
    edit: async (dir) => {
      await patch(
        dir,
        RL,
        "    const bucket = Math.floor(Date.now() / this.windowMs);\n    const count",
        "    if (this.limit <= 0) return { allowed: false, remaining: 0 };\n    const bucket = Math.floor(Date.now() / this.windowMs);\n    const count"
      );
      return { message: "perf: early exit when limit is zero" };
    },
  },

  // ── Orthogonal: same file, different symbol — woven automatically ─────────────────────────
  {
    agentId: "audit-telemetry",
    taskIntent: "Add a telemetry hook to EdgeRateLimiter",
    symbols: [`${RL}#EdgeRateLimiter.emitTelemetry`],
    edit: async (dir) => {
      await patch(
        dir,
        RL,
        "  async flushWindow(key: string): Promise<void> {",
        "  emitTelemetry(key: string, decision: QuotaDecision): void {\n    console.log(JSON.stringify({ event: \"quota\", key, ...decision }));\n  }\n\n  async flushWindow(key: string): Promise<void> {"
      );
      return { message: "feat: emitTelemetry hook" };
    },
  },
  {
    agentId: "ops-flush",
    taskIntent: "Make flushWindow clear the previous bucket too",
    symbols: [`${RL}#EdgeRateLimiter.flushWindow`],
    edit: async (dir) => {
      await patch(dir, RL, "    await putCounter(`${key}:${bucket}`, 0);\n  }\n}", "    await putCounter(`${key}:${bucket}`, 0);\n    await putCounter(`${key}:${bucket - 1}`, 0);\n  }\n}");
      return { message: "fix: flush previous bucket too" };
    },
  },

  // ── Independent files ─────────────────────────────────────────────────────────────────────
  {
    agentId: "auth-leeway",
    taskIntent: "Allow 30s clock skew in verifySession",
    symbols: ["src/auth/jwt.ts#verifySession"],
    edit: async (dir) => {
      await patch(dir, "src/auth/jwt.ts", "session.exp > Date.now() / 1000", "session.exp + 30 > Date.now() / 1000");
      return { message: "fix: 30s clock-skew leeway" };
    },
  },
  {
    agentId: "billing-rounding",
    taskIntent: "Use banker's rounding in applyTax",
    symbols: ["src/billing/invoice.ts#applyTax"],
    edit: async (dir) => {
      await patch(
        dir,
        "src/billing/invoice.ts",
        "  return Math.round(cents * (1 + rate));",
        "  const x = cents * (1 + rate);\n  const r = Math.round(x);\n  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;"
      );
      return { message: "fix: banker's rounding for tax" };
    },
  },

  // ── Misbehaving agents: the control plane catches them from the git objects ────────────────
  {
    agentId: "rogue-scope-creep",
    taskIntent: "Tidy subtotal (but also quietly edits applyTax)",
    symbols: ["src/billing/invoice.ts#subtotal"],
    edit: async (dir) => {
      await patch(dir, "src/billing/invoice.ts", "items.reduce((sum, i) =>", "items.reduce((sum: number, i: LineItem) =>");
      await patch(dir, "src/billing/invoice.ts", "export function applyTax(cents: number, rate: number)", "export function applyTax(cents: number, rate = 0.0)");
      return { message: "refactor: tidy subtotal", symbolsModified: ["src/billing/invoice.ts#subtotal"] };
    },
  },
  {
    agentId: "liar-provenance",
    taskIntent: "Rotate the dev key (claims a different symbol in its manifest)",
    symbols: ["src/auth/keys.ts#currentKey"],
    edit: async (dir) => {
      await patch(dir, "src/auth/keys.ts", '"dev-secret-do-not-ship"', '"dev-secret-rotated-2026-10"');
      return { message: "chore: rotate dev key", symbolsModified: ["src/auth/keys.ts#somethingElse"] };
    },
  },
];

const only = process.argv.slice(2);
const wave = only.length ? AGENTS.filter((a) => only.includes(a.agentId)) : AGENTS;

console.log(c.bold(`\nLaunching ${wave.length} concurrent agents — one Artifacts fork each\n`));
const t0 = Date.now();
const results = await Promise.allSettled(wave.map((a) => runAgent(a)));
for (const [i, r] of results.entries()) {
  if (r.status === "rejected") console.log(c.red(`${wave[i].agentId} failed: ${r.reason.message}`));
}
console.log(c.dim(`\n${results.filter((r) => r.status === "fulfilled").length}/${wave.length} agents pushed in ${((Date.now() - t0) / 1000).toFixed(1)}s`));
console.log(c.dim("Next: npm run weave\n"));
