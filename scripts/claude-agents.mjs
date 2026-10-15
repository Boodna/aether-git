#!/usr/bin/env node
// Real LLM agents. Each Claude agent leases symbols, gets its own Artifacts fork, edits code
// from a natural-language task, and pushes. The control plane treats it exactly like any other
// agent: if Claude strays outside its lease, the push is flagged from the git objects.
//
// Backend: ANTHROPIC_API_KEY → Messages API; otherwise the local `claude` CLI (Claude Code, headless).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { c, readText, runAgent, writeText } from "./lib.mjs";

const exec = promisify(execFile);
const MODEL = process.env.AETHER_CLAUDE_MODEL || "claude-sonnet-5-5";

const TASKS = [
  {
    agentId: "claude-key-rotation",
    taskIntent: "Support key rotation: currentKey should read the active key id from a rotate-able keyring, and add rotateKey()",
    symbols: ["src/auth/keys.ts#currentKey", "src/auth/keys.ts#rotateKey", "src/auth/keys.ts#cached"],
    files: ["src/auth/keys.ts"],
  },
  {
    agentId: "claude-discounts",
    taskIntent: "Add applyDiscount(cents, percent) to the invoice module, clamping percent to 0-100 and rounding to whole cents",
    symbols: ["src/billing/invoice.ts#applyDiscount"],
    files: ["src/billing/invoice.ts"],
  },
  {
    agentId: "claude-reset-all",
    taskIntent: "Add a resetAll(keys: string[]) method to EdgeRateLimiter that flushes the current window for every key",
    symbols: ["src/security/rateLimiter.ts#EdgeRateLimiter.resetAll"],
    files: ["src/security/rateLimiter.ts"],
  },
];

function prompt(task, sources) {
  return [
    `You are an autonomous coding agent working in an isolated fork of a TypeScript repo.`,
    `Task: ${task.taskIntent}`,
    ``,
    `You hold leases ONLY on these AST symbols (path#Symbol or path#Class.member):`,
    ...task.symbols.map((s) => `  - ${s}`),
    `Do not modify any other function, method, class member or file. Imports may be added if needed.`,
    ``,
    ...sources.flatMap(([path, text]) => [`--- ${path} ---`, text]),
  ].join("\n");
}

async function viaApi(task, dir) {
  const sources = await Promise.all(task.files.map(async (p) => [p, await readText(dir, p)]));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content:
            prompt(task, sources) +
            `\n\nReply with the complete new contents of each file you change, each in its own block:\n<file path="...">\n...\n</file>\nNo other prose.`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const text = (await res.json()).content.map((b) => b.text ?? "").join("");
  const blocks = [...text.matchAll(/<file path="([^"]+)">\n?([\s\S]*?)<\/file>/g)];
  if (!blocks.length) throw new Error("model returned no <file> blocks");
  for (const [, path, body] of blocks) {
    if (!task.files.includes(path)) throw new Error(`model tried to write unexpected file ${path}`);
    await writeText(dir, path, body.replace(/^\n/, ""));
  }
}

async function viaCli(task, dir) {
  const sources = []; // Claude Code reads files itself
  await exec(
    "claude",
    [
      "-p",
      prompt(task, sources) + `\n\nThe repo is the current directory. Edit the files directly with your tools. Do not run git.`,
      "--allowedTools",
      "Read,Edit,Write,Glob,Grep",
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      "12",
    ],
    { cwd: dir, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024, input: "" }
  );
}

const backend = process.env.ANTHROPIC_API_KEY ? viaApi : viaCli;
console.log(c.bold(`\nLaunching ${TASKS.length} Claude agents (${process.env.ANTHROPIC_API_KEY ? `API · ${MODEL}` : "Claude Code CLI"})\n`));

const results = await Promise.allSettled(
  TASKS.map((task) =>
    runAgent({
      agentId: task.agentId,
      taskIntent: task.taskIntent,
      symbols: task.symbols,
      edit: async (dir) => {
        await backend(task, dir);
        return { message: `${task.agentId}: ${task.taskIntent}`.slice(0, 72), symbolsModified: null, verification: { generatedBy: process.env.ANTHROPIC_API_KEY ? MODEL : "claude-code" } };
      },
    })
  )
);
for (const [i, r] of results.entries()) if (r.status === "rejected") console.log(c.red(`${TASKS[i].agentId} failed: ${r.reason.message}`));
console.log(c.dim("\nNext: npm run weave\n"));
