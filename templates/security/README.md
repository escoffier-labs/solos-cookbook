# Security Templates

Small public-safe placeholders for secret handling and security boundaries.

## Files

- `service.env.example` - env-file shape for services that load secrets through systemd `EnvironmentFile`, plus the reference-template shape (`op://` and `keepass://` placeholders) used by the render-to-tmpfs pattern
- `incident-note.md` - public-safe incident note template for root cause and follow-up

These are templates. Replace placeholders in a private local file outside the repo. Reference templates are never sourced: a renderer resolves them into a `0600` file under the runtime directory.
