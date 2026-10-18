# Claude Code via tmux Relay

How to let OpenClaw drive Claude Code through an interactive tmux session, both for second-opinion review and for scripted one-shot calls, keeping Claude in its first-party harness rather than treating it as a raw backend.

**Tested on:** Claude Code 2.1.302 with first-party login, Claude Opus 5.5 (`--model opus`), tmux 3.4, OpenClaw 2026.10.4 host workflow
**Last updated:** 2026-10-17

> **Security warning:** Never put `CLAUDE_CODE_OAUTH_TOKEN` (or any credential) on a tmux command line. `tmux new-session -e CLAUDE_CODE_OAUTH_TOKEN=...` and `tmux new-session 'CLAUDE_CODE_OAUTH_TOKEN=... claude'` both place the value in process arguments, where every local `ps` listing and any captured process tree can read it. An earlier version of this guide, and my own relay script, did exactly that. See [Handling the OAuth token](#handling-the-oauth-token) for the safe patterns.

There are two lanes here:

1. **Interactive review sessions.** A long-lived named tmux session you send prompts to and capture answers from. Good for second opinions and cross-review.
2. **One-shot relay.** A script that spins up a throwaway tmux session per request, gets the answer as a JSON envelope, and tears the session down. It is a drop-in replacement for `claude -p --output-format json` that does not depend on print mode at all. One-liner wrappers and cron jobs call it.

The first lane is the original pattern. The second is what kept the whole `claude -p` script ecosystem alive during the June 2026 print-mode outage, and it is still the lane I use for OpenClaw-side Claude one-shots.

## What this is

Claude Code can run as a normal interactive terminal app inside tmux. OpenClaw or another local orchestrator can then:

- start a named tmux session
- send prompts with `tmux send-keys` or `tmux paste-buffer`
- capture output with `tmux capture-pane`
- keep Claude Code inside Anthropic's first-party harness and login path

This is a good Claude escalation lane for code review and architecture review when you want a real, recoverable second opinion. ACP still has a place when you explicitly need an ACP endpoint (see [Running Claude Code in OpenClaw via ACP](acp-claude-code.md)), but the tmux relay is simpler to inspect, easier to recover, and closer to how Claude Code is meant to be used.

## Which lane for which caller

The rule on my host, in one place:

| Caller | Lane |
|---|---|
| OpenClaw scripts, cron jobs, and agent exec calls that need a Claude one-shot | The one-shot relay below. I do not use bare `claude -p` for OpenClaw tool use |
| A headless reviewer or worker dispatched from a coding harness | `claude --print --model opus --disallowedTools Task Agent`, prompt on stdin, one flat pass |
| A person or orchestrator wanting an attachable, recoverable review session | The interactive tmux lane below |
| An explicit ACP endpoint | [ACP via ACPX](acp-claude-code.md) |

The two print-mode rows do not contradict each other. They have different callers. The headless worker row follows my dispatch policy: Opus only, no `Task` or `Agent` tools, so one invocation cannot fan out. The OpenClaw row exists because of a concrete failure: in mid-2026, bare `claude -p` run from spawned environments returned `401 Invalid authentication credentials` on this host while the interactive login worked, and long jobs had no way to report back. The relay fixes both. If you are not on OpenClaw, `claude -p` may be all you need.

## History: why the relay exists

In April 2026, direct Claude subscription OAuth through third-party harnesses stopped being reliable. ACPX was the first working repair because it launched Claude Code instead of impersonating it.

In June 2026, print-mode automation hit a second problem. Anthropic changed how `claude -p` usage was metered, and on my host `claude -p --output-format json` started failing auth (`401` on print mode while interactive sessions still worked). A late-June note in an earlier revision of this guide said Anthropic had reverted the change. I did not rebuild around that note. Bare `claude` from spawned environments kept returning 401s on my host into August 2026, so the relay stayed the one-shot path for OpenClaw callers. OpenClaw's own docs currently say that `claude -p` and Agent SDK usage draw from the signed-in subscription's limits and that Anthropic can change this without notice, so check `claude auth status` if cost matters.

The lesson is that Claude Code should stay in Claude Code. That keeps:

- Claude Code's login and entitlement checks inside the first-party harness
- permission prompts and trust prompts visible in a real terminal
- review sessions recoverable with `tmux attach`
- one-shot review possible through prompt files without print mode

## Why this way

The old post-April fix was "run Claude Code through ACPX." That avoided direct third-party OAuth use, but it turned Claude Code into a subprocess endpoint and pushed people toward one-shot print-mode habits.

The tmux relay keeps the interaction model honest:

| Need | tmux relay behavior |
|------|---------------------|
| First-party auth | Claude Code owns its login in `~/.claude/` |
| Human recovery | Attach with `tmux attach -t <session>` |
| OpenClaw control | Use ordinary shell tools to start, send, capture, and stop |
| Review safety | Launch in `--permission-mode plan` for read-only critique |
| Coding smoke tests | Use `--permission-mode acceptEdits` only in contained workspaces |
| One-shot prompts | Paste a prompt file into the session instead of `claude -p` |

The orchestrator is not pretending Claude is a stateless model. It is delegating to the Claude Code harness and collecting the result.

## Prerequisites

- `tmux`
- Claude Code installed and logged in interactively
- a trusted local workspace
- optional OpenClaw scripts or skills that wrap the tmux commands

Verify Claude Code is using the first-party provider:

```bash
claude auth status | jq '{loggedIn, apiProvider}'
```

Expected:

```json
{
  "loggedIn": true,
  "apiProvider": "firstParty"
}
```

The `authMethod` field in the same output shows how you logged in (`claude.ai` for a browser login, `oauth_token` when an environment token is driving it). Do not copy token values into notes, prompts, issues, or public docs.

## Before / After

**Before:** OpenClaw routes Claude work through direct Claude backends, `claude -p`, or ACPX one-shots. Recovery is awkward, permission prompts can fail in non-interactive sessions, and the review lane is easy to confuse with a normal model backend.

**After:** Claude Code runs in a named tmux session. OpenClaw sends bounded review prompts, captures the answer, and uses the result as review evidence. Codex and Claude can review each other's work without sharing one context window or bypassing either harness.

## Handling the OAuth token

Freshly spawned `claude` processes read `~/.claude/.credentials.json` when no `CLAUDE_CODE_OAUTH_TOKEN` is set. In clean contexts (systemd units, cron, non-login shells) people often added an explicit token to the relay because the credentials file had gone stale. The risk is in how the token gets there.

**What leaks.** Any of these puts the secret in process arguments:

```bash
# DO NOT DO THIS
tmux new-session -d -s review -e "CLAUDE_CODE_OAUTH_TOKEN=$TOKEN" 'claude --model opus'
tmux new-session -d -s review "CLAUDE_CODE_OAUTH_TOKEN=$TOKEN claude --model opus"
```

While the tmux client runs, `ps -eo args` and `/proc/<pid>/cmdline` show the full value to every local user and to any tool that prints a process tree. If a transcript or log captured a process listing during a relay run, treat that token as exposed and rotate it. The `-e` form looks safer than putting it in the command string because the value stays out of the pane's visible command line, but it is still argv.

**Pattern 1: inject nothing.** Keep the login fresh, keep stale environment tokens out of the relay's environment, and let Claude Code use its own credentials file. This works from cron and systemd as long as the unit runs as the same OS user with the same `HOME`. It is the safest option because there is no second copy of the secret to protect. Note that an exported `CLAUDE_CODE_OAUTH_TOKEN` overrides the credentials file, so an old token left in a profile or secrets render will silently win. See [the auth boundary](acp-claude-code.md#the-auth-boundary).

**Pattern 2: a 0600 env file read inside the session.** If you do need an explicit token, store it in a file only your user can read, and have the shell inside tmux read it. Only the file path appears in argv:

```bash
# one-time: create the file with tight permissions before the secret goes in
install -m 600 /dev/null "$HOME/.config/claude-relay.env"
# then add the line CLAUDE_CODE_OAUTH_TOKEN=<token> with your secret manager or an editor

tmux new-session -d -s claude-code-review \
  'set -a; . "$HOME/.config/claude-relay.env"; set +a; cd /path/to/repo && claude --model opus --permission-mode plan --name openclaw-review'
```

The [wrapper template](../templates/ai-stack/claude-tmux-relay.sh) does this when you set `CLAUDE_TOKEN_FILE`, and it refuses a file that is not mode 600 or 400.

**Pattern 3: stdin.** If the secret comes from a secret manager and you do not want a file at all, pipe it into the tmux server's session environment over stdin, then start Claude in a pane spawned after that. `source-file -` reads tmux commands from stdin, and `printf` is a shell builtin, so the value never appears in any process's arguments:

```bash
tmux new-session -d -s claude-code-review 'sleep 3600'
tok="$(your-secret-manager read claude-code-oauth-token)"   # command substitution, not argv of a long-lived process
printf 'set-environment -t claude-code-review CLAUDE_CODE_OAUTH_TOKEN %s\n' "$tok" | tmux source-file -
unset tok
tmux respawn-pane -k -t claude-code-review:0.0 \
  'cd /path/to/repo && claude --model opus --permission-mode plan --name openclaw-review'
```

I checked on tmux 3.4 with a stand-in program that the respawned process sees the variable and that no process listing contains it. The session environment is still readable by your own user through `tmux show-environment`, so this protects against `ps` exposure, not against code running as you.

**Whatever you choose:**

- Do not print broad process trees (`ps aux`, `pstree -a`) around relay jobs, and do not paste them into tickets.
- Keep the token out of prompts, pane captures, and relay result files.
- Rotate any token that was ever visible in a process listing or retained transcript.
- Scrub `capture-pane` output before you store it. A relay error includes the pane tail, and a pane can echo whatever the launch command printed.

## Implementation

### 1. Start a review session

Use `plan` mode for second-opinion review:

```bash
tmux new-session -d -s claude-code-review \
  'cd /path/to/repo && claude --model opus --permission-mode plan --name openclaw-review'
```

On first launch in a new workspace, Claude Code may stop at the trust prompt. Attach once and answer it manually:

```bash
tmux attach -t claude-code-review
```

Detach with `Ctrl-b` then `d`.

### 2. Send a prompt

For a short prompt:

```bash
tmux send-keys -t claude-code-review:0.0 -l -- \
  "Review the current git diff for correctness, security risk, missing tests, and unclear assumptions. Return findings first with file paths and line numbers where possible. Do not edit files."
tmux send-keys -t claude-code-review:0.0 Enter
```

For a longer prompt, write it to a local file and paste it into the tmux session:

```bash
tmux load-buffer /tmp/claude-review-prompt.txt
tmux paste-buffer -t claude-code-review:0.0 -d
tmux send-keys -t claude-code-review:0.0 Enter
```

That is still an interactive Claude Code session. It is not `claude -p`.

### 3. Capture the result

```bash
tmux capture-pane -t claude-code-review:0.0 -p -S -200
```

For long reviews, capture the full pane:

```bash
tmux capture-pane -t claude-code-review:0.0 -p -S -
```

Save captured output as a local review artifact, not as canonical memory. Promote only durable lessons or verified fixes through your normal handoff process.

### 4. Use a wrapper script

A public-safe wrapper lives at [`../templates/ai-stack/claude-tmux-relay.sh`](../templates/ai-stack/claude-tmux-relay.sh). Copy or adapt it into your private workspace scripts:

```bash
CLAUDE_TMUX_SESSION=claude-code-review \
CLAUDE_WORKSPACE=/path/to/repo \
CLAUDE_PERMISSION_MODE=plan \
templates/ai-stack/claude-tmux-relay.sh start

templates/ai-stack/claude-tmux-relay.sh send \
  "Review the current git diff. Findings first. Do not edit files."

templates/ai-stack/claude-tmux-relay.sh capture -200
```

## One-shot relay: print-mode behavior without print mode

If you build a one-shot bridge that drives the real TUI through tmux and emits the same JSON envelope your callers already parse, no caller depends on print mode. The bridge I run is a single Python script, `claude-tmux-oneshot.py`, kept under `~/.openclaw/vendor/`. It does this per request:

1. **Spawn a throwaway session.** Name it `<prefix>-<pid>-<timestamp>` so concurrent calls never collide, and launch `claude --model <model> --permission-mode <mode> --name <session>` in the requested working directory. An optional `--effort low|medium|high` is passed through to `claude`.
2. **Auto-answer the trust prompt only.** Poll `capture-pane` for the folder-trust prompt text and send Enter once. Nothing else gets auto-approved.
3. **Ask for the answer as a file, not chat.** Wrap the user prompt with an instruction that the task is not complete until the model uses its Write tool to put ONLY the final answer at an exact temp file path. Chat output scrolls, wraps, and interleaves with the TUI. A file is unambiguous. The file lives in a per-run directory under `<cwd>/.claude-tmux-results/` and is deleted afterward, so add that directory to `.gitignore`.
4. **Paste, then submit with `C-m`.** Send the prompt via `load-buffer` + `paste-buffer`, sleep briefly, then `send-keys C-m`. A symbolic `Enter` after a bracketed paste sometimes leaves the text sitting at the prompt. `C-m` has been reliable.
5. **Poll the result file for stability.** Wait until the file exists, is non-empty, and its size has been stable for a second. Claude may write incrementally.
6. **Refuse permission prompts.** If the pane shows `Do you want to proceed?` or `Do you want to create`, fail with the pane tail in the error instead of auto-approving. A one-shot text task should never need tool escalations beyond the single Write.
7. **Emit the envelope.** Print `{"is_error": false, "result": "<file contents>", ...}` on success and `{"is_error": true, "result": "<reason>", "pane_tail": "..."}` on failure, then kill the session. Existing `claude -p --output-format json` callers keep working unchanged.

Defaults in mine: model `opus`, permission mode `acceptEdits`, 600 second request timeout, 30 second startup timeout, `--keep-session` to leave the tmux session up for debugging, and `--prompt-file` to read the prompt from a file instead of stdin.

### Detached mode with durable report-back

For calls made from an agent turn, a synchronous relay is the wrong shape: the turn can end, or the gateway can restart, before Claude finishes. The bridge takes `--report-to <channel>:<target>` (for example `discord:channel:<channel-id>`). With it set, the call:

1. Validates the destination, writes the prompt to a temp file, and re-launches itself as a transient `systemd-run --user --collect` unit, then returns `{"detached": true, "job_id": ...}` immediately. The unit lives outside the gateway's cgroup, so a gateway restart cannot kill in-flight work.
2. Runs the normal relay inside that unit. On success or failure, the worker drops the outcome (including a `Relay job failed: ...` message) into an on-disk outbox directory as a small JSON file.
3. An independent `relay-outbox.timer` fires a flush script on a short interval. The script delivers each pending entry with `openclaw message send --channel <channel> --target <target> --message <body> --json`, retries a bounded number of times (five by default), truncates bodies to fit Discord's 2000 character limit, and moves entries to `delivered/` or `failed/`.

Because the outbox and the timer are independent of the gateway process, delivery survives restarts, and it does not depend on the model remembering to report back. Synchronous mode (no `--report-to`) stays the default for cron and shell scripts.

## One-liner wrappers

With the bridge in place, task-specific one-liners are plain bash: build a system prompt, feed stdin or a file through the relay, gate on the envelope, print `.result`. The pattern:

```bash
#!/usr/bin/env bash
# opus-rewrite - one-shot Claude text task via the tmux relay
set -euo pipefail
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

TMUX_RELAY="${CLAUDE_TMUX_RELAY:-$HOME/.openclaw/vendor/claude-builder/claude-tmux-oneshot.py}"
RELAY_MODEL="opus"
RELAY_TIMEOUT="${OPUS_RELAY_TIMEOUT:-600}"

SYSTEM_PROMPT="You are a precise rewriting assistant. Output ONLY the rewritten text, no commentary."

# stdin, file, or --prompt "text"
if [[ "${1:-}" == "--prompt" ]]; then
  shift; CONTENT="$*"
elif [[ -n "${1:-}" ]] && [[ -f "$1" ]]; then
  CONTENT=$(cat "$1")
elif [[ ! -t 0 ]]; then
  CONTENT=$(cat)
else
  echo "Usage: opus-rewrite [file | --prompt 'text' | stdin]" >&2; exit 1
fi

ENVELOPE=$(printf '%s\n\n%s' "$SYSTEM_PROMPT" "$CONTENT" \
  | timeout $((RELAY_TIMEOUT + 60)) "$TMUX_RELAY" \
      --model "$RELAY_MODEL" \
      --cwd "$HOME/workspace" \
      --timeout "$RELAY_TIMEOUT" \
      --session-prefix "opus-rewrite")

if [[ "$(jq -r 'if .is_error == false then "ok" else "err" end' <<<"$ENVELOPE" 2>/dev/null || echo err)" != "ok" ]]; then
  echo "opus-rewrite: relay error: $(jq -r '.result // empty' <<<"$ENVELOPE" | head -c 300)" >&2
  exit 1
fi

RESULT=$(jq -r '.result // empty' <<<"$ENVELOPE")
[[ -n "$RESULT" ]] || { echo "opus-rewrite: empty result" >&2; exit 1; }
printf '%s\n' "$RESULT"
```

A handful of task-specific wrappers in `~/bin` follow this exact shape, and cron jobs call them like any other shell command, with the relay timeout raised for batch work. When a task contract pins reasoning effort, add `--effort medium` (or `low` / `high`) to the relay call.

Watch the jq gate. `jq '.is_error // true'` looks right and is wrong: `//` fires on `false` as well as `null`, so a successful envelope (`is_error: false`) reads as an error. Compare explicitly with `if .is_error == false`.

Wrapper migration is per-script surgery. Every script that shells out to `claude --print` or `claude -p` from an OpenClaw context keeps failing until it moves onto the relay, and the failures look like auth problems, not code problems. Inventory them (`grep -l 'claude.*-p\|--print' ~/bin/*`) and migrate the ones you use first.

## OpenClaw agent usage

OpenClaw should treat Claude Code tmux as a tool lane, not as the main model or a fallback model.

Start or reuse the session from an OpenClaw shell-capable tool, cron job, or private skill:

```bash
CLAUDE_TMUX_SESSION=claude-code-review \
CLAUDE_WORKSPACE=/path/to/repo \
CLAUDE_PERMISSION_MODE=plan \
templates/ai-stack/claude-tmux-relay.sh start
```

Send a bounded review prompt:

```bash
templates/ai-stack/claude-tmux-relay.sh send \
  "Review the current git diff for correctness, security risk, missing tests, and unclear assumptions. Findings first. Do not edit files."
```

Capture the pane and summarize the actionable findings back into the OpenClaw turn:

```bash
templates/ai-stack/claude-tmux-relay.sh capture -300
```

For longer prompts, write a local prompt file and use `send-file`:

```bash
templates/ai-stack/claude-tmux-relay.sh send-file /tmp/claude-review-prompt.txt
```

For a review that may outlive the turn, use the one-shot relay with `--report-to` instead of polling a pane.

Do not put Claude Code in `agents.defaults.model.fallbacks`. The fallback chain is for compatible model backends, not an interactive review harness.

## Codex usage

Codex can use the same relay after it implements or reviews a change. The loop:

1. Codex makes the change and runs the normal tests.
2. Codex writes a review prompt that includes the task, acceptance criteria, and current diff focus.
3. Codex sends that prompt to Claude Code through tmux.
4. Codex captures Claude's response, validates each finding, applies only the real fixes, and reruns tests.

Example from a Codex repo session:

```bash
git diff --stat > /tmp/claude-review-prompt.txt
printf '\nReview this change. Findings first. Do not edit files.\n' >> /tmp/claude-review-prompt.txt

CLAUDE_TMUX_SESSION=claude-code-review \
CLAUDE_WORKSPACE="$PWD" \
CLAUDE_PERMISSION_MODE=plan \
templates/ai-stack/claude-tmux-relay.sh start

templates/ai-stack/claude-tmux-relay.sh send-file /tmp/claude-review-prompt.txt
templates/ai-stack/claude-tmux-relay.sh capture -300
```

If Claude reports a finding, Codex owns the verification. Claude's output is review evidence, not an automatic patch.

## Codex + Claude cross-review

Use two independent harnesses when the work deserves adversarial review:

1. Codex implements or reviews the first pass in its normal repo harness.
2. OpenClaw sends Claude Code a tmux prompt asking for read-only review of the diff, plan, or test failure.
3. OpenClaw captures Claude's findings as a local artifact.
4. Codex reviews Claude's findings, rejects weak ones, fixes valid ones, and runs tests.
5. For high-risk changes, send the final diff back through Claude Code in `plan` mode for a final read-only pass.

Prompt shape:

```text
You are the independent reviewer. Review the current git diff only.

Focus on:
- correctness bugs
- security risk
- missing tests
- behavior changes not reflected in docs
- assumptions the implementing agent may have missed

Return only actionable findings first. Include file paths and line numbers when possible.
Do not edit files.
```

This keeps each harness honest. Codex gets the fast build/test loop. Claude Code gets a bounded second-opinion lane. OpenClaw owns routing, evidence, and memory handoff.

## Verification

Run a no-tools probe:

```bash
tmux new-session -d -s claude-code-tmux-test \
  'cd /path/to/repo && claude --model opus --permission-mode plan --name openclaw-tmux-test'

tmux send-keys -t claude-code-tmux-test:0.0 -l -- "Reply exactly: TMUX_OK. Do not use tools."
tmux send-keys -t claude-code-tmux-test:0.0 Enter

tmux capture-pane -t claude-code-tmux-test:0.0 -p -S -100
```

Expected result: the captured pane includes `TMUX_OK`. Clean up with `tmux kill-session -t claude-code-tmux-test`.

Check the one-shot relay envelope the same way:

```bash
echo "Reply exactly: RELAY_OK" | ~/.openclaw/vendor/claude-builder/claude-tmux-oneshot.py --model opus --cwd /tmp/relay-probe | jq '{is_error, result, transport}'
# Expected: {"is_error": false, "result": "RELAY_OK", "transport": "claude-code-tmux"}
```

Confirm no token is exposed in process arguments while a relay session is running (prints a count of matching command lines, not the values). If this returns a nonzero count, do not paste the offending lines anywhere. Fix the launch path and rotate the token:

```bash
ps -eo args | grep 'CLAUDE_CODE_OAUTH_TOKEN=' | grep -v grep | wc -l
# Expected: 0. Anything higher means a launch command is carrying the token in argv.
```

Confirm the safe-injection wrapper path (with a stand-in binary, no real token): create a mode 600 file with a dummy value, set `CLAUDE_TOKEN_FILE` and `CLAUDE_BIN` to a script that writes `${CLAUDE_CODE_OAUTH_TOKEN:-unset}` to a file, run `claude-tmux-relay.sh start`, and check that the file holds the dummy value while the dummy value is in no `ps` line. A mode 644 file must be refused.

For a contained coding smoke test, create a scratch directory and use `acceptEdits` only there:

```bash
mkdir -p /tmp/claude-tmux-coding-test
tmux new-session -d -s claude-code-tmux-code-test \
  'cd /tmp/claude-tmux-coding-test && claude --model opus --permission-mode acceptEdits --name tmux-code-test'
```

Do not use `acceptEdits` in a production repo unless that is the explicit task.

## Gotchas

1. **The token must never be on the tmux command line.** `-e CLAUDE_CODE_OAUTH_TOKEN=...` and inline `VAR=value claude` both leak through `ps`. Use the credentials file, a 0600 env file sourced inside the session, or stdin. Rotate anything that was exposed. See [Handling the OAuth token](#handling-the-oauth-token).

2. **A fresh workspace may block on the trust prompt.** Attach once, answer the prompt, then detach. The one-shot relay answers only that prompt automatically.

3. **`tmux ls` exits non-zero when no server exists.** Scripts should treat that as "no sessions yet," not as a broken host.

4. **Plan mode is the default for review, and it can stall a one-shot.** It keeps Claude in a critique lane and avoids surprise edits, but a plan-mode review can stop at Claude Code's implementation approval screen instead of writing the result file. The relay refuses permission prompts, so that surfaces as an error with the pane tail rather than a hang. For headless one-shots, give the task a bounded timeout and read the pane tail on failure.

5. **One-shot does not have to mean print mode.** For interactive sessions, use a prompt file plus `tmux paste-buffer`. For scripted callers, the one-shot relay avoids print mode entirely.

6. **Capture output is evidence, not memory.** Review artifacts can be noisy. Promote only durable, verified facts through memory handoffs.

7. **Keep ACPX documented as an explicit compatibility lane.** Some OpenClaw setups still need ACP. Do not present ACPX as the only path to Claude Code.

8. **`jq '.is_error // true'` is a bug.** The `//` alternative operator treats `false` like `null`, so a healthy envelope reads as an error. Use `if .is_error == false then ... end`. This one shipped and bit me.

9. **Submit pasted prompts with `C-m`, not `Enter`.** After a bracketed paste, a symbolic `Enter` sometimes leaves the prompt text unsubmitted in the TUI input. A short sleep then `send-keys C-m` submits reliably.

10. **Never auto-approve tool permission prompts in the one-shot lane.** The bridge auto-answers exactly one prompt, folder trust, and fails loudly with the pane tail on anything else. A text task that suddenly wants shell access is a prompt-injection smell, not an inconvenience to click through.

11. **A terminal refusal screen looks like a timeout.** My bridge has no detection for a subscription-refusal or login-expired screen, so those surface as a startup or result timeout with the pane tail in the error. Read the tail before retrying.

12. **Add `.claude-tmux-results/` to `.gitignore`.** The one-shot relay creates it under the working directory. It deletes each run directory afterward, but a crash can leave one behind.

13. **Wrapper migration is per-script (historical, June 2026).** When print mode died, it broke each `claude -p` caller individually with what looked like an auth flake. The inventory command in the wrapper section is the recovery playbook if it happens again.

## Templates

- [`../templates/ai-stack/claude-tmux-relay.sh`](../templates/ai-stack/claude-tmux-relay.sh) - start, send, send-file, capture, and stop helpers for a named Claude Code tmux session, with an optional 0600 token-file mode

## Related

- [`multi-model-orchestration.md`](multi-model-orchestration.md) - where the Claude review lane fits in the full stack
- [`acp-claude-code.md`](acp-claude-code.md) - ACPX compatibility path for setups that need ACP, and the auth boundary
- [`oauth-token-lifecycle.md`](oauth-token-lifecycle.md) - token rotation and recovery across providers
- [`sub-agent-patterns.md`](sub-agent-patterns.md) - orchestration and escalation patterns
- [`../tools/brigade.md`](../tools/brigade.md) - installable workspace and review loop support
