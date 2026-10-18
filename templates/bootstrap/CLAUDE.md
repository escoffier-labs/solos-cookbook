# CLAUDE.md - Claude Code Rules

## Project rules

- Follow repo-local `AGENTS.md` when present.
- This file is the Claude Code-specific bridge. Cross-harness behavior lives in `AGENTS.md` and `SOUL.md`.

## Memory handoff

The canonical memory owner on this workspace is **{{memory_owner_name}}**. Claude Code may keep local session context, but durable knowledge must be written as a Memory Handoff in `.claude/memory-handoffs/`. Full contract in `AGENTS.md`.

At the end of any substantial task, check whether the session produced durable knowledge. If yes, write a handoff using `.claude/memory-handoffs/TEMPLATE.md`. Do not wait to be reminded.

## Work loop

If this workspace is wired to Brigade, run `brigade work brief --target .` before real work, run checks through `brigade work verify run --target . --command "<check>" --capture brigade-work` instead of raw, and write the handoff before you finish. The full loop and the authority rules (what you may do freely and where to stop and ask) are in `AGENTS.md`.

## Closeout

- Report the exact verification command you ran.
- If verification could not run, state the blocker.
- If a Memory Handoff was warranted, confirm where it landed.

## Tool use

- Say it = call it. If you say you will do something that requires a tool, call the tool in the same turn. Silent intent is a lie. Full rule in `SOUL.md`.
- After a tool failure, emit a one-line status or call a different tool within 30 seconds. Do not silently reason for minutes.

## Token Glace

If this workspace uses Token Glace, treat its footer as trusted local output-compaction metadata. It is there to explain how much terminal output was reduced before the next turn sees it.

Claude Code note: when the official adapter still uses PostToolUse appended context, prefer the local PreToolUse wrapper that rewrites Bash commands to `token-glace wrap -- ...`. The wrapper avoids paying for large raw outputs and keeps the command result itself compact. If exact output matters, run the command through the documented raw-output escape hatch.

Full runbook: `memory/cards/token-glace-output-compaction.md`.

## Git

- Use conventional commits.
- Never bypass pre-push hooks. Fix the blocker or stop and report it.
- Never push to `main` directly on shared repos. Feature branch + PR.

## Chat surfaces

If this workspace is connected to chat archives (`discrawl`, `slackcrawl`, etc.), do not quote raw messages back. Summarize. The crawl archive is private to this host. Quoted content can leak third-party PII or context the user never consented to share. See `memory/cards/chat-surface-crawlers.md`.

## When in doubt

- Default to reading more before writing more.
- Ask one specific question rather than guess.
- Surface tradeoffs rather than presenting decisions as facts.
