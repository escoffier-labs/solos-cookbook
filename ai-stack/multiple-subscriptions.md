# Running an Agent Stack on Multiple Subscriptions

> Five flat-rate subscriptions (Claude, ChatGPT/Codex, Cursor, Gemini through Antigravity, Grok Bot) behind one roster instead of a pile of metered API keys. For an operator who already has the subscriptions and wants predictable monthly cost, plus a plan for the day one of them runs dry.

**Tested on:** Brigade 0.31.0, Claude Code 2.1.316, codex-cli 0.166.0, cursor-agent 2026.10.01-e373342, Antigravity `agy` 1.4.12, T3 Code (`delegate_task`), Ubuntu 24.04 control host
**Last updated:** 2026-11-02

## What this is

I run my agent work on subscriptions I already pay for, each logged in through its own first-party client. No provider API keys are configured for the worker lanes. A Brigade roster maps named seats (`sol61`, `luna6`, `opus55`, `researcher`, and so on) to a harness and a model. Routing defaults decide which seat gets which kind of work, and a handful of scripts and settings tell me when a subscription is running low.

This guide is the operating model: what goes where, how I notice a quota problem, and what has broken. Token rotation and OAuth mechanics are covered in [OAuth and token lifecycle](oauth-token-lifecycle.md). Which model fits which tier is in [multi-model orchestration](multi-model-orchestration.md). Retiring a model id without leaving dead references is in [model retirement and fallbacks](model-retirement-and-fallbacks.md). I link to those instead of repeating them.

## Why this way

| Choice | Upside | Cost |
|--------|--------|------|
| One metered API key per provider | Simple, no login state, easy to call from anywhere | Open-ended spend, and an agent loop that goes wrong bills you for every retry |
| One subscription for everything | One login, one quota to watch | One weekly cap stops the whole fleet at once |
| Several subscriptions behind a roster (what I run) | A cap on any one vendor degrades the fleet instead of stopping it, and each vendor handles the work it is best at | More login state to keep alive, more places to check quota, and a routing table to maintain |

The deciding factor was the cap. Each subscription has a weekly allowance, and heavy parallel work reaches it. With a single vendor that is an outage. With five, it is a roster edit. On 2026-09-08 my OpenAI weekly allowance ran out mid-week. I removed `codex` from the roster's `allow_models`, moved the reviewer and researcher seats to Claude and Gemini, and the fleet kept working until the allowance reset. That edit is the pattern this guide is built around.

I do not use API keys as a fallback for a subscription lane. A key sitting behind an OAuth profile gets used silently once the OAuth side is rate limited, and then you have both a metered bill and a cap you did not see. See gotcha 3.

## Prerequisites

- A control host (Linux, systemd) where the CLIs below are installed and logged in once, interactively
- At least two of the subscriptions below. The routing pattern works with two
- [Brigade](https://github.com/escoffier-labs/brigade) for the roster and `brigade run`. Any dispatcher that can pick a harness and model per task will do, but the roster syntax below is Brigade's
- Optional: T3 Code, if you want child agents started with `delegate_task` instead of `brigade run`
- Comfort reading TOML and shell. No prior Brigade knowledge assumed

## Before / After

**Before:** One orchestrator model doing planning, implementation, review, and research, with bulk work billed per token. A runaway loop meant a surprise invoice, and a hit rate limit meant a stalled session with no spare vendor to move to.

**After:** The lanes below, each with a named owner seat and a known quota check. Day to day, the control host plans and reviews, workers implement, a read-only seat scouts, and a cloud agent takes bounded labeled issues. When a vendor's allowance runs out I change one line and the roster keeps running.

| Subscription | Harness on the control host | What I route there | How I check remaining quota |
|--------------|-----------------------------|--------------------|-----------------------------|
| Claude (first-party login) | `claude` (Claude Code) | Planning and synthesis (`chef`), independent review (`reviewer`, `claude_standby`, `opus55`), bounded test review (`sonnet55`) | The vendor's usage screen. No scripted check. A 429 or "membership benefits" error in a run log is my signal (gotcha 4) |
| ChatGPT / OpenAI (Codex OAuth) | `codex` | Implementation (`coder`, `sol61` on GPT 6.1 Sol), read-only research and triage (`luna6` on GPT 6 Luna), defensive security review (`daybreak`) | The vendor's usage screen. No scripted check. Run receipts show a rising failure rate before I notice by hand |
| Cursor | `cursor-agent` | Retired as a Brigade seat on 2026-10-22. Still installed, and a provider in T3 Code | `cursor-agent status` reports login state only. It was logged out when I checked, so this lane is idle |
| Gemini through Antigravity | `agy` | Read-only research and scouting (`researcher`, `agy_argon`, `agy_flash`) on Gemini 4 Argon | The vendor's usage screen. No scripted check |
| Grok Bot (X Premium plan) | Cloud agent, fed GitHub issues | Bounded, self-contained issues carrying an approval label. Not a Brigade seat | `~/bin/grok-usage`, a small script that prints the billing-period window and weekly percentage |

The seat names `agy_flash` and `researcher` are legacy. After the older Gemini Flash model was disabled they were repointed at Gemini 4 Argon, so all three Antigravity seats run the same model today. I kept the names so existing runbooks still resolve.

## Implementation

### 1. Log in to each client once, as yourself

Each CLI uses its own first-party login. Nothing below needs an API key, and none of these steps put a token in a config file.

```bash
claude auth status      # authMethod claude.ai, apiProvider firstParty
codex login status      # "Logged in using ChatGPT"
cursor-agent status     # only reports whether you are logged in
agy --version
```

Keep one login per vendor per host. Two clients refreshing one OpenAI token invalidate each other (gotcha 1), so I do not copy `~/.codex/auth.json` between tools.

### 2. Describe seats in the roster

The roster is a TOML file. I keep the live one at `~/.brigade/roster.toml`. The fields that matter:

```toml
orchestrator = "chef"
codex_transport = "app-server"

[limits]
scheduler = "dag"
max_workers = 10
timeout_seconds = 1500
# The vendors you currently allow. Removing one disables every seat that uses it.
allow_models = ["codex", "claude", "antigravity", "opencode"]

[agents.sol61]
cli = "codex"
model = "gpt-6.1-sol"
reasoning = "high"
read_only_capable = true
role = "Implement bounded slices with regression evidence."

[agents.luna6]
cli = "codex"
model = "gpt-6-luna"
reasoning = "medium"
read_only_capable = true
role = "Bounded read-only research, issue triage, and test-gap analysis."

[agents.opus55]
cli = "claude"
model = "opus"
read_only_capable = true
role = "Independent architecture and correctness review."

[agents.researcher]
cli = "antigravity"
model = "gemini-4-argon-high"
read_only_capable = true
role = "Read-only research and scouting."
```

The seats I use most, from my live roster: `chef` (Claude Opus, orchestrator), `coder` and `sol61` (Codex, GPT 6.1 Sol), `luna6` (Codex, GPT 6 Luna), `reviewer`, `claude_standby`, `opus55` and `sonnet55` (Claude), `daybreak` (Codex, security review only), and `researcher`, `agy_flash` and `agy_argon` (Antigravity, Gemini 4 Argon).

A seat that names a harness missing from `allow_models` is a hard error and the seat is never skipped. Brigade refuses to start instead of guessing. During the September outage I had to comment the affected seat block out as well as editing `allow_models`.

### 3. Set routing defaults

Routing defaults say which seat gets which kind of work. I read mine from the work brief:

```bash
brigade work brief --target ~/repos/brigade 2>/dev/null | grep -i fleet_
```

```text
fleet_routing: impl=sol61 review=opus55 chef=chef research=luna6 security=daybreak scout=luna6
fleet_routing_notes: Scouting uses Luna 6 medium. ...
fleet_disabled_seats: <a long list of retired and benchmark seats>
fleet_cloud_lanes: claude=off codex=on cursor=off grok-bot=on
```

That one line is the whole policy: implementation to Sol, review to Opus, research and scouting to Luna, security to the Daybreak seat. Gemini seats are not in the defaults. I send them read-only research on request, because their subscription has the most unused headroom and the work is cheap to redo.

`fleet_cloud_lanes` is the on/off switch for cloud workers per vendor. It is how I turn a lane off for everyone at once.

### 4. Dispatch through Brigade or T3 Code

Two doors lead to the same seats:

```bash
# Plan, fan out to workers, synthesize
brigade run "Triage open issues and propose fixes" --read-only

# Skip planning and send the whole task to one seat
brigade run --worker sol61 "Fix the failing parser test in src/parse.py"
```

`brigade run` acquires a repo claim on the fleet hub so two sessions do not edit the same repo. `--wait` queues behind an active run instead of failing, `--worktree` runs the agents in a detached git worktree and writes `changes.patch`, and `--read-only` tells agents to inspect and recommend only. All of these are in `brigade run --help`.

From inside a T3 Code session, `delegate_task` starts a child agent with a task, a role, an isolation mode, and an optional `target` (provider, model, environment). `orchestrator_capabilities` lists which providers and models are callable from where you are. In the environment I queried, Claude, Codex, Cursor, Grok, and OpenCode were callable. Antigravity was listed with "Provider executable is not installed" even though `agy --version` works in my shell, so I send Gemini work through the Brigade seats, not through `delegate_task`.

My rule for choosing a door: `brigade run` when the work is a plan with several workers or needs a receipt, `delegate_task` for one child in a session I am already in.

### 5. Feed the cloud agent bounded issues

Grok Bot works from GitHub issues. I label an issue `grokbot-build-approved` once I have checked that it is self-contained, has a clear finish line, and touches nothing sensitive. The label is the approval. The agent does not pick up unlabeled issues.

It shares one weekly pool with the Grok CLI, so a big batch eats into everything else on that plan:

```bash
~/bin/grok-usage
```

### 6. Respond to a quota event

When a vendor runs out, I do three things, in this order:

1. Remove its harness from `allow_models`.
2. Comment out (do not leave inert) every seat that uses it.
3. Repoint reviewer and researcher seats at a vendor that still has headroom, and write the date and a one-line revert note above the change.

The revert note matters. In September I wrote, above the edit, the exact line to restore, and re-enabled the `daybreak` seat alone on 2026-09-29 after a live run confirmed the allowance had recovered. A dated comment beats trying to remember what you turned off.

## Verification

Check the logins and versions:

```bash
claude --version && codex --version && cursor-agent --version && agy --version
```

```text
2.1.316 (Claude Code)
codex-cli 0.166.0
2026.10.01-e373342
1.4.12
```

```bash
claude auth status | grep -E 'loggedIn|authMethod|apiProvider'
codex login status
cursor-agent status
```

```text
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
Logged in using ChatGPT
Not logged in
```

`apiProvider: firstParty` is what I want to see for Claude: it means a subscription login is in use and no API key is. The `Not logged in` line is Cursor, which matches the idle status in the table.

Validate the roster. Run this from a neutral directory, or pass `--roster` (gotcha 6):

```bash
cd /tmp && brigade roster doctor --roster ~/.brigade/roster.toml | grep -E 'triage|allow_models|researcher model|coder model'
```

```text
triage: 56 checks, 43 ok, 0 warn, 0 failed, 0 manual, 13 info
  [ok]   roster: allow_models          codex, claude, antigravity, opencode
  [ok]   agent: coder model            gpt-6.1-sol via codex
  [ok]   agent: researcher model       gemini-4-argon-high via antigravity
```

Ask whether a specific seat could run an operation right now:

```bash
cd /tmp && brigade roster ready --roster ~/.brigade/roster.toml --worker sol61 --route brigade --json
```

I trimmed the JSON to the fields that matter:

```text
status: unverified    limiting_reason: probe-incomplete    exit_code: 3
declaration            passed
executable-identity    passed
transport-liveness     passed    (app-server initialized and accepted a thread)
authentication-entitlement  unknown  (adapter has no prompt-free authentication status check)
admission              unknown   (observation-missing)
capacity               unknown   (observation-missing)
```

`unverified` is accurate today. Brigade can confirm the binary exists and the transport comes up. It cannot yet prove the account has quota or that the hub would admit the run, so it does not claim `ready`. I treat `blocked` as a hard stop and `unverified` as "go look at the vendor's usage screen". See Planned changes.

Check the cloud agent's pool:

```bash
~/bin/grok-usage
```

```text
weekly period: <start> -> <end>
resets in: 4d 2h 9m
weekly usage: 7.0%
  GrokBot: 4.0%
  GrokBuild: 3.0%
billing mode: unified
prepaid balance: 0
```

Last, confirm the fleet agrees with the roster about what is enabled:

```bash
brigade fleet models | head -8
brigade fleet claims
```

```text
provider   model                                     enabled  limit
google     gemini-4-argon-high                       yes      4
...
(no active fleet claims)
```

`brigade fleet claims` printing `(no active fleet claims)` before you start a run means nothing else holds the repo.

## Planned changes (not shipped yet)

Two Brigade issues cover gaps this guide works around. Neither is deployed, so none of the commands above depend on them.

- **Live seat readiness observations** ([escoffier-labs/brigade#2051](https://github.com/escoffier-labs/brigade/issues/2051)). The readiness evaluator shipped, but the CLI has no authoritative source for live admission and capacity. That is why `roster ready` returns `unverified` above. When this lands, a seat with fresh evidence can return `ready`, and one with a fresh refusal returns `blocked`.
- **Placing subagents on the machine with headroom** ([escoffier-labs/brigade#2166](https://github.com/escoffier-labs/brigade/issues/2166)). Today a `delegate_task` child stays on its parent's machine unless the caller passes an environment, and nothing tells the caller which machine has room. The epic proposes a read-only placement query backed by hub telemetry, kept advisory. Until then I pick the target by hand.

## Gotchas

1. **OpenAI refresh tokens are single use.** If the Codex CLI and a second client (an orchestrator gateway, a desktop app) both hold the same login, whichever refreshes first invalidates the other. The loser gets `401 refresh_token_reused`. I keep one client per host per login and never copy the auth file between tools. Recovery steps are in [OAuth and token lifecycle](oauth-token-lifecycle.md).

2. **Concurrent subagents on one shared Claude profile produce 500s.** Two agents on the same OAuth profile caused `Internal server error` responses on concurrent requests, and the orchestrator's retry logic did not recognize the error shape, so nothing retried. Spread parallel workers across vendors and keep `max_workers` modest, rather than assuming one login scales.

3. **An API-key fallback silently soaks up traffic.** If a key profile sits next to an OAuth profile, the stack can fall onto it once the OAuth side is limited. You then hit the key's limits, or get billed, while the dashboard you are watching stays quiet. Delete key profiles for any vendor you intend to run on a subscription.

4. **A 402 "membership benefits" error is a rate limit and has nothing to do with billing.** It shows up when a fallback chain has exhausted every provider after an OAuth rate limit. Check the chain and the vendor's usage screen before touching a payment page.

5. **A model can hang on one route and work on another.** GPT 6 Luna hangs through OpenCode's OpenAI route on every version I tried, and works through the Codex harness. I enforce that in the roster: Luna only exists on a `cli = "codex"` seat, and a comment above `allow_models` says why. Test every model on each route you plan to use, and write the result next to the seat.

6. **`brigade roster doctor` reads the roster from the current directory.** Run from inside a repo that has its own `.brigade/roster.toml`, it validates that file and skips your live one. My first run from inside the Brigade checkout validated the checkout's roster, which still named a Gemini model I had since disabled. Pass `--roster` or run from a neutral directory.

7. **A disabled harness plus a defined seat is a startup error.** Remove a vendor from `allow_models` and leave its seat block in place, and `brigade run` refuses to start. Comment the whole block out with a dated revert note.

8. **`roster ready` cannot prove entitlement.** The adapters have no prompt-free authentication check, so `authentication-entitlement` stays `unknown` and the overall status stays `unverified`. A passing `roster doctor` means the roster parses and the binaries exist. It says nothing about account quota. Do not read it as quota health.

9. **A shared pool hides who spent it.** Grok Bot and the Grok CLI draw from one weekly pool, shown as two lines in `grok-usage`. Batch a lot of labeled issues into one week and your interactive use gets squeezed. Check the percentage before you add the label to a second batch.

10. **A lane can be logged out without anyone noticing.** My Cursor lane is a retired seat and `cursor-agent status` says `Not logged in`. Nothing complained, because nothing routes there. A lane you do not exercise rots. Either re-run a login check on a schedule or remove the lane from docs and policy.

11. **Seat names outlive their models.** `agy_flash` still carries Flash in its name and runs Gemini 4 Argon. Documents, runbooks, and chat remarks that rely on the name will mislead the next reader. When a model disappears, repoint the seat and add a role line that says what it runs now.

## Templates

- [`../templates/ai-stack/README.md`](../templates/ai-stack/README.md) for the agent roster and model alias fragments for the orchestrator side
- The roster fragment in step 2 above is a drop-in starting point. Replace the seat names with yours and set `allow_models` to the vendors you actually pay for

A minimal quota-event note to paste above the edit, with the date filled in:

```toml
# YYYY-MM-DD: <vendor> weekly allowance exhausted. "<harness>" removed from allow_models
# so runs cannot fan out onto it. Seats <names> commented out below.
# REVERT: restore the original allow_models line and uncomment those seats.
allow_models = ["claude", "antigravity", "opencode"]
```

## Related

- [OAuth and token lifecycle](oauth-token-lifecycle.md) for refresh rotation, per-agent auth state, and the 401 and 402 failure modes
- [Multi-model orchestration](multi-model-orchestration.md) for tiering models by task and blast radius
- [Model retirement and fallbacks](model-retirement-and-fallbacks.md) for sweeping a retired model id and ordering fallbacks
- [Sub-agent patterns](sub-agent-patterns.md) for when to fan work out at all
- [Secret management](../security/secret-management.md) for keeping login state out of repos
- [Brigade](https://github.com/escoffier-labs/brigade) for the roster, `brigade run`, and the fleet hub
- [Brigade roster readiness](https://github.com/escoffier-labs/brigade/blob/main/docs/roster-readiness.md) for the `ready`, `blocked`, and `unverified` outcomes
