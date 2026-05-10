# CLAUDE.md - Claude Code Rules

## Project Rules
- Follow repo-local `AGENTS.md` when present.
- Use this file only for Claude Code-specific behavior.

## Memory Handoff
- If a session discovers durable knowledge, create a handoff in `.claude/memory-handoffs/`.
- Route operational notes to `TOOLS.md`, stable user preferences to `USER.md`, workflow rules to `rules/`, and concrete failures to `.learnings/ERRORS.md`.
- Do not edit canonical memory directly unless the project explicitly says this harness owns it.

## Closeout
- Report the verification command that was run.
- If verification could not run, state the blocker.
