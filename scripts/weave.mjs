#!/usr/bin/env node
// Integrator: ask the Worker for a weave plan (tournament winners + symbol-level 3-way merge),
// commit the woven files onto the baseline and push. Repeats in batches until no pushed
// candidates remain. The Artifacts binding is read-only, so this is the one step that needs git.
import { api, BASELINE, c, git, removeDir, tempDir, writeText } from "./lib.mjs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const quiet = process.argv.includes("--quiet");
const totals = { merged: 0, lost: 0, rejected: 0, commits: 0 };
const t0 = Date.now();

for (let round = 1; ; round++) {
  const { plan, git: g } = await api("/api/weave/plan", { baselineRepo: BASELINE, maxCandidates: 150 });
  const handled = plan.merged.length + plan.lost.length + plan.rejected.length;
  if (!handled) break;

  if (!quiet) {
    console.log(c.bold(`\nWeave round ${round} · ${plan.baselineRepo}@${plan.headSha?.slice(0, 8)}\n`));
    for (const m of plan.merged) console.log(`  ${c.green("✓ merge ")} ${m.agentId.padEnd(22)} score ${String(m.score).padStart(5)}  ${c.dim(m.symbols.join(", "))}`);
    for (const l of plan.lost) console.log(`  ${c.magenta("✗ lost  ")} ${l.forkRepo.padEnd(22)} ${c.dim(l.reason)}`);
    for (const r of plan.rejected) console.log(`  ${c.red("✗ reject")} ${r.forkRepo.padEnd(22)} ${c.dim(r.reason)}`);
  }

  let resultSha = plan.headSha;
  if (plan.merged.length && g) {
    const dir = await tempDir("weave");
    try {
      await git(["clone", "--quiet", "--branch", g.branch, g.remote, dir], { token: g.token });
      const head = await git(["rev-parse", "HEAD"], { cwd: dir });
      if (head !== plan.headSha) throw new Error(`baseline moved (${head.slice(0, 8)} != ${plan.headSha.slice(0, 8)}); re-run weave`);
      for (const [path, text] of Object.entries(plan.files)) {
        if (text === null) await rm(join(dir, path), { force: true });
        else await writeText(dir, path, text);
      }
      const trailers = plan.merged.map((m) => `Woven-From: ${m.forkRepo}@${m.commitSha.slice(0, 12)} (${m.agentId}: ${m.intent})`);
      const message = [
        `weave: ${plan.merged.length} agent change(s) onto ${plan.headSha.slice(0, 8)}`,
        "",
        ...plan.merged.map((m) => `- ${m.agentId}: ${m.symbols.join(", ")}`),
        "",
        ...trailers,
      ].join("\n");
      await git(["add", "-A"], { cwd: dir });
      await git(["commit", "--quiet", "-m", message], { cwd: dir });
      resultSha = await git(["rev-parse", "HEAD"], { cwd: dir });
      await git(["push", "--quiet", "origin", `HEAD:${g.branch}`], { cwd: dir, token: g.token });
      if (!quiet) console.log(c.dim("\n" + (await git(["show", "--stat", "--format=%s", "HEAD"], { cwd: dir }))));
    } finally {
      await removeDir(dir);
    }
    totals.commits++;
  }

  await api("/api/weave/complete", {
    baselineRepo: BASELINE,
    baselineSha: plan.headSha,
    resultSha,
    merged: plan.merged.map((m) => m.forkRepo),
    lost: plan.lost,
    rejected: plan.rejected,
  });
  totals.merged += plan.merged.length;
  totals.lost += plan.lost.length;
  totals.rejected += plan.rejected.length;
  console.log(
    `${c.green(`round ${round}:`)} wove ${plan.merged.length} fork(s) → ${plan.baselineRepo}@${resultSha?.slice(0, 8)}` +
      c.dim(` · ${plan.lost.length} lost · ${plan.rejected.length} rejected`)
  );
}

console.log(
  c.bold(`\nWeave complete in ${((Date.now() - t0) / 1000).toFixed(1)}s: `) +
    `${c.green(totals.merged + " merged")} in ${totals.commits} commit(s) · ${c.magenta(totals.lost + " lost")} · ${c.red(totals.rejected + " rejected")}\n`
);
