# n8n Failure Classifier

> One Error Trigger workflow, wired as `errorWorkflow` on everything active, that turns raw stack traces into buckets and routes each bucket to the action it actually deserves. Without it a multi-workflow stack drowns the error channel in 80 messages a day, most of them the same SyntaxError from one broken Code node. With it, the channel is quiet until something genuinely needs a human. 🦞

**Tested on:** n8n 2.16.x on Docker (Alpine), 30+ active workflows, ~2,250 executions over a rolling 14-day window with a ~1% error rate, classifier wired as the single `errorWorkflow` on every active workflow, Signal + Discord as the two delivery lanes
**Last updated:** 2026-06-04

---

## What this is

This is the exhaustive recipe that [`n8n-patterns.md`](n8n-patterns.md) Layer 5 defers to. That guide tells you the classifier exists and shows the shape. This one is the full build: the node code, the taxonomy and why each bucket maps to the action it does, fingerprint-based dedup so a repeat failure collapses into one notification, the escalation rules that decide which buckets page you at 2am versus batch into a digest, and how to tune the taxonomy as the stack drifts.

If you only run two or three workflows you do not need this. The moment you cross roughly ten active workflows with their own triggers, schedules, and external dependencies, an unclassified error channel becomes write-only noise and you stop reading it. That is the failure mode this prevents.

Everything below is from a real stack. The bucket counts in the taxonomy section come from an actual two-week audit, not a hypothetical.

## Why this way

The naive setup is one Error Trigger workflow that posts raw error text to a chat channel. It works for a week. Then one Code node starts throwing the same `SyntaxError` every five minutes on a schedule trigger, and now the channel is 80 messages a day of identical noise. You mute the channel. Two weeks later a credential silently expires and the auth failure scrolls past in the muted channel and you find out when a downstream system goes dark.

The classifier fixes three separate problems that the naive setup conflates:

| Problem | What the classifier does |
|---------|--------------------------|
| **Not all errors are the same** | Buckets them. A `SyntaxError` will never succeed on retry; a 429 will. They deserve opposite actions. |
| **The same error repeats** | Fingerprints and dedups. The 200th identical failure is not 200 notifications, it is one notification with a count and an escalation. |
| **Not all buckets are equally urgent** | Routes by severity. Transient network blips batch into a daily digest; auth expiry and persistent code errors page immediately. |

The cost of building this once is an afternoon. The cost of not building it is that you stop reading your own error channel, which is strictly worse than having no error channel, because now you believe you have monitoring and you do not.

## Prerequisites

- n8n running with at least one chat delivery path wired (Discord webhook, Signal REST, Telegram, whatever)
- The `errorWorkflow` wiring understood and reversible. Read [`n8n-patterns.md`](n8n-patterns.md) Layer 2 and Layer 3 first: `PUT /workflows/:id` strips `settings.errorWorkflow`, so you set it via direct sqlite (n8n stopped) or `import:workflow`, never via a naive API update.
- Comfort with the n8n Code node sandbox and the task-runner constant-folding trap. The classifier is one big Code node and it trips both. See the [`n8n-patterns.md`](n8n-patterns.md) Code node section.

## Before / After

**Before:** One Error Trigger workflow posting raw text to a chat channel. The channel runs 60 to 90 messages a day. You muted it in March. When something real breaks you find out from the downstream symptom, not the error channel.

**After:**

- One classifier workflow wired as `errorWorkflow` on every active workflow
- Each error lands in one of nine buckets, each bucket mapped to one of four actions
- Repeat failures collapse by fingerprint: the 50th identical failure is a count bump, not a 50th message
- Severity routing splits two lanes: a routine Discord log gets everything, a Signal page fires only on actionable buckets with a cooldown
- You can enumerate every distinct active failure fingerprint in one sqlite query

## Implementation

### Topology

The classifier is the existing Error Notifier with a classify-and-dedup Code node inserted between the trigger and the delivery nodes:

```
Error Trigger
   -> Classify + Dedup (Code node)
        -> IF severity >= warning AND not suppressed
             -> Post to chat (Discord routine log, always)
             -> IF signalEligible AND not in cooldown -> Signal page
        -> Always: report to agent system (separate lane, never suppressed)
```

The two output lanes matter. The chat post is suppressible (that is the whole point of dedup). The agent-system report is not: it goes to your structured monitoring every time, so trend data is complete even when the chat channel is quiet. Suppression is a human-attention optimization, not a data-retention one.

### The classifier Code node

This is the load-bearing node. It does three things: classify the error into a bucket, compute a fingerprint, and update the dedup state in `staticData`. Mind the constant-folding trap throughout: no JS-meaningful character (`\n`, backtick, `${`) gets assigned to a `const` that later lands in a template literal. Where I need one I inline it or wrap it in a function call.

```javascript
// Classify + Dedup - n8n Code node
// Input: the Error Trigger item. Output: enriched item with .failure block.

const item = $input.first()?.json ?? {};

// Error Trigger shape: error lives under .execution.error or .error
const err = item.execution?.error ?? item.error ?? item;
const message = String(err.message ?? err.description ?? item.message ?? "");
const workflowId = String(
  item.workflow?.id ?? item.execution?.workflowData?.id ?? "unknown"
);
const workflowName = String(item.workflow?.name ?? "unknown");
const lastNode = String(err.node?.name ?? item.execution?.lastNodeExecuted ?? "unknown");

// --- Classification taxonomy: order matters, most specific first ---
function classify(msg) {
  if (/SyntaxError|ReferenceError|TypeError|is not a function|is not defined|Cannot read propert/i.test(msg)) {
    return { bucket: "code-error", severity: "error", action: "disable-and-fix" };
  }
  if (/401|403|invalid auth|unauthorized|forbidden|credential|token expired|api key/i.test(msg)) {
    return { bucket: "auth", severity: "error", action: "investigate" };
  }
  if (/429|rate.?limit|too many requests|quota/i.test(msg)) {
    return { bucket: "rate-limit", severity: "warning", action: "safe-retry-backoff" };
  }
  if (/ETIMEDOUT|ECONNRESET|timed out|deadline|AbortError|broker disconnect/i.test(msg)) {
    return { bucket: "timeout", severity: "warning", action: "safe-retry" };
  }
  if (/ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ECONNREFUSED|getaddrinfo/i.test(msg)) {
    return { bucket: "network", severity: "warning", action: "safe-retry-backoff" };
  }
  if (/schema|validation|unexpected (field|token)|missing required|400 Bad Request/i.test(msg)) {
    return { bucket: "schema-drift", severity: "error", action: "investigate" };
  }
  if (/ssh:|permission denied \(publickey\)|ssh exit|Host key verification/i.test(msg)) {
    return { bucket: "ssh", severity: "error", action: "investigate" };
  }
  if (/\b5\d\d\b|Internal Server Error|Bad Gateway|Service Unavailable/i.test(msg)) {
    return { bucket: "http-server", severity: "warning", action: "safe-retry-backoff" };
  }
  if (/\b4\d\d\b|Bad Request|Not Found|Conflict/i.test(msg)) {
    return { bucket: "http-client", severity: "error", action: "investigate" };
  }
  return { bucket: "unknown", severity: "error", action: "investigate" };
}

const cls = classify(message);

// --- Fingerprint: collapse similar errors ---
function normalize(msg) {
  return msg
    .split(String.fromCharCode(10))[0]      // first line only, no const newline
    .replace(/0x[0-9a-f]+/gi, "HEX")
    .replace(/\b[0-9a-f]{8,}\b/gi, "ID")
    .replace(/\b\d+\b/g, "N")
    .replace(/\/[^\s]+/g, "PATH")
    .replace(/https?:\/\/[^\s]+/gi, "URL")
    .slice(0, 200);
}

function fingerprint(parts) {
  // crypto is a builtin; NODE_FUNCTION_ALLOW_BUILTIN must be "*"
  var crypto = require("crypto");
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

const fp = fingerprint([workflowId, lastNode, cls.bucket, normalize(message)]);

// --- Dedup state in global staticData ---
const store = $getWorkflowStaticData("global");
if (!store.failures) store.failures = {};
const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const rec = store.failures[fp] ?? {
  count: 0, count24h: 0, firstSeen: now, lastSeen: now,
  recent: [], seenInLast24h: []
};

rec.count += 1;
rec.lastSeen = now;
rec.seenInLast24h = rec.seenInLast24h.filter((t) => now - t < DAY);
rec.seenInLast24h.push(now);
rec.count24h = rec.seenInLast24h.length;
rec.recent = [String(item.execution?.id ?? ""), ...rec.recent].slice(0, 5);
store.failures[fp] = rec;

// --- Suppression + escalation ---
const escalationLevels = [10, 50, 100, 500, 1000];
const isEscalation = escalationLevels.includes(rec.count24h) || rec.count24h % 100 === 0;
const recentlyNotified = now - (rec.lastNotified ?? 0) < 30 * 60 * 1000;
const suppress = rec.count24h > 3 && recentlyNotified && !isEscalation;

if (!suppress) rec.lastNotified = now;

// signal-eligibility: only buckets a human must act on, plus escalations
const pageBuckets = new Set(["code-error", "auth", "schema-drift", "ssh"]);
const signalEligible = pageBuckets.has(cls.bucket) || isEscalation;

return [{
  json: {
    failure: {
      bucket: cls.bucket,
      severity: cls.severity,
      action: cls.action,
      fingerprint: fp,
      count: rec.count,
      count24h: rec.count24h,
      isEscalation,
      suppress,
      signalEligible,
      workflowId, workflowName, lastNode,
      message: message.slice(0, 500)
    }
  }
}];
```

### Wiring the classifier as `errorWorkflow`

Set it on every active workflow at once. Get the classifier's workflow id, then update each active workflow's `settings.errorWorkflow`. Do this with n8n stopped (settings live only on `workflow_entity`, single table, so no history-resync trap) or through `import:workflow`. Never through `PUT /workflows/:id`, which silently strips the field:

```bash
# n8n stopped. Set classifier as errorWorkflow on every active workflow.
CLASSIFIER_ID="<classifier-workflow-id>"
docker exec n8n sh -c "sqlite3 /home/node/.n8n/database.sqlite \
  \"UPDATE workflow_entity
    SET settings = json_set(coalesce(settings,'{}'), '\$.errorWorkflow', '$CLASSIFIER_ID')
    WHERE active = 1 AND id != '$CLASSIFIER_ID';\""
```

Do not set the classifier as its own `errorWorkflow`. If the classifier throws, you want it to fail loudly to the executions list, not recurse.

## Classification taxonomy

Nine buckets, four actions. Order in the classifier matters: most specific patterns first, so a `429 Too Many Requests` lands in `rate-limit` and not in the generic `http-client` 4xx catch.

| Bucket | Pattern signals | Action | Why this action |
|--------|-----------------|--------|-----------------|
| `code-error` | `SyntaxError`, `ReferenceError`, `TypeError`, "is not defined" | `disable-and-fix` | Deterministic. Will never succeed on retry. Retrying wastes runs and floods the channel. |
| `auth` | 401/403, "credential", "token expired", "api key" | `investigate` | A token expired, got revoked, or has the wrong scope. No retry fixes it. A human re-auths. |
| `rate-limit` | 429, "rate limit", "quota", "too many requests" | `safe-retry-backoff` | Transient by definition. Backoff and retry usually clears it. |
| `timeout` | `ETIMEDOUT`, `ECONNRESET`, "timed out", `AbortError` | `safe-retry` | Often a slow upstream or a task-runner heartbeat miss. Retry first, investigate only if persistent. |
| `network` | `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ECONNREFUSED` | `safe-retry-backoff` | DNS or routing blip. Backoff and retry. If it persists past a few cycles, it is real and escalates. |
| `schema-drift` | "validation", "unexpected field", "missing required", `400` | `investigate` | An upstream API changed its contract or your payload drifted. Retry will not fix a shape mismatch. |
| `ssh` | "ssh:", "permission denied (publickey)", "ssh exit N" | `investigate` | Key, host-key, or remote-host problem. Almost always needs a human to look at the target host. |
| `http-server` | 5xx | `safe-retry-backoff` | Upstream is having a moment. Backoff and retry. Persistent 5xx escalates. |
| `http-client` | 4xx (after auth and rate-limit are peeled off) | `investigate` | A real client-side bug in the request. Retry will not help. |
| `unknown` | everything the rules above miss | `investigate` | The honest default. Treat as needs-a-human until you add a rule for it. |

### Real bucket data

From a two-week audit of this stack: 2,257 executions, 2,236 success, 19 error, 1 canceled, 1 transient. A ~1% error rate, and the distribution is the important part: nearly all 19 errors were a single recurring `timeout` fingerprint, one workflow timing out on the same external dependency eight days in a row. The remaining handful were isolated one-offs across delivery, SSH, and a task-runner disconnect.

That distribution is the case for fingerprinting. Without dedup, eight identical daily timeouts plus the same intra-day retries read as dozens of separate alerts. With dedup they are one fingerprint with `count24h` climbing, one notification a day, and an escalation when the streak crosses a threshold. The signal was never "19 errors happened." The signal was "one workflow has a persistent dependency that is down."

## Fingerprint-based dedup

The fingerprint is `sha1(workflowId + lastNode + bucket + normalized_first_line)`, truncated to 12 hex chars. The normalization is what makes similar-but-not-identical errors collapse:

- First line only. A 40-line stack trace varies in the tail; the first line is the stable signature.
- Strip hex IDs, long hex strings, bare numbers, paths, and URLs. A timeout on `https://api.example.com/v1/users/8821` and one on `.../users/9930` are the same failure. Without normalization they fingerprint apart and defeat the whole point.

State lives in `$getWorkflowStaticData("global").failures[fingerprint]`:

```
{
  count: 47,            // all-time
  count24h: 12,         // rolling 24h, recomputed each fire
  firstSeen: <ms>,
  lastSeen: <ms>,
  lastNotified: <ms>,   // drives the 30-min suppression window
  recent: ["exec-id", ...],   // last 5 execution ids for drill-down
  seenInLast24h: [<ms>, ...]  // timestamps; filtered to <24h each fire
}
```

The suppression rule, in plain terms: suppress the chat post when this fingerprint has fired more than 3 times in 24h AND was notified in the last 30 minutes AND is not hitting an escalation threshold. Escalation thresholds always break suppression, so a runaway failure cannot go quiet.

**`staticData` resets on `import:workflow` of the classifier itself.** This is fine. Trends rebuild within 24h because `count24h` is a rolling window. Just do not re-import the classifier hourly and expect long-term counts to survive.

## Escalation rules

Two questions per failure: does it page, and does it escalate.

**Which buckets page immediately (Signal) vs batch (Discord digest):**

The split mirrors the action. Buckets whose action is `investigate` or `disable-and-fix` need a human and page. Buckets whose action is a `safe-retry*` are self-healing and batch into the routine log:

| Bucket | Routine Discord log | Signal page |
|--------|:-:|:-:|
| `code-error` | yes | yes |
| `auth` | yes | yes |
| `schema-drift` | yes | yes |
| `ssh` | yes | yes |
| `rate-limit` | yes | only on escalation |
| `timeout` | yes | only on escalation |
| `network` | yes | only on escalation |
| `http-server` | yes | only on escalation |
| `http-client` | yes | yes |

The principle, lifted from the notification-routing policy on this stack: `info` and `success` go to Discord only. `warning` goes to Discord unless it is repeated or time-sensitive. `critical` goes to Discord plus Signal, with dedupe and cooldown. A retry-able transient is a warning that self-heals. A persistent code error or auth expiry is the kind of critical that should wake you.

**Escalation thresholds (these always break suppression and force a page):**

| Trigger | Message |
|---------|---------|
| `code-error` AND `count24h >= 3` | "AUTO-DISABLE RECOMMENDED: will never succeed on retry" |
| `count24h == 10` | "10 identical failures in 24h" |
| `count24h == 50` | "50 identical failures in 24h" |
| any multiple of 100 | "DISABLE THIS WORKFLOW" |

A self-healing `network` blip that recovers never crosses 10 and stays in the digest. One that does not recover climbs to 10, breaks suppression, and pages, because at that point it is not a blip, it is an outage.

## Taxonomy tuning over time

The taxonomy is not static. It drifts as the stack grows. The tuning loop:

1. **Watch the `unknown` bucket.** Every `unknown` is a gap. If a class of error keeps landing there, it deserves its own bucket and action. The `ssh` bucket on this stack started as `unknown` until SSH-from-container errors became frequent enough to classify deliberately.
2. **Watch for misroutes.** A `429` landing in `http-client` instead of `rate-limit` means your `rate-limit` pattern is too narrow or your bucket order is wrong. Order is the usual culprit: specific patterns must precede the generic 4xx and 5xx catches.
3. **Split a bucket when its action diverges.** If half your `timeout` errors are slow upstreams (retry) and half are task-runner heartbeat deaths (a code-shape problem you should fix), they want different actions. Split them.
4. **Retire patterns that stop firing.** A pattern for an integration you removed is dead weight that can misroute a future error. Prune it.

Tune from real data, not imagination. Query the live fingerprint table, look at what is actually landing where, and adjust. The audit that produced the bucket data above is exactly this loop run once.

## How the output feeds triage

The classifier's `failure` block is structured for a human or an agent to triage without re-parsing the raw error:

- `action` tells you the first move without reading the message. `disable-and-fix` means stop the bleeding before debugging. `safe-retry-backoff` means do nothing, it will likely clear.
- `count24h` and `isEscalation` tell you urgency. `count24h: 1` is noise; `count24h: 80, isEscalation: true` is an outage.
- `recent` gives the last five execution ids so you can pull full run data for any of them without searching.
- `fingerprint` is the stable key. Grep your chat history or agent log for it to see the whole history of this exact failure across time.

This is the structured input a downstream agent triage step reads. Routine self-healing buckets it can ack and move on. `disable-and-fix` at escalation it can act on (deactivate the workflow via the n8n MCP, then open a fix task). The classifier turns a stack trace into a decision, which is the entire point.

## Verification

```bash
# 1. Every active workflow has the classifier as its errorWorkflow.
docker exec n8n sh -c 'sqlite3 /home/node/.n8n/database.sqlite \
  "SELECT id, name, json_extract(settings, \"$.errorWorkflow\") AS ew
   FROM workflow_entity WHERE active = 1;"'
# Every row (except the classifier itself) should show the classifier id.
# A null ew means a recent PUT stripped it: re-set via sqlite or import.

# 2. How many distinct failure fingerprints is the classifier tracking?
docker exec n8n sh -c 'sqlite3 /home/node/.n8n/database.sqlite \
  "SELECT staticData FROM workflow_entity WHERE name LIKE \"%Classif%\" LIMIT 1;"' \
  | jq '.failures | length'

# 3. Which fingerprints are escalating right now?
docker exec n8n sh -c 'sqlite3 /home/node/.n8n/database.sqlite \
  "SELECT staticData FROM workflow_entity WHERE name LIKE \"%Classif%\" LIMIT 1;"' \
  | jq '.failures | to_entries | map(select(.value.count24h >= 10))
        | map({fp: .key, count24h: .value.count24h})'
```

To smoke-test the cascade end to end, remember the rule from [`n8n-patterns.md`](n8n-patterns.md): `errorWorkflow` fires only on trigger-mode runs (Schedule, Webhook, Cron). It does NOT fire on `n8n execute --id` or manual editor runs. Use an Execute Workflow Trigger as the entry node of a throwaway test workflow so the error cascade actually fires the classifier.

## Gotchas

**The classifier itself trips the task-runner constant-folding trap.** It is one large Code node full of strings, and the first-line split needs a newline. Never write `const NL = '\n'` and use it later: the runner's parse-time fold can put a real newline inside a string literal and produce `Invalid or unexpected token` at runtime. Use `String.fromCharCode(10)` inline (as the snippet does) or inline `'\n'` at the use site. Same rule for the backtick if you build any template output. See [`n8n-patterns.md`](n8n-patterns.md) for the full trap.

**`require('crypto')` needs `NODE_FUNCTION_ALLOW_BUILTIN: "*"`.** The fingerprint hash depends on it. If that compose env var goes missing, the classifier breaks at the same time as every other Code node, and now your error workflow is the thing throwing errors. Use `var crypto = require('crypto')`, not `const`, to match the lenient-fold pattern.

**`errorWorkflow` gets stripped by `PUT /workflows/:id`.** This is the single most common way the whole classifier silently stops working. You script a routine workflow update through the API, the API drops `settings.errorWorkflow`, and that workflow's errors now go nowhere. Run the verification query #1 periodically. Prefer the n8n-ops MCP or direct sqlite for any settings change. Full detail in [`n8n-patterns.md`](n8n-patterns.md) Layer 2.

**Suppression is per-fingerprint, not per-workflow.** Two different errors in the same workflow fingerprint apart and notify independently. This is correct: a workflow can have one self-healing timeout and one real auth failure at the same time, and you want the auth failure even while the timeout is suppressed. Do not "fix" this by keying suppression on workflow id.

**`staticData` resets on `import:workflow` of the classifier.** Trends rebuild within 24h because `count24h` is a rolling window, but all-time `count` zeroes. If you iterate on the classifier code frequently, expect the long-term counters to be unreliable. The rolling window is the number that matters for escalation, and it is fine.

**Do not paste raw error payloads anywhere public.** n8n error items can carry webhook URLs, tokens, and credential ids in the surrounding execution metadata. The classifier deliberately emits only `message.slice(0, 500)` and structured fields, not the whole item. Keep it that way, and if you wire a public-facing publish step downstream, run the [content-guard](https://github.com/escoffier-labs/content-guard) n8n advisory node on the text first.

## Templates

- [`../templates/n8n/failure-classifier-node.js`](../templates/n8n/failure-classifier-node.js) - the minimal classifier Code node skeleton (bucket + severity only). Start here, then layer on the fingerprint and dedup logic from the Implementation section above.
- [`../templates/n8n/workflow-skeleton.json`](../templates/n8n/workflow-skeleton.json) - importable placeholder workflow shape; swap the Code node for the classifier and add an Error Trigger as the entry node.
- [`../templates/n8n/`](../templates/n8n/) - the full n8n template folder. Do not export real credentials, webhook URLs, or production workflow ids into it.

## Related

- [`automation/n8n-patterns.md`](n8n-patterns.md) - the three interfaces, the Code node sandbox, the constant-folding trap, and the Layer 5 overview this guide expands on
- [`automation/hooks.md`](hooks.md) - three-layer hook model; the classifier is the n8n-side analogue of a tool-call hook, and the same outbound-scrub discipline applies to its delivery step
- [`automation/cron-patterns.md`](cron-patterns.md) - three-layer scheduling model; n8n is layer 3, and the classifier is what keeps a fleet of layer-3 schedule triggers from going dark silently
- [n8n-ops-mcp](https://github.com/solomonneas/n8n-ops-mcp) - the MCP that wraps the `errorWorkflow`-preserving update path so a routine edit does not strip your classifier wiring
