# Skill Templates

Use this folder when publishing a reusable agent skill from a private stack.

## Files

- `SKILL.md` - public-safe skill skeleton
- `sanitization-checklist.md` - release checklist before copying a real skill into a public repo

## Verification

```bash
rg -n 'token|secret|password|localhost:[0-9]+|channel:[0-9]+|[0-9]{10,}' templates/skills
```
