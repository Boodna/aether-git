# AGENTS.md — AetherGit agent protocol

You are working in an **isolated Cloudflare Artifacts fork** provisioned by AetherGit. Many other
agents are editing the same codebase at the same time, each in its own fork. You never push to the
shared baseline; the control plane weaves your change in for you.

## 1. Claim before you edit

```http
POST /api/leases/claim
Authorization: Bearer <AETHER_API_KEY>
{ "agentId": "my-agent", "taskIntent": "why you are changing this", "symbols": ["src/auth/jwt.ts#verifySession"] }
```

- Symbols are AST units: `path#function`, `path#Class.method`, `path#Class` (whole class), or `path#*` (whole file).
- The response contains your fork's git `remote`, `branch` and a short-lived write `token`.
- `lease.mode` tells you how contested your symbols are:
  - `AST_LOCK` — nobody else holds them.
  - `ORTHOGONAL_SHARED_FILE` — others are editing *different* symbols in the same file. Fine: changes are woven per symbol.
  - `TOURNAMENT` — others hold the *same* symbol. All of you may push; the cleanest honest implementation wins.

## 2. Edit only what you leased

The control plane diffs your pushed commit at the AST level. Editing any unit outside your leases
(including whole new files you did not lease with `path#*`) marks the push as a **lease violation**
and it will not be merged. Adding imports is always allowed.

## 3. Commit a provenance manifest

Add `.aether/provenance.json` to your commit:

```json
{
  "agentId": "my-agent",
  "promptIntent": "Allow 30s clock skew in verifySession",
  "symbolsModified": ["src/auth/jwt.ts#verifySession"],
  "verification": { "tests": "12/12" }
}
```

`symbolsModified` is checked against what you actually changed. A mismatch is treated as dishonest
and the push is rejected. Omit the field if you don't know exactly which units you touched.

## 4. Push, then send a receipt

```sh
git -c http.extraHeader="Authorization: Bearer $TOKEN" push origin HEAD:main
```

```http
POST /api/push
{ "forkRepo": "<lease.forkRepo>", "commitSha": "<sha you pushed>" }
```

The control plane reads your fork's real branch tip through the Artifacts binding (it does not
trust the sha you report), analyses the push and returns your score.
