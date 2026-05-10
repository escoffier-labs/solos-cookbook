# Bootstrap Templates

Sanitized starter files for an agent workspace. Copy the shapes, not the example wording, and keep public versions free of hostnames, account IDs, phone numbers, private paths, and secrets.

## Files

- `AGENTS.md` - operating rules and workflow policy
- `CLAUDE.md` - Claude Code-specific bridge rules
- `SOUL.md` - voice and interaction style
- `USER.md` - stable user preferences
- `TOOLS.md` - commands, ports, services, and runbooks
- `MEMORY.md` - slim memory index
- `IDENTITY.md` - one-screen agent identity
- `HEARTBEAT.md` - recurring check-in rules
- `SAFETY_RULES.md` - hard boundaries
- `DREAMS.md` - reflection log container
- `INSTALL_FOR_AGENTS.md` - entry instructions for other agents

## Verification

```bash
rg -n 'token|secret|password|localhost:[0-9]+|channel:[0-9]+|[0-9]{10,}' templates/bootstrap
```

Expected: no matches unless you intentionally added a documented placeholder.
