# Templates

Drop-in artifacts you can lift from this stack without adopting the whole thing. Each subdirectory corresponds to a guide that uses it.

## Available

- [`cron/`](cron/) - skeletons for systemd timers, OpenClaw cron jobs, and n8n schedule triggers. Used by [`../automation/cron-patterns.md`](../automation/cron-patterns.md).
- [`hooks/`](hooks/) - pre/post hook skeletons and a publish-boundary pre-push hook. Used by [`../automation/hooks.md`](../automation/hooks.md).
- [`bootstrap/`](bootstrap/) - workspace file skeletons, synced from Brigade's public-safe workspace templates. Used by [`../knowledge/bootstrap-files.md`](../knowledge/bootstrap-files.md) and [`../tools/brigade.md`](../tools/brigade.md).
- [`skills/`](skills/) - `SKILL.md` skeleton and sanitization checklist. Used by [`../ai-stack/skills-development.md`](../ai-stack/skills-development.md).
- [`ai-stack/`](ai-stack/) - model alias snippets, ACP wrapper script, plugin health check.
- [`n8n/`](n8n/) - workflow JSON and failure-classifier skeletons. Used by [`../automation/n8n-patterns.md`](../automation/n8n-patterns.md).
- [`scrubbers/`](scrubbers/) - deterministic scrubber template and test fixtures. Used by [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md) and [`../automation/hooks.md`](../automation/hooks.md).
- [`sandbox/`](sandbox/) - wrappers for restricted worker lanes. Used by [`../automation/sandbox-shims.md`](../automation/sandbox-shims.md).
- [`security/`](security/) - env-file placeholder for services that load secrets through `EnvironmentFile`. Used by [`../security/secret-management.md`](../security/secret-management.md).

## License

Templates are MIT (see [`../LICENSE`](../LICENSE)). Lift freely. Attribution appreciated but not required.
