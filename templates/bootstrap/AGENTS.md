# AGENTS.md - Workspace Rules

## Every Session
- Read the repo-local instructions before editing.
- Prefer root-cause fixes over surface patches.
- Run the smallest meaningful verification before claiming success.
- Ask before destructive, production-impacting, or dependency-adding work.

## Memory
- Treat canonical memory as shared durable state.
- Write durable findings through the handoff flow.
- Do not dump raw transcripts into memory.

## Safety
- Never expose secrets, private hostnames, account IDs, or internal endpoints in public output.
- Use deterministic scrubbers before publishing generated content.
- Do not bypass security checks unless the user explicitly accepts the risk.

## Multi-Agent Workflow
- Delegate bounded tasks with clear ownership.
- Keep write scopes separate when multiple agents work in parallel.
- Integrate results before reporting completion.
