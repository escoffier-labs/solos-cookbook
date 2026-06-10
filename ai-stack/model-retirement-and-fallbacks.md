# Model Retirement and Fallbacks

> When a model id is retired or an alias changes, a long-lived agent stack with dozens of cron jobs and several agents can break silently. This is the playbook for finding every place a model id hides, sweeping them all on a retirement, and ordering fallback chains so a failure lands somewhere sane.

**Tested on:** OpenClaw 2026.4.x through 2026.6.2, a stack with several named agents plus 20+ active cron jobs, gateway-managed cron store, OpenAI Codex Pro orchestrator with a Codex fallback, ACP Opus escalation lane
**Last updated:** 2026-06-10

---

## What This Is

Frontier providers retire model ids on their own schedule. A `:cron` alias gets repointed, a coder model is deprecated, a provider sunsets last quarter's flagship. In a one-shot setup you notice immediately because the next prompt errors in your face. In a long-lived multi-agent stack you do not, because most of the model references are buried in config and scheduled jobs that run unattended at 3am.

This guide is the maintenance routine for that world. It covers where model ids hide, why retirement breaks things quietly, the sweep to run on every model change, and how to order fallback chains so a primary failure degrades to something you actually chose.

## Why Retirement Breaks Silently

Three things conspire to make a retired model id a quiet failure instead of a loud one.

1. **The references are scattered.** A single model id can appear in an agent's primary slot, that same agent's fallback list, a second agent's config, a heartbeat model, an alias map, and a dozen cron payloads. Updating one and missing the rest leaves a stack that mostly works, which is worse than a stack that obviously does not.

2. **The failures land off-screen.** A retired id pinned in a cron payload fails inside an isolated session that nobody is watching. On some orchestrators that screams into a delivery channel. On others it is one line in a boot log you were not tailing. Either way the interactive path keeps working, so you assume the stack is healthy.

3. **A fallback chain hides the wound.** If the primary model is retired but a fallback still resolves, requests quietly hop to the fallback and keep succeeding. The stack looks fine while running on a model you did not intend, at a quality or cost you did not choose. The classic version of this: a single provider 503 pins a channel to its fallback, and it stays pinned long after the provider recovers.

The fix for all three is the same discipline: treat a model id like a hardcoded constant that lives in many files, and sweep every one of them on every retirement.

## Prerequisites

- Admin access to your orchestrator config (for OpenClaw, `~/.openclaw/openclaw.json`).
- Your orchestrator's cron CLI. On recent versions the cron store is gateway-managed and hand-editing the old `jobs.json` no longer works. See [openclaw-cron-deep-dive](../automation/openclaw-cron-deep-dive.md).
- `jq` for reading config and cron output as JSON.
- A way to read the gateway/boot log to confirm which model actually loaded.

## Where Model Ids Hide

This is the full inventory. A retirement sweep that misses any row leaves a silent break.

| Location | What lives there | What retirement does |
|---|---|---|
| Agent primary model | `agents.defaults.model.primary` and per-agent `agents.list[].model` | A literal retired id fails on every turn for that agent. An alias reference survives if you repoint the alias. |
| Agent fallbacks | `agents.defaults.model.fallbacks` (ordered list) | A retired id in the chain is skipped or errors depending on the orchestrator. A retired *first* fallback silently relocates failures to the next entry. |
| Heartbeat model | `agents.defaults.heartbeat.model` | Every heartbeat cycle fails or falls back. Quiet, because heartbeats are designed to be low-noise. |
| Alias map | `agents.defaults.models` keys and `alias` values | The single point of indirection. Repointing one alias re-aims every reference that used it. Forgetting it means literal references drift out of sync. |
| Cron payloads | each job's `payload.model` in the cron store | The biggest blast radius. One retired alias pinned across many jobs takes them all out at once. |
| Skills and tool lanes | any skill or sub-agent spawn that hardcodes a model | Easy to forget because it is not in the central agent config. Grep the workspace for the dead id. |

The takeaway from this table is the one design decision that pays off forever: **prefer alias references over literal model ids everywhere you can.** If your agents, heartbeat, and cron jobs all point at `gpt55` and `gpt55cron` instead of `openai-codex/gpt-5.5`, a retirement is a one-line edit to the alias target in `agents.defaults.models`. Everything downstream re-points itself. Literal ids scattered across twenty jobs are twenty edits and at least one you will miss.

## The Retirement Sweep

Run this every single time a model id is retired or an alias target changes. Do not trust that "it only affects the coder" until you have checked all six locations.

### 1. Identify the dead id and its replacement

Write down the exact retired id and the exact replacement, including provider prefix. `openai-codex/gpt-5.3-codex` retiring to `openai-codex/gpt-5.5` is a different edit than retiring an alias target.

### 2. Repoint the alias map first

If the retired id is referenced through an alias, this is where the leverage is. Edit the alias target once in `agents.defaults.models`:

```json
{
  "agents": {
    "defaults": {
      "models": {
        "openai-codex/gpt-5.5": { "alias": "gpt55", "params": { "thinking": "medium" } },
        "openai-codex/gpt-5.5:cron": { "alias": "gpt55cron", "params": { "thinking": "low" } }
      }
    }
  }
}
```

Every agent, heartbeat, and cron job that referenced `gpt55` or `gpt55cron` now resolves to the new id. This is the entire reason to use aliases.

### 3. Sweep literal ids in agent config

Find any place a literal retired id is pinned instead of an alias:

```bash
grep -n "gpt-5.3-codex" ~/.openclaw/openclaw.json
jq '.agents.defaults.model, .agents.defaults.heartbeat.model' ~/.openclaw/openclaw.json
jq '.agents.list | map({id, model})' ~/.openclaw/openclaw.json
```

Replace the primary, every fallback entry, the heartbeat model, and any per-agent literal that still names the dead id.

### 4. Sweep the cron store with the CLI, not the file

This is the one most people miss, and it is the one with the widest blast radius. Cron jobs pin a model in `payload.model`. On a gateway-managed cron store you cannot hand-edit the file. List as JSON, find every job still on the dead id, and edit each job through the CLI:

```bash
# Find every job pinned to the retired id
openclaw cron list --json \
  | jq -r '.[] | select(.payload.model == "openai-codex/gpt-5.3-codex") | .name'

# Same, but catch alias references too if you ever pinned aliases in payloads
openclaw cron list --json \
  | jq -r '.[] | select(.payload.model | test("gpt-5.3-codex|gpt53")) | "\(.id)\t\(.name)\t\(.payload.model)"'
```

Then edit each job's model through the cron CLI (`openclaw cron get <id>` to inspect, the edit command to update `payload.model`). Do not try to patch the legacy `jobs.json` on disk; the gateway owns the store and will overwrite or ignore your edit.

A real instance of why this matters: roughly 22 cron jobs were all pinned to a single model alias that got retired. Every one of them failed on its next scheduled run. Because they were isolated background jobs, nothing in the interactive path complained. The fix was a single sweep of `payload.model` across the whole cron store, done in one pass before the next scheduled fire.

### 5. Sweep skills and spawn lanes

Grep the workspace for any skill or sub-agent spawn that hardcodes the retired id outside the central config:

```bash
grep -rn "gpt-5.3-codex" ~/.openclaw/workspace/
```

Repoint anything that turns up.

### 6. Restart and verify

Restart the gateway so the new config and alias map load, then run the verification below before you call it done.

## Designing Fallback Chains

Fallback chains are tried in order. That single fact drives every rule here.

**Put the preferred fallback first.** If your primary hiccups, the request takes the first entry in the chain that resolves. If a worse or off-subscription model sits at the top of the list, a transient primary failure silently relocates your traffic there and keeps it there. Order the chain the way you would actually choose under degradation: best acceptable substitute first, last resort last.

**Keep the chain on providers you actually run.** Every entry is a model that can serve real traffic without warning. An entry pointing at a provider you no longer pay for, or a model you never validated, is a quality and cost surprise waiting for the next primary blip. If two of your models share one subscription, a hop between them does not change your billing surface, which makes them safe chain-mates.

**Prefer alias references in the chain too.** A fallback list of literal ids is just more places a retirement can rot. Aliases in the chain mean the next retirement is still a one-line alias edit.

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai-codex/gpt-5.5",
        "fallbacks": [
          "openai-codex/gpt-5.3-codex"
        ]
      }
    }
  }
}
```

A single, deliberately ordered fallback on the same subscription beats a long speculative chain. Each extra entry is one more model that has to stay valid and one more place to sweep on the next retirement.

## Verification

After any sweep, prove the dead id is gone and the right model loaded. Do not assume.

```bash
# 1. The retired id must not appear anywhere in config
grep -rn "gpt-5.3-codex" ~/.openclaw/openclaw.json ~/.openclaw/workspace/
# Expected: nothing.

# 2. No cron job still references it
openclaw cron list --json \
  | jq -r '.[] | select(.payload.model | test("gpt-5.3-codex|gpt53")) | .name'
# Expected: nothing. Any name printed is a job that will fail on its next run.

# 3. Agent config resolves to the expected model
jq '.agents.defaults.model, .agents.defaults.heartbeat.model' ~/.openclaw/openclaw.json

# 4. The boot/gateway log shows the model you intended
#    Look for the agent model line after restart and confirm it names the
#    new id, not the retired one and not a silent fallback.
journalctl --user -u openclaw-gateway -n 50 | grep -i "agent model"
```

The boot line is the load-bearing check. A stack can pass the grep checks and still be running on a fallback if a primary auth or quota problem is masking the retirement. Reading the actual loaded-model line is the only way to confirm you are where you think you are.

## Gotchas

1. **Sticky auto-override survives a reset.** A single provider 503 can pin a channel to its fallback through an "auto" model override, and that override does not always clear on a plain reset. The channel keeps running on the fallback long after the provider recovers. The reliable clear is an explicit model pin on that channel, not a reset. If a channel seems stuck on the wrong model after an incident, check for an active override before re-debugging the chain.

2. **Loud on one orchestrator, quiet on another.** The same retired-id failure can scream into a delivery channel on one setup and emit a single boot-log line on another. Do not calibrate your monitoring to the loud case. Assume retirement failures are silent and build the sweep as a routine, not a reaction to an alert.

3. **Alias reference versus literal id.** This is the difference between a one-line fix and a stack-wide hunt. An alias survives a retirement if you repoint its target; a literal id has to be found and replaced in every location. Standardize on aliases before you have dozens of references, not after.

4. **A healthy-looking stack can be running degraded.** A surviving fallback hides a retired primary. "Nothing is erroring" is not "everything is on the right model." Only the boot line tells you the truth.

5. **Cron is the widest blast radius and the easiest to forget.** Agent config is in front of you when you edit; cron payloads are not. Most retirement misfires I have seen were a cron sweep that did not happen. Make the `openclaw cron list --json` filter the first command you run, not the last.

## Related

- [multi-model-orchestration](multi-model-orchestration.md) - how the model tiers and fallback chain are assigned in the first place.
- [openclaw-cron-deep-dive](../automation/openclaw-cron-deep-dive.md) - the gateway-managed cron store and why you sweep it with the CLI, not the file.
- [cron-patterns](../automation/cron-patterns.md) - model assignment per cron job and the silent-failure modes to watch.
- [oauth-token-lifecycle](oauth-token-lifecycle.md) - the other quiet way a long-lived stack loses its primary model: auth, not deprecation.
