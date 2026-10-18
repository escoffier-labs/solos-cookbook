# Model Retirement and Fallbacks

> When a model id is retired or an alias changes, a long-lived agent stack with dozens of cron jobs and several agents can break silently. This is the playbook for finding every place a model id hides, sweeping them all on a retirement, and ordering fallback chains so a failure lands somewhere sane.

**Tested on:** OpenClaw 2026.4.x through 2026.10.4, a stack with two named agents plus 36 cron jobs, gateway-managed cron store, GPT 6.1 Sol orchestrator on the Codex runtime, Claude seats and a Brigade worker roster
**Last updated:** 2026-10-17

---

## What This Is

Frontier providers retire model ids on their own schedule. An alias gets repointed, a coding model is deprecated, a provider sunsets last quarter's flagship. In a one-shot setup you notice immediately because the next prompt errors in your face. In a long-lived multi-agent stack you do not, because most of the model references are buried in config and scheduled jobs that run unattended at 3am.

This guide is the maintenance routine for that world. It covers where model ids hide, why retirement breaks things quietly, the sweep to run on every model change, and how to order fallback chains so a primary failure degrades to something you actually chose.

## Why Retirement Breaks Silently

Three things conspire to make a retired model id a quiet failure instead of a loud one.

1. **The references are scattered.** A single model id can appear in an agent's primary slot, that same agent's fallback list, a second agent's config, a heartbeat model, an alias map, and a dozen cron payloads. Updating one and missing the rest leaves a stack that mostly works, which is worse than a stack that obviously does not.

2. **The failures land off-screen.** A retired id pinned in a cron payload fails inside an isolated session that nobody is watching. On some orchestrators that screams into a delivery channel. On others it is one line in a boot log you were not tailing. Either way the interactive path keeps working, so you assume the stack is healthy.

3. **A fallback chain hides the wound.** If the primary model is retired but a fallback still resolves, requests quietly hop to the fallback and keep succeeding. The stack looks fine while running on a model you did not intend, at a quality or cost you did not choose. The classic version of this: a single provider 503 pins a channel to its fallback, and it stays pinned long after the provider recovers.

The fix for all three is the same discipline: treat a model id like a hardcoded constant that lives in many files, and sweep every one of them on every retirement.

## Prerequisites

- Admin access to your orchestrator config (for OpenClaw, `~/.openclaw/openclaw.json`) and, if you run a worker fleet, its roster (`~/.brigade/roster.toml`).
- Your orchestrator's cron CLI. On recent versions the cron store is gateway-managed and hand-editing the old `jobs.json` no longer works. See [openclaw-cron-deep-dive](../automation/openclaw-cron-deep-dive.md).
- `jq` for reading config and cron output as JSON.
- A way to read the gateway/boot log to confirm which model actually loaded.

## Where Model Ids Hide

This is the full inventory. A retirement sweep that misses any row leaves a silent break.

| Location | What lives there | What retirement does |
|---|---|---|
| Agent primary model | `agents.defaults.model.primary` and per-agent `agents.entries.<id>.model.primary` | A literal retired id fails on every turn for that agent. An alias reference survives if you repoint the alias. |
| Agent fallbacks | `agents.defaults.model.fallbacks` and per-agent `fallbacks` (ordered lists) | A retired id in the chain is skipped or errors depending on the orchestrator. A retired *first* fallback silently relocates failures to the next entry. An *empty* list means there is no relocation at all, see below. |
| Model allowlist | `agents.defaults.modelPolicy.allow` | A model that is not on the list is refused. Retire an id and forget the list, and the replacement is blocked while the dead id still looks permitted. |
| Heartbeat model | `agents.defaults.heartbeat.model` | Every heartbeat cycle fails or falls back. Quiet, because heartbeats are designed to be low-noise. |
| Sub-agent default | `agents.defaults.subagents.model` | Every spawned sub-agent without its own model inherits this. |
| Alias map and runtime | `agents.defaults.models` keys, `alias` values, and each entry's `agentRuntime` | The single point of indirection. Repointing one alias re-aims every reference that used it. The `agentRuntime` on the entry (for example `codex` or `claude-cli`) must also suit the new model. |
| Per-agent model maps | `agents.entries.<id>.models` | Overrides the defaults map for that agent. Easy to miss because it is not in `defaults`. |
| Cron payloads | each job's `payload.model` in the cron store | The biggest blast radius. One retired alias pinned across many jobs takes them all out at once. Jobs with no `payload.model` inherit the default. |
| ACP endpoints and wrapper scripts | `acp.allowedAgents` and the ACPX plugin's `agents.<name>.command` entries | A wrapper script can hardcode a model id. Retiring the id leaves the endpoint name alive and the model dead. |
| Worker roster seats | `model` in each `[agents.<seat>]` block of the Brigade roster | A seat that names a retired model fails at dispatch, or worse, at 3am from a scheduled run. |
| Local CLI wrappers and skills | shell wrappers, skills, and sub-agent spawns that hardcode a model | Easy to forget because they are not in the central config. Grep the workspace and your `bin` directory for the dead id. |

The takeaway from this table is the one design decision that pays off forever: **prefer alias references over literal model ids everywhere you can.** If your agents, heartbeat, and cron jobs all point at `sol61` instead of `openai/gpt-6.1-sol`, a retirement is a one-line edit to the alias target in `agents.defaults.models`. Everything downstream re-points itself. Literal ids scattered across twenty jobs are twenty edits and at least one you will miss.

## The Retirement Sweep

Run this every single time a model id is retired or an alias target changes. Do not trust that "it only affects one agent" until you have checked every row in the table.

### 1. Identify the dead id and its replacement

Write down the exact retired id and the exact replacement, including provider prefix. Retiring `openai/gpt-6-sol` in favor of `openai/gpt-6.1-sol` is a different edit than retiring an alias target.

### 2. Repoint the alias map first

If the retired id is referenced through an alias, this is the highest-value edit. An alias hangs off a model entry in `agents.defaults.models`. Add the new entry with the same alias, then remove the old one:

```json
{
  "agents": {
    "defaults": {
      "models": {
        "openai/gpt-6.1-sol": { "alias": "sol61", "agentRuntime": { "id": "codex" } },
        "openai/gpt-6-luna":  { "alias": "luna6", "agentRuntime": { "id": "codex" } }
      },
      "modelPolicy": {
        "allow": ["openai/gpt-6.1-sol", "openai/gpt-6-luna"]
      }
    }
  }
}
```

Every agent, heartbeat, and cron job that referenced `sol61` now resolves to the new id. Update `modelPolicy.allow` in the same edit, and check the new entry's `agentRuntime`. The CLI manages aliases without hand-editing: `openclaw models aliases list`, `add`, and `remove`.

### 3. Sweep literal ids in agent config

Find any place a literal retired id is pinned instead of an alias:

```bash
grep -n "gpt-6-sol" ~/.openclaw/openclaw.json
jq '.agents.defaults.model, .agents.defaults.heartbeat.model, .agents.defaults.subagents.model' ~/.openclaw/openclaw.json
jq '.agents.entries | map_values(.model)' ~/.openclaw/openclaw.json
```

Replace the primary, every fallback entry, the heartbeat model, the sub-agent default, and any per-agent literal or per-agent `models` map that still names the dead id.

### 4. Sweep the cron store with the CLI, not the file

This is the one most people miss, and it is the one with the widest blast radius. Cron jobs pin a model in `payload.model`. On a gateway-managed cron store you cannot hand-edit the file. List as JSON, find every job still on the dead id, and edit each job through the CLI:

```bash
# Count jobs by pinned model (null means the job inherits the default)
openclaw cron list --json \
  | jq '.jobs | map(.payload.model) | group_by(.) | map({model: .[0], jobs: length})'

# Find every job pinned to the retired id
openclaw cron list --json \
  | jq -r '.jobs[] | select((.payload.model // "") == "openai/gpt-6-sol") | "\(.id)\t\(.name)"'
```

The output is an object with a `jobs` array, plus `total` and `hasMore`. Check `hasMore` is `false` before trusting a count. On my box the first command prints 21 jobs with a null model (they inherit the default) and 15 pinned to Luna.

Then edit each job through the cron CLI: `openclaw cron get <id>` to inspect, `openclaw cron edit <id> --model <alias>` to repoint, or `--clear-model` to drop the override and inherit the default. Do not try to patch the store on disk. The gateway owns it and will overwrite or ignore your edit.

A real instance of why this matters: roughly 22 cron jobs were all pinned to a single model alias that got retired. Every one of them failed on its next scheduled run. Because they were isolated background jobs, nothing in the interactive path complained. The fix was a single sweep of `payload.model` across the whole cron store, done in one pass before the next scheduled fire.

### 5. Sweep skills, wrappers, ACP scripts, and roster seats

Grep the places that sit outside the central config:

```bash
grep -rn "gpt-6-sol" ~/.openclaw/workspace/ ~/.openclaw/vendor/ ~/bin/ 2>/dev/null
grep -n "model" ~/.brigade/roster.toml
```

Repoint anything that turns up. ACP wrapper scripts and `~/bin` helpers are where I find hardcoded ids most often. In the Brigade roster, a seat with a retired model is easiest to catch with `brigade fleet models list`.

### 6. Restart and verify

Restart the gateway so the new config and alias map load, then run the verification below before you call it done.

## Designing Fallback Chains

Fallback chains are tried in order. That single fact drives every rule here.

**Put the preferred fallback first.** If your primary hiccups, the request takes the first entry in the chain that resolves. If a worse or off-subscription model sits at the top of the list, a transient primary failure silently relocates your traffic there and keeps it there. Order the chain the way you would actually choose under degradation: best acceptable substitute first, last resort last.

**Keep the chain on providers you actually run.** Every entry is a model that can serve real traffic without warning. An entry pointing at a provider you no longer pay for, or a model you never validated, is a quality and cost surprise waiting for the next primary blip. If two of your models share one subscription, a hop between them does not change your billing surface, but it also shares the same quota, so it does not help in a quota event.

**Prefer alias references in the chain too.** A fallback list of literal ids is just more places a retirement can rot. Aliases in the chain mean the next retirement is still a one-line alias edit.

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-6.1-sol",
        "fallbacks": ["anthropic/claude-sonnet-5-5"]
      }
    }
  }
}
```

A single, deliberately ordered fallback beats a long speculative chain. Each extra entry is one more model that has to stay valid and one more place to sweep on the next retirement. Manage the list with `openclaw models fallbacks list`, `add`, `remove`, and `clear`.

### The Empty Chain: My Own Stack Is the Example

My live config is the other half of this problem. `agents.defaults.model.fallbacks` is `[]`, every agent entry has `fallbacks: []`, and `openclaw models fallbacks list` prints `Fallbacks (0)`. The primary is `openai/gpt-6.1-sol`, and `agents.defaults.modelPolicy.allow` lists exactly five models.

That is the case this guide's opening warns about, with the sign flipped. A hidden fallback hides a dead primary, and no fallback means a dead primary is loud, but it also means one provider outage or one quota event stops the main agent, the sub-agents, and every cron job that inherits the default. Nothing relocates the traffic.

What I do to cope until I decide on a chain:

- The allowlist, not the fallback list, is the guard against a typo or a stale id.
- The worker fleet is the pressure valve for quota events. A Brigade roster can route a task to a Claude or Gemini seat when the OpenAI pool is exhausted. That covers work I dispatch, not the gateway's own turns.
- I check the boot line after every restart (below) because there is no fallback to mask a mistake.

If you copy anything from my config, copy the allowlist and the aliases. Decide on a fallback chain on purpose instead of copying the empty one.

## Verification

After any sweep, prove the dead id is gone and the right model loaded. Do not assume.

```bash
# 1. The retired id must not appear anywhere in config
grep -rn "gpt-6-sol" ~/.openclaw/openclaw.json ~/.openclaw/workspace/ 2>/dev/null
# Expected: nothing (substitute the id you retired).

# 2. No cron job still references it
openclaw cron list --json \
  | jq -r '.jobs[] | select((.payload.model // "") | test("gpt-6-sol")) | .name'
# Expected: nothing. Any name printed is a job that will fail on its next run.

# 3. Agent config resolves to the expected model, and you know your fallback state
jq '.agents.defaults.model, .agents.defaults.heartbeat.model, .agents.defaults.modelPolicy.allow' ~/.openclaw/openclaw.json
openclaw models fallbacks list
# Expected on my stack: "Fallbacks (0)" and "- none". Expected on yours: the chain you chose.

# 4. The boot/gateway log shows the model you intended
#    Look for the agent model line after restart and confirm it names the
#    new id, not the retired one and not a silent fallback.
journalctl --user -u openclaw-gateway -n 200 | grep -i "agent model"
# Expected: [gateway] agent model: openai/gpt-6.1-sol (thinking=medium, fast=on)
# The boot line only proves the default. A long-lived channel session can still
# carry a sticky model override, so check the sessions you care about too:
openclaw sessions --active 1440 --json | jq -r '.sessions[] | "\(.key) \(.modelProvider)/\(.model)"'
# Expected: no session still naming the retired id

# 5. Worker roster seats still name live models
brigade fleet models list
```

The boot line is the load-bearing check. A stack can pass the grep checks and still be running on a fallback if a primary auth or quota problem is masking the retirement. Reading the actual loaded-model line is the only way to confirm you are where you think you are.

## Gotchas

1. **Sticky auto-override survives a reset.** A single provider 503 can pin a channel to its fallback through an "auto" model override, and that override does not always clear on a plain reset. The channel keeps running on the fallback long after the provider recovers. The reliable clear is an explicit model pin on that channel, not a reset. If a channel seems stuck on the wrong model after an incident, check for an active override before re-debugging the chain.

2. **Loud on one orchestrator, quiet on another.** The same retired-id failure can scream into a delivery channel on one setup and emit a single boot-log line on another. Do not calibrate your monitoring to the loud case. Assume retirement failures are silent and build the sweep as a routine, not a reaction to an alert.

3. **Alias reference versus literal id.** This is the difference between a one-line fix and a stack-wide hunt. An alias survives a retirement if you move it to the new model entry. A literal id has to be found and replaced in every location. Standardize on aliases before you have dozens of references, not after.

4. **A healthy-looking stack can be running degraded.** A surviving fallback hides a retired primary. "Nothing is erroring" is not "everything is on the right model." Only the boot line tells you the truth. The inverse also holds: with no fallback chain, an error is the only signal you will get, so alert on it.

5. **Cron is the widest blast radius and the easiest to forget.** Agent config is in front of you when you edit. Cron payloads are not. Most retirement misfires I have seen were a cron sweep that did not happen. Make the `openclaw cron list --json` filter the first command you run, not the last.

6. **An empty fallback list is also a decision.** Mine is empty and it is easy to stop noticing. Put `openclaw models fallbacks list` in the sweep so the state is read every time, even when it has not changed.

## Related

- [multi-model-orchestration](multi-model-orchestration.md) - how the model tiers and fallback chain are assigned in the first place.
- [openclaw-cron-deep-dive](../automation/openclaw-cron-deep-dive.md) - the gateway-managed cron store and why you sweep it with the CLI, not the file.
- [cron-patterns](../automation/cron-patterns.md) - model assignment per cron job and the silent-failure modes to watch.
- [oauth-token-lifecycle](oauth-token-lifecycle.md) - the other quiet way a long-lived stack loses its primary model: auth, not deprecation.
