# Skill Sanitization Checklist

Before publishing a skill copied from a private stack:

- Replace private hostnames with `your-host` or `the host`.
- Replace account IDs, phone numbers, and channel IDs with placeholders.
- Remove auth-state paths, browser profile paths, and local-only repo paths.
- Replace real tokens and secrets with env var names.
- Keep examples deterministic and testable.
- Run the content scrubber or pre-push scanner.

Final check:

```bash
rg -n 'token|secret|password|localhost:[0-9]+|channel:[0-9]+|[0-9]{10,}' skills templates/skills
```
