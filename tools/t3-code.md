# T3 Code

> Run T3 Code as a headless server on a Linux box so Claude Code and Codex sessions live in one place, then wire Brigade underneath so every session gets the same brief, verification, fleet routing, and memory handoff rules. Free to run (the harnesses use your existing subscriptions), but it adds a handful of timers you have to own.

**Tested on:** T3 Code server 0.1.4-nightly.20261027.3796, Claude Code 2.1.316, Codex CLI 0.166.0, Brigade 0.31.0, Ubuntu 24.04
**Last updated:** 2026-11-02

## What this is

[T3 Code](https://github.com/pingdotgg/t3code) is an app for driving coding agents from multiple providers. It has a desktop client and a server mode. In server mode (`t3 serve`) it owns the threads, the per-thread git worktrees, and the provider processes (Claude Code, Codex, Cursor, and others), and any client that pairs with it sees the same sessions. This guide covers the headless setup I run, and how Brigade attaches to it: hooks inside each harness, a fleet client that routes work between machines, and handoffs that end up in the memory owner.

T3 is the runtime. It does not know about your policy. Brigade is where policy lives. Keeping that split clear is most of the work.

```
 clients (desktop app, browser, phone)
            |
            v
 +---------------------------+
 | T3 server (systemd user)  |  threads, worktrees, preview browser,
 | one per machine           |  delegate_task child tasks
 +---------------------------+
            |  spawns per thread
            v
 +---------------------------+
 | provider harnesses        |  Claude Code, Codex app-server, others
 | (one scope per provider)  |
 +---------------------------+
            |  hooks fire inside each harness
            v
 +---------------------------+     +-----------------------------+
 | Brigade                   |<--->| Fleet Hub (routing, claims, |
 | brief, verify, outcomes   |     | policy, seats) + t3-fleet   |
 +---------------------------+     +-----------------------------+
            |
            v
 memory owner (Memory Handoff in the repo inbox, imported later)
```

## Why this way

| Option | What it costs |
|--------|---------------|
| One terminal per agent in tmux | No shared thread list, no worktree isolation, nothing to hand a phone |
| Each harness's own remote feature | Different UI per provider, no cross-provider child tasks, no shared preview browser |
| T3 server plus Brigade underneath (this guide) | Another daemon, a few timers, and a version gate you have to respect |

I settled on the T3 server because worktree-per-thread is the default there (`defaultThreadEnvMode` is `worktree` in my settings), so two agents on the same repo do not trample each other, and because `delegate_task` lets a Claude parent hand a bounded child to a Codex model without leaving the app.

Brigade stays outside T3 on purpose. T3's own tools can launch threads and children, but they do not apply my routing, admission, or verification rules. If policy lived in T3 prompts it would only hold for the harness that read them. Hooks fire in the harness regardless of how the session started, so a thread launched from a phone gets the same rules as one started in a terminal.

## Prerequisites

- A Linux host with systemd user services (lingering enabled so they survive logout)
- The T3 CLI (`t3`) and at least one authenticated provider CLI (`claude`, `codex`)
- A private network path for clients. I bind to a Tailscale address, but a LAN address or `--tailscale-serve` works too
- [Brigade](https://github.com/escoffier-labs/brigade) installed, with the repo wired (see [Brigade](brigade.md))
- Comfort with systemd units, drop-ins, and `systemctl --user`
- Optional: a second machine running its own T3 server if you want fleet routing

## Before / After

**Before:** agent sessions scattered across terminals and one desktop app. A thread's worktree lived wherever the agent happened to run. A reboot or a closed laptop ended the session. Each provider had its own idea of what a "brief" or a "verify" was, mostly none.

**After:** one server per machine, all threads in one list, each thread in its own worktree under `~/.t3/worktrees/<project>/`. Clients attach and detach freely. Every harness session starts with the Brigade brief injected, runs checks through `brigade work verify run`, and cannot stop cleanly after durable work without a handoff. Cross-machine dispatch goes through `t3-fleet`, which asks Brigade for the machine and seat instead of me picking one.

## Implementation

### 1. The server unit

`~/.config/systemd/user/t3-code.service` runs `t3 serve` bound to one interface:

```ini
[Service]
Type=simple
Environment=T3CODE_NO_BROWSER=1
EnvironmentFile=%h/.config/<your-secrets-file>.env
ExecStart=/bin/bash -lc 'exec "$HOME/.local/bin/t3" serve --no-browser --host "$(/usr/bin/tailscale ip -4)" --port 3773 --base-dir "$HOME/.t3"'
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
```

`--base-dir` is the whole state directory. Under it, `userdata/` holds settings, the owner database, logs, and attachments, and `worktrees/` holds the per-thread checkouts. Run `t3 serve --help` for the full flag list. `t3 auth pairing` mints a one-time token for a new client and `t3 pair` prints it as a QR code.

Then three drop-ins I would not run without:

```ini
# 50-ManagedOOMPreference.conf (created with systemctl set-property)
[Service]
ManagedOOMPreference=avoid

# 70-graceful-runtime.conf
[Service]
KillMode=process
SendSIGKILL=no
```

`KillMode=process` plus `SendSIGKILL=no` means restarting the server signals the server only. Agent processes that are mid-turn keep running in their own scopes. Without it, every restart kills whatever the agents were doing.

### 2. Why the unit pins a versioned path

My real drop-in replaces `ExecStart` with a path into `~/.local/lib/t3-code-cli/<version>/t3`. The nightly updater (below) stages each release side by side and swaps a pointer, so the unit does not run whatever `t3` happens to be on `PATH`. See Gotcha 1.

### 3. Loopback proxy for the fleet client

The fleet client talks to `127.0.0.1:3773`, but the server only listens on the private interface. A second unit bridges them:

```ini
[Unit]
After=t3-code.service
Requires=t3-code.service
PartOf=t3-code.service

[Service]
ExecStart=/usr/bin/ncat --listen --keep-open 127.0.0.1 3773 --sh-exec "/usr/bin/ncat $(/usr/bin/tailscale ip -4) 3773"
Restart=on-failure
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LockPersonality=yes
MemoryDenyWriteExecute=yes
```

`PartOf=` stops and restarts it with the server. The sandboxing flags are cheap because the unit only forwards bytes.

### 4. The timers around it

All are systemd user timers. This is the set I run on the control host:

| Timer | Cadence | What it does |
|-------|---------|--------------|
| `t3-nightly-update` | 03:30 daily (explicit time zone) | Resolves the npm `nightly` tag, refuses it unless the installed `t3-fleet` version gate accepts it, verifies release digests, stages side by side, requires an idle T3 database, backs up databases and pointers, swaps the pointer, restarts, then confirms the new version with a live `t3-fleet doctor`. A failed confirmation restores the old pointer and restarts once. Writes a receipt per run |
| `t3-project-normalize` | 30 min | Renames T3 project titles from each repo's GitHub remote and sets some project icons, so the sidebar shows `owner/repo` instead of a directory name |
| `t3-fleet-settle-sweep` | 10 min | Settles threads of fleet requests that finished long ago, so the sidebar does not fill with dead rows |
| `t3-codex-oom-avoid` | 5 s | Reapplies OOM protection to the shared Codex app-server scope (Gotcha 4) |
| `disk-janitor` | 05:15 daily, 10 min jitter | Prunes old scratch under temp dirs and removes idle clean T3 worktrees (Gotcha 8) |

### 5. How worktrees get made

With `defaultThreadEnvMode` set to `worktree`, each new thread gets a git worktree named `t3-<8 hex>` under `~/.t3/worktrees/<project>/` on a new branch (mine look like `t3/<short-topic>`). The repository's own `git worktree list` shows them next to your normal checkouts:

```
~/repos/<project>                          8886d2e [some-branch]
~/.t3/worktrees/<project>/t3-1a2b3c4d      a2eef96 [t3/short-topic]
```

The canonical checkout is never the thread's working directory, so parallel writers on one repo do not collide. Branches survive worktree removal, so cleanup does not lose commits.

### 6. Brigade hooks in each harness

For Claude Code, the work-loop hooks live in `~/.claude/settings.json`. The events I have wired to the Brigade hook script:

| Event | Matcher | Purpose |
|-------|---------|---------|
| `SessionStart` | all | Inject the `brigade work brief` for the target repo |
| `UserPromptSubmit` | all | Brigade work-loop handler |
| `PreToolUse` | `Bash`, `Edit\|Write\|NotebookEdit` | Block raw test, lint, and build runs and require the verify wrapper |
| `PostToolUse`, `PostToolUseFailure` | edits and `Bash` | Brigade work-loop handler (failures only for `Bash`) |
| `PreCompact` | all | Brigade work-loop handler |
| `Stop` | all | Refuse a clean stop after durable work with no handoff (a small gate script, once per stop attempt) |
| `SessionEnd` | all | Brigade work-loop handler |
| `SubagentStart`, `SubagentStop` | all | Carry the same rules into subagents |

Checks go through the wrapper so they leave a receipt:

```bash
brigade work verify run --target . --command "npm test" --capture brigade-work
```

`brigade work verify plan` shows what would run without running it. A raw `npm test` still works in a plain shell, but the hook blocks it inside a wired session, and a raw run produces no Brigade evidence.

### 7. Fleet routing and `delegate_task`

Two different ways to start child work, with different rules:

- **`delegate_task` (T3-native).** The parent picks the provider and model from `orchestrator_capabilities`, T3 runs the child in-app, and completion notifies the parent. The child gets only the prompt you give it. No parent history. Seat selection here is the parent's choice, so Brigade's Hub routing does not cover it.
- **`t3-fleet submit` (cross-machine).** The local client asks the Fleet Hub for a machine and a seat, checks capacity and admission, and launches work on the target in its own isolated worktree. Commands are `doctor`, `capacity`, `submit`, `status`, `wait`, `followup`, `interrupt`, `approve`, `answer`, `recover`, and `tick`. I pass `--host auto` and omit the seat on an enrolled controller, so the Hub picks both. Naming a host or seat is an override that needs a reason.

Brigade-wired substantial implementation still goes through `brigade run`. T3's app tools are a transport. They do not bypass roster, admission, or privacy rules.

Fleet claims are execution leases. `brigade fleet claims` lists them. An empty list is not proof nobody owns the work, because durable ownership, reservations, and native T3 presence are tracked separately.

### 8. Memory handoffs

Each repo names a memory owner. Sessions on any harness write a Memory Handoff into the repo's inbox (for Claude Code, `.claude/memory-handoffs/`), and the owner imports it later. The Stop gate triggers the handoff without anyone remembering. T3 holds session context and nothing durable.

### 9. Planned, not shipped yet

These are open Brigade issues and are not features yet. Do not build on them.

- [#2046](https://github.com/escoffier-labs/brigade/issues/2046): explicit parallel task batches. A parent that already split the work submits named tasks, T3 runs them as app-owned child tasks, and Brigade keeps routing, admission, claims, budgets, verification, and receipts. Retried submissions with the same caller request ID should return the original task.
- [#2166](https://github.com/escoffier-labs/brigade/issues/2166): `brigade fleet place`. Today a `delegate_task` child stays on its parent's machine unless the caller passes an environment ID, and nothing says which machine has room. The plan is a read-only command that answers from Hub telemetry before you delegate.
- [#2191](https://github.com/escoffier-labs/brigade/issues/2191): the `chef` role is renamed `orchestrator` in the routing contract and Hub policy, with a compatibility path for existing rosters.

## Verification

Server and proxy are up, bound where you expect:

```bash
systemctl --user is-active t3-code.service t3-code-loopback-proxy.service
ss -ltn | awk '/:3773/{print $4}'
```

```
active
active
192.0.2.10:3773
127.0.0.1:3773
```

Which binary is the server actually running (not the one on `PATH`):

```bash
~/.local/lib/t3-code-cli/<version>/t3 --version
```

```
t3 v0.1.4-nightly.20261027.3796
```

Timers are scheduled:

```bash
systemctl --user list-timers 't3-*' 'disk-janitor*' --no-pager --no-legend | awk '{print $NF}'
```

```
t3-codex-oom-avoid.service
t3-fleet-settle-sweep.service
t3-project-normalize.service
t3-nightly-update.service
disk-janitor.service
```

The fleet client sees the machines (host names scrubbed):

```bash
t3-fleet doctor
```

```json
{"action":"doctor","hosts":[
 {"active":8,"host":"control-host","limit":16,"server_version":"0.1.4-nightly.20261027.3796","state":"eligible"},
 {"active":2,"host":"linux-workstation-2","server_version":null,"state":"blocked_offline"},
 {"active":1,"host":"windows-desktop","limit":12,"server_version":"0.1.4-nightly.20261027.3796","state":"eligible"}],
 "schema":"t3-fleet.result.v1","state":"blocked_offline"}
```

Note the top-level `state` is `blocked_offline` while two hosts are eligible. That is expected with one host down (Gotcha 9).

Brigade claims and the brief inside a T3 worktree:

```bash
brigade fleet claims
brigade work brief --target .
```

```
target  node  conductor  harness  session  acquired  expires
(no active fleet claims)
```

```
work brief: ~/.t3/worktrees/<project>/t3-<id>
session_close:
  - [ ] Verify captured through Brigade? (`brigade work verify run --target . --command "..." --capture brigade-work`)
  - [ ] Outcome recorded? (...)
  - [ ] Memory Handoff written when durable knowledge was produced?
branch: t3/<topic>
fleet_routing: impl=sol61 review=opus55 chef=chef research=luna6 security=daybreak scout=luna6
fleet_routing_source: hub revision 292
```

From inside a Claude Code thread, `orchestrator_capabilities` reports the child-task features the server supports:

```json
{"features":{"appOwnedSubagents":true,"asyncPolling":true,"cancellation":true,
 "batchThreadCreation":true,"threadManagement":true,"scheduledTasks":true,"maxBatchThreads":20}}
```

If `brigade work brief` works but the hooks never inject it, check the hook wiring in Gotcha 6.

## Gotchas

1. **`t3 --version` on `PATH` is not the server's version.** My `t3` on `PATH` still reports `0.0.46-nightly` while the service runs `0.1.4-nightly` from a versioned directory. Anything that shells out to bare `t3` (project scripts, the normalizer) hits the old binary. Check the version of the binary named in the unit's `ExecStart`, and keep `t3 update` and the nightly pointer in agreement.

2. **The preview browser reports success on failure.** I audited this on a 0.0.38 nightly. Four rules that held up:
   - Always pass `open: true` to `preview_open`. The `open: false` mode gives a half-dead tab where `preview_snapshot` errors and `preview_click` returns `{}` as if it worked while dispatching no click.
   - Bind dev servers to `0.0.0.0`, not `127.0.0.1` only. The server rewrites explicit loopback URLs to its own bound host, so a loopback-only dev server fails to load while `preview_navigate` returns success with a plausible URL and title and the tab sits on a browser error page.
   - Verify with `preview_evaluate` after every navigate or click, for example `({href: location.href, title: document.title})`. It is the only preview tool that reports accurately in every mode. A missing element and a broken surface produce the same generic failure message.
   - There is no `preview_close`. Tabs opened with `reuseExistingTab: false` leak until the server restarts, so keep the default and stay on one tab.

3. **Tool names change between T3 builds.** The 0.1.3 release folded many tools into action tools (`t3_queue` with an `action`, `preview_act`, and so on). Older servers still advertise the old names. Read the attached tool catalog and its argument schema instead of replaying names from an older guide. A missing name alone does not mean the feature is gone.

4. **A killed Codex app-server does not come back.** On a 0.1.1 nightly, when `systemd-oomd` killed the shared Codex app-server, T3 did not respawn it and every later Codex turn failed with `read-process-exit-status`. `ManagedOOMPreference=avoid` was not enough: it only sorts the scope last, and `systemd-oomd` still picked it first one day. The timer now sets `ManagedOOMPreference=omit` plus `MemoryLow=12G` on `t3code-codex-*.scope` and lowers `oom_score_adj` on its processes. `MemoryLow` caps how much memory is protected and reserves nothing. The timer reapplies this every 5 seconds so new scopes are covered.

5. **The fleet client needs loopback, the server binds to a private interface.** Without the proxy unit, `t3-fleet` cannot reach the local server. Keep the proxy `PartOf=` the server unit so a restart does not leave a listener forwarding to nothing.

6. **`brigade work hooks status` can say "not installed" when hooks are working.** My settings file has Brigade's managed entries interleaved with other handlers, and the status command counts those as foreign. The script version reports current. Trust a real session: the brief shows up at session start and subagent start. If it does not, run `brigade work hooks status --scope user` (the default scope reads the project file, not user settings).

7. **`delegate_task` children start blind.** No parent history is copied. Put the goal, file ownership, constraints, verification command, and terminal state in the prompt. Children inherit the caller's checkout, so give writers disjoint files or serialize them. A `cd` in the prompt does not change the thread's workspace binding.

8. **Worktrees fill the disk.** Agent runs leave worktrees and scratch behind, and `/tmp` and `/var/tmp` lived on the same volume as my home directory. It hit 0 bytes free once. The janitor removes a T3 worktree only if it has been idle more than two days, no process has it as its working directory, and plain `git worktree remove` (no `--force`) succeeds, which git refuses for dirty or untracked trees. The branch ref stays.

9. **An aggregate `blocked_offline` hides eligible hosts.** One offline machine makes `t3-fleet doctor` and `capacity` return `blocked_offline` at the top level. Scope the check with `--host <name>` for the machine you are about to use.

10. **The brief still prints `chef=chef`.** The routing contract has not been renamed yet (see the planned section). Anything parsing the brief should accept both names for now.

11. **A restart is not a clean cut.** With `KillMode=process`, restarting the server leaves running agent scopes alive instead of killing them. That is why the nightly updater refuses to swap unless the T3 database is idle: I do not want a version change landing mid-turn.

## Templates

- [`../templates/cron/systemd-timer.service`](../templates/cron/systemd-timer.service) and [`../templates/cron/systemd-timer.timer`](../templates/cron/systemd-timer.timer): skeletons for the maintenance timers above.
- [`../templates/hooks/claude-code-posttooluse.json`](../templates/hooks/claude-code-posttooluse.json): a PostToolUse hook entry to start from.
- The server unit, the graceful-restart drop-in, and the loopback proxy unit are shown inline in Implementation. Replace the secrets file path and the bind address with your own.

## Related

- [Brigade](brigade.md): installing and wiring the CLI, work loop, and fleet commands
- [Cron Patterns](../automation/cron-patterns.md): which scheduling layer to use for the timers here
- [Multi-Model Orchestration](../ai-stack/multi-model-orchestration.md): how work is split across providers
- [Sub-Agent Patterns](../ai-stack/sub-agent-patterns.md): when a child task pays off
- [T3 Code](https://github.com/pingdotgg/t3code): upstream project and release notes
- [Brigade on GitHub](https://github.com/escoffier-labs/brigade): issues [#2046](https://github.com/escoffier-labs/brigade/issues/2046), [#2166](https://github.com/escoffier-labs/brigade/issues/2166), [#2191](https://github.com/escoffier-labs/brigade/issues/2191)
