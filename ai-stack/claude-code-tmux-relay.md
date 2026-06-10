# Claude Code via tmux Relay

How to let OpenClaw drive Claude Code through an interactive tmux session, both for second-opinion review and for scripted one-shot calls, without using `claude -p` or treating Claude as a raw backend.

**Tested on:** Claude Code first-party OAuth, Opus 4.8, tmux, OpenClaw 2026.6.2 host workflow
**Last updated:** 2026-06-10

There are two lanes here:

1. **Interactive review sessions** - a long-lived named tmux session you send prompts to and capture answers from. Good for second opinions and cross-review.
2. **One-shot relay** - a script that spins up a throwaway tmux session per request, gets the answer as a JSON envelope, and tears the session down. This is the drop-in replacement for `claude -p --output-format json` when print mode is blocked, and it is what one-liner wrappers and cron jobs call.

The first lane is the original pattern. The second is what made the whole `claude -p` script ecosystem survive print mode dying.

## What this is

Claude Code can run as a normal interactive terminal app inside tmux. OpenClaw or another local orchestrator can then:

- start a named tmux session
- send prompts with `tmux send-keys` or `tmux paste-buffer`
- capture output with `tmux capture-pane`
- keep Claude Code inside Anthropic's first-party harness and OAuth path

This is the preferred Claude escalation lane for code review and architecture review when you want a real second opinion from Claude Code but do not want to call `claude -p`.

ACP still has a place when you explicitly need an ACP endpoint, but the tmux relay is simpler to inspect, easier to recover, and closer to how Claude Code is meant to be used.

## The June 2026 lesson

The lesson is not just "tmux works." The real lesson is that Claude Code should stay in Claude Code.

In April 2026, direct Claude subscription OAuth through third-party harnesses stopped being reliable. ACPX was the first working repair because it launched Claude Code instead of impersonating it.

By the June 2026 notes, `claude -p` / print-mode automation had a second problem: it drew from Claude's separate **Usage** bucket. If OpenClaw or Codex needs Claude, drive an interactive Claude Code session through tmux instead of shelling out to `claude -p`.

That keeps:

- Claude Code's OAuth and entitlement checks inside the first-party harness
- permission prompts and trust prompts visible in a real terminal
- review sessions recoverable with `tmux attach`
- one-shot review possible through prompt files without using print mode

## Why this way

The old post-April-2026 fix was "run Claude Code through ACPX." That avoided direct third-party OAuth use, but it still turned Claude Code into a subprocess endpoint and often pushed users toward one-shot print-mode habits.

The tmux relay keeps the interaction model honest:

| Need | tmux relay behavior |
|------|---------------------|
| First-party auth | Claude Code owns OAuth in `~/.claude/` |
| Human recovery | Attach with `tmux attach -t <session>` |
| OpenClaw control | Use ordinary shell tools to start, send, capture, and stop |
| Review safety | Launch in `--permission-mode plan` for read-only critique |
| Coding smoke tests | Use `--permission-mode acceptEdits` only in contained workspaces |
| One-shot prompts | Paste a prompt file into the existing session instead of `claude -p` |

The orchestrator is not pretending Claude is just another stateless model. It is delegating to the Claude Code harness and collecting the result.

## Prerequisites

- `tmux`
- Claude Code installed and logged in interactively
- a trusted local workspace
- optional OpenClaw scripts or skills that wrap the tmux commands

Verify Claude Code is using the first-party provider:

```bash
claude auth status
```

The useful fields are:

```json
{
  "loggedIn": true,
  "authMethod": "oauth_token",
  "apiProvider": "firstParty"
}
```

Do not copy token values into notes, prompts, issues, or public docs.

## Before / After

**Before:** OpenClaw routes Opus work through direct Claude backends, `claude -p`, or ACPX one-shots. Recovery is awkward, permission prompts can fail in non-interactive sessions, and the review lane is easy to confuse with a normal model backend.

**After:** Claude Code runs in a named tmux session. OpenClaw sends bounded review prompts, captures the answer, and uses the result as review evidence. Codex and Claude can review each other's work without sharing one context window or bypassing either harness.

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

For a longer one-shot prompt, write the prompt to a local file and paste it into the tmux session:

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

If your scripts used to call `claude -p --output-format json` and that path now fails auth (`401` on print mode while interactive sessions still work, which is exactly what happened on this stack in June 2026), you do not have to rewrite every caller. Build a one-shot bridge that drives the real TUI through tmux and emits the same JSON envelope the callers already parse.

The bridge does this per request:

1. **Spawn a throwaway session.** Name it `<prefix>-<pid>-<timestamp>` so concurrent calls never collide, launch `claude --model <model> --permission-mode <mode>` in the requested working directory.
2. **Auto-answer the trust prompt only.** Poll `capture-pane` for the folder-trust prompt text and send Enter once. Nothing else gets auto-approved.
3. **Ask for the answer as a file, not chat.** Wrap the user prompt with an instruction that the task is not complete until the model uses its Write tool to put ONLY the final answer at an exact temp file path. Chat output scrolls, wraps, and interleaves with the TUI; a file is unambiguous.
4. **Paste, then submit with `C-m`.** Send the prompt via `load-buffer` + `paste-buffer`, sleep briefly, then `send-keys C-m`. A symbolic `Enter` after a bracketed paste sometimes leaves the text sitting at the prompt; `C-m` has been reliable.
5. **Poll the result file for stability.** Wait until the file exists, is non-empty, and its size has been stable for a second. Claude may write incrementally.
6. **Refuse permission prompts.** If the pane shows `Do you want to proceed?` or similar, fail with the pane tail in the error instead of auto-approving. A one-shot text task should never need tool escalations beyond the single Write; if it asks, something is wrong.
7. **Emit the envelope.** Print `{"is_error": false, "result": "<file contents>", ...}` on success, `{"is_error": true, "result": "<reason>"}` on failure, then kill the session. Existing `claude -p` callers keep working unchanged.

Two robustness details that earn their keep:

- **Load the OAuth token explicitly.** Freshly spawned `claude` processes fall back to `~/.claude/.credentials.json` (which can be expired) when `CLAUDE_CODE_OAUTH_TOKEN` is absent, and it is absent in clean contexts: systemd units, cron, non-login shells. Have the bridge read the token from your env file and export it before launching, so the relay works the same from any caller.
- **Detached mode for agent callers.** For calls made from an agent turn, add a mode that re-launches the bridge as a transient `systemd-run --user --collect` unit and returns `{"detached": true, "job_id": ...}` immediately. The unit lives outside the gateway's cgroup, so a gateway restart cannot kill in-flight work; an independent outbox timer delivers the result to the requesting channel. Synchronous mode stays the default for cron and shell scripts.

## One-liner wrappers

With the bridge in place, task-specific one-liners become trivial bash: build a system prompt, feed stdin or a file through the relay, gate on the envelope, print `.result`. The pattern:

```bash
#!/usr/bin/env bash
# opus-rewrite - one-shot Opus text task via the tmux relay
set -euo pipefail
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

TMUX_RELAY="$HOME/.local/share/agent-scripts/claude-tmux-oneshot.py"
RELAY_MODEL="claude-opus-4-8"
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

On this stack a handful of task-specific wrappers in `~/bin` follow this exact shape, and cron jobs call them like any other shell command, with the relay timeout bumped for batch work.

Watch the jq gate carefully. `jq '.is_error // true'` looks right and is wrong: `//` fires on `false` as well as `null`, so a successful envelope (`is_error: false`) would read as an error. Compare explicitly with `if .is_error == false`.

One migration note: converting wrappers is per-script surgery. Every script that shells out to `claude --print` or `claude -p` keeps failing until it is moved onto the relay, and the failures look like auth problems, not code problems. Inventory your wrappers (`grep -l 'claude.*-p\|--print' ~/bin/*`) and migrate the ones you actually use first.

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

For longer prompts, OpenClaw should write a local prompt file and use `send-file`:

```bash
templates/ai-stack/claude-tmux-relay.sh send-file /tmp/claude-review-prompt.txt
```

Do not put Claude Code in `agents.defaults.model.fallbacks`. The fallback chain is for compatible model backends, not an interactive review harness.

## Codex usage

Codex can use the same relay after it implements or reviews a change. The useful loop is:

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

Expected result: the captured pane includes `TMUX_OK`.

For a contained coding smoke test, create a scratch directory and use `acceptEdits` only there:

```bash
mkdir -p /tmp/claude-tmux-coding-test
tmux new-session -d -s claude-code-tmux-code-test \
  'cd /tmp/claude-tmux-coding-test && claude --model opus --permission-mode acceptEdits --name tmux-code-test'
```

Do not use `acceptEdits` in a production repo unless that is the explicit task.

## Gotchas

1. **A fresh workspace may block on the trust prompt.** Attach once, answer the prompt, then detach.

2. **`tmux ls` exits non-zero when no server exists.** Scripts should treat that as "no sessions yet," not as a broken host.

3. **Plan mode is the default for review.** It keeps Claude in a critique lane and avoids surprise edits.

4. **One-shot does not mean print mode.** For interactive sessions, use a prompt file plus `tmux paste-buffer`. For scripted callers, use the one-shot relay bridge above. Do not call `claude -p` on this host.

5. **Capture output is evidence, not memory.** Review artifacts can be noisy. Promote only durable, verified facts through memory handoffs.

6. **Keep ACPX documented as an explicit compatibility lane.** Some OpenClaw setups still need ACP. Do not present ACPX as the only path to Claude Code.

7. **`jq '.is_error // true'` is a bug.** The `//` alternative operator treats `false` like `null`, so a healthy envelope reads as an error. Use `if .is_error == false then ... end`. This one shipped and bit us.

8. **Submit pasted prompts with `C-m`, not `Enter`.** After a bracketed paste, a symbolic `Enter` keystroke sometimes leaves the prompt text unsubmitted in the TUI input. A short sleep then `send-keys C-m` submits reliably.

9. **Never auto-approve tool permission prompts in the one-shot lane.** The bridge auto-answers exactly one prompt, folder trust, and fails loudly with the pane tail on anything else. A text task that suddenly wants shell access is a prompt-injection smell, not an inconvenience to click through.

10. **Wrapper migration is per-script.** Print mode dying does not break your scripts in one obvious place; it breaks each `claude -p` caller individually with what looks like an auth flake. Inventory and migrate deliberately.

## Templates

- [`../templates/ai-stack/claude-tmux-relay.sh`](../templates/ai-stack/claude-tmux-relay.sh) - start, send, send-file, capture, and stop helpers for a named Claude Code tmux session

## Related

- [`multi-model-orchestration.md`](multi-model-orchestration.md) - where the Claude review lane fits in the full stack
- [`acp-claude-code.md`](acp-claude-code.md) - ACPX compatibility path for setups that need ACP
- [`sub-agent-patterns.md`](sub-agent-patterns.md) - orchestration and escalation patterns
- [`../tools/brigade.md`](../tools/brigade.md) - installable workspace and review loop support
