# 🦞 OpenClaw Best Practices

Practical guides for running [OpenClaw](https://github.com/openclaw/openclaw) in production. Security hardening, infrastructure patterns, agent orchestration, and operational runbooks from real deployments.

![License](https://img.shields.io/badge/license-MIT-green)
![Platform](https://img.shields.io/badge/platform-Linux-blue)
![Guides](https://img.shields.io/badge/guides-15-red)
![Last Updated](https://img.shields.io/badge/updated-2026--04--19-white)

> 🦞 No fluff. No theory without implementation. Every guide documents what was actually deployed, how to verify it, and what broke along the way.

## Recommended Provider Stack

The guides assume a specific provider mix. You can substitute, but if you want a known-good baseline:

- **Codex Pro ($200/mo) OAuth — main agent + coder.** This is the happy path. One flat subscription covers orchestration, code generation, and most cron work. Codex OAuth slots cleanly into OpenClaw's primary-model path and has been the most stable surface across the 2026.4.x releases. Start here.
- **Claude Opus 4.6 via ACP — escalation only.** Resume, intel, design, review, humanize, academic work. Run it through the ACPX plugin, not as a direct OpenClaw provider.
- **Google AI Pro ($20/mo) — research + imagegen.** Gemini CLI OAuth for large-context research and `gemini-2.5-flash-image` for banner generation.
- **Ollama (free) — embeddings, commit messages, triage.** Local, fast, no round-trip.

### ⚠️ Do not route Claude Max OAuth directly through OpenClaw

As of April 2026, pointing an OpenClaw agent at your Claude Max subscription OAuth has two problems that make it a non-starter:

1. **Extra usage charges.** Anthropic started metering traffic that arrives through third-party harnesses against your subscription in ways that show up as additional usage on top of normal Max caps. You can burn through quota far faster than the same work would cost through the first-party Claude client.
2. **System-prompt-level blocking.** Claude detects that it's running inside a non-Anthropic harness and injects guidance that degrades behavior (refusals, hedging, dropping tool calls). Prompt-level workarounds don't stick.

**The only sensible path to Opus from OpenClaw is ACP.** The ACPX plugin launches the official Claude Code CLI as a subprocess — Anthropic's own client handles the OAuth handshake, so the usage accounting and system-prompt behavior stay normal. OpenClaw connects to it over the Agent Client Protocol and treats the session as an escalation sub-agent.

Full migration runbook in [claude-cli → ACP Migration](configuration/claude-cli-to-acp-migration.md).

## Guides

### Security

| Guide | Description | Platform |
|-------|-------------|----------|
| [Linux Hardening](security/linux-hardening.md) | UFW, SSH hardening, fail2ban, service binding, and defense-in-depth for an OpenClaw host | Ubuntu 24.04 |
| [WSL2 Hardening](security/wsl-hardening.md) | Windows Firewall, RDP/SSH/SMB lockdown, port proxy hygiene, sleep prevention, and dual-OS defense | Windows 11 + WSL2 |
| [Agent Security](security/agent-security-hardening.md) | API gateway isolation, RBAC, sandboxing, circuit breakers, and a real post-mortem from a sub-agent nuking a database | Any |

### Infrastructure

| Guide | Description | Platform |
|-------|-------------|----------|
| [Backup & Recovery](infrastructure/backup-recovery.md) | Restic to NAS + Google Drive, twice-daily schedule, snapshot mounts, and disaster recovery | Any |

### Configuration

| Guide | Description | Platform |
|-------|-------------|----------|
| [Multi-Model Orchestration](configuration/multi-model-orchestration.md) | Run GPT 5.4, Gemini, ACP Opus, and Ollama in one setup with the right model per task | Any |
| [claude-cli → ACP Migration](configuration/claude-cli-to-acp-migration.md) | Move Opus off the main-agent slot after Anthropic's April 2026 subscription-OAuth block | Anthropic |
| [Memory & Token Optimization](configuration/memory-token-optimization.md) | Three-tier memory architecture with local semantic search and 50-100x token reduction | Any |
| [Prompt Caching](configuration/prompt-caching.md) | Cache hygiene across Anthropic, OpenAI, and Gemini — avoid silent cost/quota leaks | Any |
| [Compaction & Context Tuning](configuration/compaction-and-context-tuning.md) | Compaction, memory flush, context pruning, and session search for long-running agents | Any |
| [Skills Development](configuration/skills-development.md) | Write custom skills, structure for discoverability, real-world examples, and skill management | Any |

### Workflows

| Guide | Description | Platform |
|-------|-------------|----------|
| [Sub-Agent Patterns](workflows/sub-agent-patterns.md) | Spawn patterns, model assignment, ACP escalation, error handling, and the wrapper script | Any |
| [Cron Job Patterns](workflows/cron-patterns.md) | Scheduling, heartbeat batching, thinking-budget aliases, explicit delivery routing, and quiet hours | Any |
| [Multi-Channel Setup](workflows/multi-channel-setup.md) | Discord, Telegram, Signal routing, session isolation, ACP threads, and access control | Any |
| [Self-Improving Agents](workflows/self-improving-agents.md) | Correction capture, behavioral-guard plugins (tool-narration-guard, tokenjuice), daily memory sweeps, promotion rules | Any |
| [Session Management](workflows/session-management.md) | Why single-chat apps bottleneck your agent, Discord channel layouts, cron isolation, and the hybrid approach | Any |

## Who This Is For

Engineers running OpenClaw on real infrastructure: bare metal, VPS, homelab, or enterprise. If you're managing an always-on AI agent that has access to your systems, you need to lock it down properly. These guides assume you're comfortable with Linux administration and want actionable steps, not blog posts.

> 🦞 *Built by an engineer who runs OpenClaw 24/7 on bare metal and broke everything at least once so you don't have to.*

## Guide Format

Every guide follows the same structure:

1. **What changed** and why
2. **Before/after** configurations
3. **Step-by-step** implementation
4. **Verification** commands you can run right now
5. **Gotchas** and implementation notes from real deployments

## Contributing

Found a better approach? Running OpenClaw on a different distro or platform? PRs welcome. 🦞

- Follow the existing guide format
- Include verification commands
- Document gotchas and edge cases
- Test on real infrastructure before submitting

## Related Projects

- [OpenClaw](https://github.com/openclaw/openclaw) - The AI agent framework
- [OpenClaw Overlay](https://github.com/solomonneas/openclaw-overlay) - HUD overlay for session monitoring
- [Usage Tracker](https://github.com/solomonneas/usage-tracker) - Token usage and cost analytics
- [SOC Stack](https://github.com/solomonneas/soc-stack) - AI-augmented Security Operations Center toolkit

## License

[MIT](LICENSE) 🦞
