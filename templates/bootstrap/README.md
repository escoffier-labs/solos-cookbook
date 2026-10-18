# Bootstrap Templates

Sanitized starter files for an agent workspace. Copy the shapes, not the example wording, and keep public versions free of hostnames, account IDs, phone numbers, private paths, and secrets.

These files are a readable public-safe reference for the workspace shape described in the cookbook. Use [Brigade](../../tools/brigade.md) when you want the current installable layout with handoff inboxes, starter memory cards, policies, generated rules, tool packs, station wiring, and doctor checks. The installable templates in Brigade's `src/brigade/templates/` directory are the source of truth for generated workspaces.

## Files

- `AGENTS.md` - operating rules, workflow policy, and the work-loop and authority section
- `CLAUDE.md` - Claude Code-specific bridge rules
- `SOUL.md` - voice and interaction style
- `USER.md` - stable user preferences
- `TOOLS.md` - commands, ports, services, and runbooks
- `MEMORY.md` - slim memory index
- `IDENTITY.md` - one-screen agent identity
- `HEARTBEAT.md` - recurring check-in rules (optional, only if your harness polls a heartbeat)
- `SAFETY_RULES.md` - hard boundaries (kept in step with the repository root `SAFETY_RULES.md`)
- `DREAMS.md` - reflection log container
- `INSTALL_FOR_AGENTS.md` - entry instructions for other agents

## Verification

```bash
# Sizes and optional files, on a live workspace built from these templates
bootstrap-doctor status

# Template hygiene
rg -n 'token|secret|password|localhost:[0-9]+|channel:[0-9]+|[0-9]{10,}' templates/bootstrap
```

Expected: `bootstrap-doctor status` ends with a summary line showing 0 over hard and 0 missing (an absent `HEARTBEAT.md` shows as optional), and the `rg` scan lists only prose hits (rules that tell the agent not to store tokens, secrets, or passwords, and the `token-glace` command names). Read each hit and confirm none is a real value, hostname, or channel id.
