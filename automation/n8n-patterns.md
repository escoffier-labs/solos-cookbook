# n8n Patterns

> The interface surfaces, sandbox traps, and failure-routing patterns that actually matter for running n8n as the multi-step workflow layer underneath an agent stack. Pick the wrong API surface and your error-workflow setting silently disappears; pick the wrong Code node pattern and the whole task runner heartbeats out and dies.

## What this is

n8n is the layer-3 scheduler in the [cron-patterns](cron-patterns.md) split: multi-step workflows with branches, fan-out, retries, and error handling. The product itself is solid. The traps live at the edges: three interfaces (UI, REST API, direct sqlite) with surprisingly different semantics, a Code node sandbox with non-obvious holes, and a workflow-data model that silently reverts naive direct-DB edits.

This guide covers the n8n surface area you actually have to deal with when an agent stack drives n8n programmatically: which interface to use for which job, the Code node patterns that survive the task runner's constant-folding pass, and the failure-classification shape that keeps a multi-workflow setup from drowning the error channel.

## Why this way

Three interfaces to n8n exist. Each has a different job and a different failure mode:

| Interface | Good at | Silently breaks on |
|-----------|---------|---------------------|
| **`n8n-ops-mcp` (MCP server)** | Agent-driven reads/writes with confirm gates, batch operations, redaction at the tool layer, schema-aware updates that don't strip settings | Anything not yet exposed as a tool — fall through to API for the gap |
| **REST API (`/api/v1/...`)** | Programmatic creates, single-workflow updates of nodes/connections, audit and credential reads | `PUT /workflows/:id` strips `settings.errorWorkflow`. `POST /workflows/:id/run` returns 405. Error workflows do not fire on CLI or manual runs. |
| **Direct sqlite** | Surgical fixes when import is awkward, settings columns where the API has a contract bug, recovery when a workflow gets corrupted by repeated PUTs | Updating `workflow_entity.nodes` or `connections` without also updating the active `workflow_history` row — n8n re-syncs from history on startup and clobbers your edit |

Beyond interfaces, two cross-cutting traps catch every n8n stack eventually: the Code node sandbox is more limited than the docs imply, and the JS task runner does parse-time substitution over user code that produces cryptic SyntaxErrors when JS-meaningful characters end up in named consts.

The cost of getting these right once is low. The cost of getting them wrong is silent failures that present as "the workflow worked yesterday" while error workflows quietly stop firing.

## Prerequisites

- n8n running somewhere (Docker, native, hosted) — this guide assumes Docker on Linux, but most patterns transfer
- An MCP-capable client (Claude Code, Claude Desktop, OpenClaw, Hermes Agent, Codex CLI) for the recommended interface
- Comfort with sqlite, JSON, and reading n8n's OpenAPI schema when the gaps need filling

## Before / After

**Before:** A handful of workflows, edited entirely through the n8n UI. When you need to script a change you reach for the REST API, hit `PUT /workflows/:id` to update node settings, and discover three days later that `errorWorkflow` is gone from every workflow you touched. The error notifier you set up in February has been firing on nothing since March.

**After:**

- Agents and scripts drive n8n through `n8n-ops-mcp` for anything it covers (most read paths and the lifecycle-write paths)
- Direct sqlite is reserved for the narrow case where the API has a known contract bug, and always touches both `workflow_entity` and `workflow_history` in one transaction
- One Failure Classifier workflow is wired as `errorWorkflow` on every active workflow, with bucketed actions and fingerprint-based dedup so the error channel surfaces signal not noise

You can list every active workflow's `errorWorkflow` setting in one query and verify the wiring is intact.

## Implementation

### Routing decision tree

```
Need to interact with n8n programmatically?
├─ Is the operation supported by n8n-ops-mcp?
│  ├─ YES → Use the MCP tool. Done.
│  └─ NO  → Drop to REST API; check the schema gotchas first.
└─ Need a surgical fix the API can't do?
   └─ Stop n8n, edit sqlite touching BOTH workflow_entity AND workflow_history
      in one transaction, restart, verify with a fresh GET.
```

### Layer 1 — Recommended interface: `n8n-ops-mcp`

`n8n-ops-mcp` is an ops-focused MCP server that wraps the n8n API with the gotchas already handled: schema-aware updates that don't strip settings, batch operations with proper abort semantics, redaction of secrets at the tool layer, and confirm gates on irreversible writes.

**Install:**

```bash
npm install -g n8n-ops-mcp
```

**Wire to your MCP client.** Claude Code example (`~/.claude/settings.json` or `$CLAUDE_CONFIG_DIR/settings.json`):

```json
{
  "mcpServers": {
    "n8n-ops": {
      "command": "n8n-ops-mcp",
      "env": {
        "N8N_BASE_URL": "https://<YOUR_N8N>",
        "N8N_API_KEY": "<API_KEY>",
        "N8N_ENABLE_EDIT": "true",
        "_comment": "Set N8N_ENABLE_CREDENTIALS_WRITE=true ONLY when you need it. Default off — second gate on top of enableEdit.",
        "N8N_ENABLE_CREDENTIALS_WRITE": "false"
      }
    }
  }
}
```

The same `command` + `env` shape works for OpenClaw (`plugins.entries.<id>.config`), Claude Desktop, Codex CLI, and any other MCP-capable harness. Tool count is in the mid-30s and growing. The categories you'll use most:

- **Workflow lifecycle:** list/get/create/update/delete/activate/deactivate
- **Execution lifecycle:** list/get/retry/delete (single + batch with proper abort under concurrency)
- **Scanners:** webhooks, schedules, find-workflows-by-node-type, browser-bridge audit, check-disabled-nodes
- **Tags:** list/get/create/delete/set-on-workflow (delete cascades server-side, confirm-gated)
- **Audit:** `n8n_run_audit` returns counts by default; pass `includeDetails: true` to drill into a specific finding (default omits per-section `location` arrays to avoid surfacing credential ids and node ids in agent context)

**Why this is the recommended interface even if you only use it occasionally:**

1. **It does not strip `settings.errorWorkflow` on update.** The raw `PUT /workflows/:id` does. The MCP wraps the update path correctly.
2. **It redacts secrets at the tool layer.** Credential reads strip the `data` field even if the upstream contract excludes it (defense in depth against future regressions). Credential creates wrap all error classes (not just typed API errors) into a body-free synthetic so a parse-error message can't leak the secret out of `JSON.parse`.
3. **It separates reads from writes from credentials.** `enableEdit` gates writes. `enableCredentialsWrite` is a second gate on top of `enableEdit`, default off, for the credential-create/delete surface specifically.
4. **It handles the 405 on `POST /workflows/:id/run` for you** by exposing `n8n_trigger_workflow` that uses the right path.

If you build your own n8n integration, treat this list as the minimum bar to clear before you trust it.

### Layer 2 — REST API gaps and traps

Where the MCP doesn't cover what you need, fall through to the REST API. The traps to know:

**`POST /api/v1/workflows` creates inactive.** Activation is a separate `POST /workflows/:id/activate` call. The "create + activate" pattern needs both, in order.

**`PUT /api/v1/workflows/:id` accepts a strict allowlist.** Only `name, nodes, connections, settings, staticData`. Anything else returns 400. The `settings` field has its own allowlist: `executionOrder, callerPolicy, errorWorkflow, timezone, saveDataErrorExecution, saveDataSuccessExecution, saveExecutionProgress, saveManualExecutions, executionTimeout`. Fields like `availableInMCP` are silently rejected.

**`PUT /workflows/:id` strips `settings.errorWorkflow` on write.** This is the one that bites hardest. Use direct sqlite (with n8n stopped) or `n8n import:workflow` for any settings-only change.

**`POST /workflows/:id/run` returns 405.** No public manual-run endpoint exists. The escape hatches:

```bash
docker exec n8n sh -c 'N8N_RUNNERS_ENABLED=false N8N_RUNNERS_BROKER_PORT=5680 n8n execute --id <id>'
```

Or, in a script, the MCP's `n8n_trigger_workflow`. **Note:** error workflows fire only on trigger-mode executions (Schedule, Webhook, Cron). They do NOT fire on `n8n execute --id` or manual editor runs. If you're smoke-testing the error chain, use an Execute Workflow Trigger as the entry node so the cascade actually fires.

**Workflows can corrupt after multiple PUTs.** If executions start failing with no diagnostic info — `status: error, lastNode: null, runData: {}` — and the workflow has been PUT-edited a lot, the fix is delete + recreate. Save the workflow JSON first.

### Layer 3 — Direct sqlite (escape hatch)

n8n's data model is two-table for an unobvious reason:

- `workflow_entity` — the editable "draft" view the UI renders and POSTs against
- `workflow_history` — versioned snapshots; each save creates a new row
- `workflow_entity.activeVersionId` — foreign key into `workflow_history`. **This is the runtime source of truth.** When n8n activates a workflow on startup, it reads `nodes` and `connections` from the history row, then re-syncs `workflow_entity` to match.

So an UPDATE against `workflow_entity.nodes` looks like it worked (SELECT confirms the new value), survives until n8n restarts, then gets clobbered when n8n re-syncs from history. Silent revert. The fix is to update both rows in one transaction:

```python
import sqlite3

con = sqlite3.connect(DB_PATH)
cur = con.cursor()

active = cur.execute(
    "SELECT activeVersionId FROM workflow_entity WHERE id=?", (wfid,)
).fetchone()[0]

cur.execute(
    "UPDATE workflow_history SET nodes=?, updatedAt=datetime('now') WHERE versionId=?",
    (new_nodes_json, active),
)
cur.execute(
    "UPDATE workflow_entity SET nodes=?, updatedAt=datetime('now') WHERE id=?",
    (new_nodes_json, wfid),
)
con.commit()
```

**`settings` is a special case.** It lives only on `workflow_entity`. `workflow_history` has no settings column. Direct UPDATE on `workflow_entity.settings` (e.g., for `errorWorkflow`) survives a clean stop/start without revert, *as long as you stop n8n first*. The history-resync gotcha applies to `nodes`/`connections` only.

**Preferred alternative:** `docker exec n8n n8n import:workflow --input=file.json` goes through the normal import path, updates both tables, and creates a new history version. Use that when the edit isn't surgical enough to need direct DB. Be aware: `import:workflow` auto-deactivates the imported workflow ("Remember to activate later"). For workflows that were active before import, re-activate after.

### Layer 4 — Code node sandbox

n8n's Code node JavaScript sandbox has non-obvious holes. The ones that bite:

**`process` is not exposed.** Use `$env.VAR_NAME` for environment access.

**Global `URL` is not exposed.** Use `require('url').URL`.

**`require()` for builtins works only if the env vars are set.** Compose needs `NODE_FUNCTION_ALLOW_BUILTIN: "*"` and `NODE_FUNCTION_ALLOW_EXTERNAL: "*"`. If those go missing, every Code node breaks at the same time. Suspect this first when "every workflow stopped working."

**Never use `spawnSync` for long-running calls.** It blocks the JS event loop. The task-runner heartbeat can't fire, the broker disconnects after ~60s, and the execution dies with no useful error. Use async `child_process.spawn` wrapped in a Promise with explicit stdout/stderr collection, a `setTimeout`, and `child.kill('SIGKILL')` on timeout.

**Use `var` not `const` for `require()` calls** in patterns shared across multiple Code nodes. The task-runner's parse-time substitution treats `var` declarations more leniently. (Also: see the constant-folding trap below.)

**Code nodes can't always resolve Docker hostnames.** When the task runner runs in isolation, `require('http')` calls to other compose services fail. Use n8n's built-in HTTP Request node for inter-service calls instead.

#### The task-runner constant-folding trap

n8n's js-task-runner does parse-time substitution and folding over user code before V8 sees it. When a `const` holds a JS-meaningful character (`\n`, backtick, `${`, `'`, `"`), the folded source can become invalid, producing cryptic SyntaxErrors at runtime. Two confirmed instances on this stack:

- A Code node with `const NL = '\n'; ... .join(NL);` produced `Invalid or unexpected token` because the substitution put a real newline INSIDE a string literal that became unterminated.
- A Code node with `const tick = String.fromCharCode(96); ... '- ' + tick + r.repo` produced `Unexpected string` because the substitution injected a backtick into a context where V8 couldn't disambiguate the concatenation.

**Rule:** in n8n Code nodes, never assign a JS-meaningful character to a named const and use it in template literals or string concatenations. Either:

- Inline the character via escape sequence directly: `'\n'`, `'\x60'`, `` `\\n` ``
- Wrap behind a function call so the folder can't fold over it: `String.fromCharCode(96)` at every use site, no intermediate const
- For embedded scripts (e.g., `String.raw\`...\`` passed to `cp.spawnSync('node', ['-e', script])`), the rule applies to identifiers used INSIDE the embedded script too — the runner appears to fold across the template boundary

The bug is data-dependent and intermittent. One workflow self-healed after an n8n restart with no code change. Don't trust "it's working now" without removing the trigger pattern.

### Layer 5 — Failure classification

The default behavior on a multi-workflow stack is one Error Trigger workflow that posts raw error text to a chat channel. Within a week the channel is unreadable: 80 messages a day, most of them the same SyntaxError repeating from a single broken Code node.

The pattern that works is a **classifier + dedup** node inserted into the existing Error Notifier:

```
Error Trigger -> Classify + Dedup -> Post to Chat
                                  -> Report to Agent System
```

**Classification taxonomy (8 buckets, 4 actions):**

| Bucket | Patterns | Action |
|--------|----------|--------|
| `code-error` | SyntaxError, ReferenceError, TypeError-on-undefined | `disable-and-fix` (will never succeed on retry) |
| `auth` | 401/403, "invalid auth", "unauthorized", "forbidden" | `investigate` (token expired/revoked/wrong scope) |
| `rate-limit` | 429, "rate limit", "too many requests", "quota" | `safe-retry-backoff` |
| `timeout` | ETIMEDOUT, ECONNRESET, "timed out", "AbortError" | `safe-retry` |
| `network` | ENOTFOUND, EAI_AGAIN, EHOSTUNREACH, ECONNREFUSED | `safe-retry-backoff` |
| `ssh` | "ssh:", "permission denied (publickey)", "ssh exit N" | `investigate` |
| `http-server` | 5xx | `safe-retry-backoff` |
| `http-client` | 4xx (excluding auth/ratelimit) | `investigate` |
| `unknown` | everything else | `investigate` |

**Fingerprint-based dedup:**

- `sha1(workflowId + lastNode + bucket + normalized_message_first_line)`, first 12 hex chars
- Normalize: strip hex IDs, numbers, paths, URLs so similar errors collapse
- State in `$getWorkflowStaticData('global').failures[fingerprint]` with `count`, `count24h`, `firstSeen`, `lastSeen`, `recent` (last 5 exec ids), `seenInLast24h` (timestamps)
- Suppress chat post if `count24h > 3` AND `lastSeen < 30min ago` AND `count24h NOT in {10, 50, 100, 500, ...}` — escalation thresholds always break suppression
- Always report to your agent system regardless of suppression (separate lane)

**Escalation rules:**

- `code-error` AND `count24h >= 3` → "AUTO-DISABLE RECOMMENDED — will never succeed on retry"
- `count24h == 10` → "10 identical failures in 24h"
- `count24h == 50` → "50 identical failures in 24h"
- Multiples of 100 → "DISABLE THIS WORKFLOW"

The state persists in `staticData`, which is fine but resets on each `import:workflow` of the error workflow itself. Trends rebuild within 24h.

A standalone deep-dive on this pattern is planned at `automation/failure-classifier.md`.

## Verification

After wiring, you should be able to enumerate the n8n surface in three commands:

```bash
# 1. Active workflows + their errorWorkflow setting
docker exec n8n sh -c 'sqlite3 /home/node/.n8n/database.sqlite \
  "SELECT id, name, json_extract(settings, \"$.errorWorkflow\") FROM workflow_entity WHERE active = 1;"'
# Every active workflow should have an errorWorkflow id set.

# 2. n8n-ops-mcp tool surface (from your MCP client)
# Claude Code: ask the agent "list n8n-ops tools"; OpenClaw: openclaw mcp list-tools

# 3. Recent failure classification (if classifier wired)
docker exec n8n sh -c 'sqlite3 /home/node/.n8n/database.sqlite \
  "SELECT staticData FROM workflow_entity WHERE name LIKE \"%Error%\" LIMIT 1;"' | jq '.failures | length'
# Number of distinct fingerprints tracked.
```

If a workflow is active but its `errorWorkflow` is null, a recent `PUT /workflows/:id` likely stripped it. Re-set via direct sqlite (n8n stopped) or `import:workflow`.

## Gotchas

**`workflow_entity.nodes` UPDATEs silently revert on n8n restart.** n8n re-syncs from `workflow_history.activeVersionId` on activation startup. **Fix:** update both tables in one transaction, or use `n8n import:workflow` which goes through the proper path.

**`PUT /api/v1/workflows/:id` strips `settings.errorWorkflow`.** If you script a workflow update and don't re-set errorWorkflow, the error chain disappears for that workflow with no warning. **Fix:** prefer `n8n-ops-mcp` (which wraps this correctly), or use direct sqlite UPDATE on `workflow_entity.settings` (settings is single-table, with n8n stopped), or `n8n import:workflow`.

**`POST /workflows/:id/run` returns 405.** No public manual-run endpoint exists. **Fix:** `docker exec n8n n8n execute --id <id>` from a host script, or the MCP's `n8n_trigger_workflow`. Be aware that CLI executes do NOT cascade to `errorWorkflow` — only auto-triggered runs (schedule, webhook, cron) do. For smoke-testing the error chain, use an Execute Workflow Trigger as the entry node.

**`n8n import:workflow` auto-deactivates the imported workflow.** The "Remember to activate later" message is the only signal. **Fix:** re-activate after import. If the workflow was active in DB before import, the `active=1` column survives, but the runtime registration may need a touch — verify with a quick activation API call, idempotent.

**Task-runner constant-folding produces SyntaxErrors from JS-meaningful characters in `const`.** `const NL = '\n'` used in template literals or `.join(NL)` can produce `Invalid or unexpected token` at runtime depending on surrounding context. **Fix:** inline the character at every use site, or wrap behind a function call (`String.fromCharCode(96)` for backticks, `'\n'` literal for newlines). Same rule applies INSIDE embedded scripts passed to `spawn`/`spawnSync`.

**`spawnSync` for long-running calls blocks the JS event loop and kills the task-runner heartbeat.** The broker disconnects after ~60s, the execution dies with no useful error. **Fix:** use `child_process.spawn` wrapped in a Promise with explicit stdout/stderr collection and `setTimeout` + `child.kill('SIGKILL')` on timeout.

**Merge node with 6+ inputs breaks webhook executions.** Symptom: webhook trigger runs to completion, no output, no error. **Fix:** replace the Merge node with a single Code node that uses `Promise.all()` over the upstream items and merges in JS.

**Docker `:latest` tag lags GitHub releases by ~1 minor version.** A new minor on GitHub doesn't mean it's pulled by `docker compose pull n8n` on the same day. **Fix:** if you need the latest, re-pull a few days later, or pin a specific tag in compose.

**Code node `JSON.parse` of an upstream response can leak the request body in error messages.** V8's `SyntaxError` from `JSON.parse(badText)` includes a slice of the unparseable text in the error message. On a write path that carries plaintext secrets, a malformed 2xx response that echoes the request body would leak the secret through this parse-error. **Fix:** wrap ALL error classes into a body-free synthetic before logging or surfacing, and do NOT chain the original via `cause` — `cause.message` carries the leak too. (Same defense `n8n-ops-mcp` does at its tool layer.)

## Templates

- `n8n-ops-mcp` install + wire snippet — see Layer 1 above; full schema documentation at the [`n8n-ops-mcp`](https://github.com/solomonneas/n8n-ops-mcp) README
- Direct-sqlite dual-table UPDATE pattern — see Layer 3 above; lift the Python snippet directly
- Classifier + dedup node — exhaustive recipe in Layer 5 above; standalone deep-dive planned at [`automation/failure-classifier.md`](README.md)

## Related

- [`automation/cron-patterns.md`](cron-patterns.md) — three-layer scheduling model; n8n is layer 3
- [`automation/hooks.md`](hooks.md) — three-layer hook model; the failure classifier is the pattern that pairs with `errorWorkflow` wiring
- [`automation/failure-classifier.md`](README.md) (planned) — full deep-dive on the classifier topology, taxonomy tuning, and escalation rules
- [n8n-ops-mcp](https://github.com/solomonneas/n8n-ops-mcp) — the MCP server this guide recommends
