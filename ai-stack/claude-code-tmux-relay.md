# Claude Code via tmux Relay

How to let OpenClaw drive Claude Code through an interactive tmux session for second-opinion review, without using `claude -p` or treating Claude as a raw backend.

**Tested on:** Claude Code first-party OAuth, Opus, tmux, OpenClaw host workflow
**Last updated:** 2026-06-05

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

4. **One-shot does not mean print mode.** Use a prompt file plus `tmux paste-buffer` when you need a one-shot review. Do not call `claude -p` on this host.

5. **Capture output is evidence, not memory.** Review artifacts can be noisy. Promote only durable, verified facts through memory handoffs.

6. **Keep ACPX documented as an explicit compatibility lane.** Some OpenClaw setups still need ACP. Do not present ACPX as the only path to Claude Code.

## Templates

- [`../templates/ai-stack/claude-tmux-relay.sh`](../templates/ai-stack/claude-tmux-relay.sh) - start, send, send-file, capture, and stop helpers for a named Claude Code tmux session

## Related

- [`multi-model-orchestration.md`](multi-model-orchestration.md) - where the Claude review lane fits in the full stack
- [`acp-claude-code.md`](acp-claude-code.md) - ACPX compatibility path for setups that need ACP
- [`sub-agent-patterns.md`](sub-agent-patterns.md) - orchestration and escalation patterns
- [`../tools/brigade.md`](../tools/brigade.md) - installable workspace and review loop support
