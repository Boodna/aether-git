#!/usr/bin/env node
// Create (or reuse) the baseline Artifacts repo and push the demo codebase in ./seed into it.
import { cp, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { api, BASELINE, c, git, removeDir, tempDir } from "./lib.mjs";

const seedDir = fileURLToPath(new URL("../seed", import.meta.url));

const repo = await api("/api/repos/init-baseline", { name: BASELINE });
console.log(`${repo.existed ? "Reusing" : "Created"} baseline ${c.bold(repo.name)} → ${c.dim(repo.remote)}`);

const dir = await tempDir("seed");
try {
  await git(["clone", "--quiet", repo.remote, dir], { token: repo.token });
  const hasCommits = await git(["rev-parse", "--verify", "-q", "HEAD"], { cwd: dir }).then(
    () => true,
    () => false
  );
  if (hasCommits && !process.argv.includes("--reseed")) {
    console.log(c.dim("Baseline already has commits; pass --reseed to overwrite it with ./seed."));
  } else {
    if (!hasCommits) await git(["checkout", "--quiet", "-b", repo.defaultBranch], { cwd: dir });
    for (const entry of await readdir(dir)) if (entry !== ".git") await removeDir(`${dir}/${entry}`);
    await cp(seedDir, dir, { recursive: true });
    await git(["add", "-A"], { cwd: dir });
    await git(["commit", "--quiet", "--allow-empty", "-m", "Seed core-platform baseline"], { cwd: dir });
    await git(["push", "--quiet", "origin", `HEAD:${repo.defaultBranch}`], { cwd: dir, token: repo.token });
    console.log(c.green(`Seeded ${repo.name}@${(await git(["rev-parse", "--short", "HEAD"], { cwd: dir }))}`));
  }
  await api("/api/reset", { baselineRepo: BASELINE });
  console.log(c.dim("Coordinator state reset."));
} finally {
  await removeDir(dir);
}
