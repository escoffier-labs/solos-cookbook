# TOOLS.md - Local Runbook

## Services

```bash
systemctl --user status <service-name>
journalctl --user -u <service-name> --since "-15min"
```

## Ports

Use placeholders in public docs:

```text
<service-name>  <port>  <purpose>
```

## Common Checks

```bash
git status --short
rg -n '<pattern>' .
jq '.' <file.json>
```

## Notes
- Keep commands current.
- Remove stale ports and endpoints.
- Do not store tokens or passwords here.
