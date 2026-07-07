# Templates

Public-safe template packs you can lift from this stack without adopting the whole thing. These are static references and starter shapes, not a generated install.

For a current, wired agent workspace, use [Brigade](../tools/brigade.md):

```bash
pipx install brigade-cli
brigade operator quickstart --target ./my-repo --harnesses codex
```

Brigade owns the generated workspace layout, handoff inboxes, tool packs, station wiring, and doctor checks. This directory owns small copyable artifacts that pair with the cookbook guides.

## Available

| Pack | What it contains | Use it when |
|------|------------------|-------------|
| [`bootstrap/`](bootstrap/) | Public-safe `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `TOOLS.md`, safety, identity, and entry-file shapes | You want to understand the file split or copy a sanitized reference. For a real install, prefer Brigade. |
| [`ai-stack/`](ai-stack/) | Model alias fragments, local routing, ACP wrapper, Claude tmux relay, browser-lane lock, plugin smoke check | You are wiring model routes, local fallbacks, or recoverable harness bridges. |
| [`cron/`](cron/) | systemd timer pair, OpenClaw cron job JSON, n8n schedule trigger | You need the three scheduler layers from [`cron-patterns`](../automation/cron-patterns.md). |
| [`hooks/`](hooks/) | pre-push guard, Claude Code post-tool-use skeleton, OpenClaw sync hook | You are adding boundary, tool-call, or lifecycle hooks from [`hooks`](../automation/hooks.md). |
| [`sandbox/`](sandbox/) | command deny wrapper and read-only git wrapper | You need restricted worker lanes from [`sandbox-shims`](../automation/sandbox-shims.md). |
| [`scrubbers/`](scrubbers/) | deterministic scrubber shell script, rules TSV, fixtures | You need a publish-boundary scrubber from [`publish-time-scrubbing`](../publishing/publish-time-scrubbing.md). |
| [`security/`](security/) | `EnvironmentFile` example and incident-note template | You need safe placeholders for secrets and incident notes from [`secret-management`](../security/secret-management.md). |
| [`skills/`](skills/) | `SKILL.md` skeleton and sanitization checklist | You are publishing a reusable skill from a private workflow. |
| [`n8n/`](n8n/) | workflow skeleton JSON and failure-classifier Code node | You are building automation flows from [`n8n-patterns`](../automation/n8n-patterns.md). |

## How to Use

1. Browse the pack you need on GitHub.
2. Copy the file into your private workspace.
3. Replace every placeholder.
4. Run the verification command in that pack's README.
5. Scrub before anything copied from your private version becomes public.

If you are setting up a fresh control host or OpenClaw node, start with [`SETUP-CHECKLIST.md`](SETUP-CHECKLIST.md). It is a checklist over these packs, not a replacement for Brigade.

## Public-Safe Boundary

These files are intentionally generic. They should not contain real hostnames, private paths, account IDs, phone numbers, production workflow IDs, webhook URLs, auth profiles, or secrets. Use documentation IP ranges and placeholders in examples.

The bootstrap pack is a readable cookbook reference. Brigade's `src/brigade/templates/` directory is the source of truth for generated Brigade workspaces.

## License

Templates are MIT (see [`../LICENSE`](../LICENSE)). Lift freely. Attribution appreciated but not required.
