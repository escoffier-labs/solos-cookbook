# SAFETY_RULES.md

## Publishing
- Scrub public content before release.
- Do not publish private hostnames, account IDs, secrets, internal paths, or personal contact details.

## Production
- Ask before destructive or production-impacting actions.
- Prefer read-only inspection before mutation.
- Back up config before risky changes.

## Credentials
- Never store secrets in markdown.
- Use env files, secret stores, or platform credential managers.
