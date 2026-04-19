# 🦞 OpenClaw Best Practices

Practical guides for running [OpenClaw](https://github.com/openclaw/openclaw) in production. Security hardening, infrastructure patterns, agent orchestration, and operational runbooks from real deployments.

![License](https://img.shields.io/badge/license-MIT-green)
![Platform](https://img.shields.io/badge/platform-Linux-blue)
![Guides](https://img.shields.io/badge/guides-15-red)
![Last Updated](https://img.shields.io/badge/updated-2026--04--19-white)

> 🦞 No fluff. No theory without implementation. Every guide documents what was actually deployed, how to verify it, and what broke along the way.

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
