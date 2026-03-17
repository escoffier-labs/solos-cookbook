# OpenClaw Best Practices

Practical guides for running [OpenClaw](https://github.com/openclaw/openclaw) in production. Security hardening, infrastructure patterns, agent orchestration, and operational runbooks from real deployments.

![License](https://img.shields.io/badge/license-MIT-green)
![Platform](https://img.shields.io/badge/platform-Linux-blue)
![Last Updated](https://img.shields.io/badge/updated-2026--03--17-white)

> No fluff. No theory without implementation. Every guide documents what was actually deployed, how to verify it, and what broke along the way.

## Guides

### Security

| Guide | Description | Platform |
|-------|-------------|----------|
| [Linux Hardening](security/linux-hardening.md) | UFW, SSH hardening, fail2ban, service binding, and defense-in-depth for an OpenClaw host | Ubuntu 24.04 |
| [WSL2 Hardening](security/wsl-hardening.md) | Windows Firewall, RDP/SSH/SMB lockdown, port proxy hygiene, sleep prevention, and dual-OS defense | Windows 11 + WSL2 |

### Infrastructure

| Guide | Description | Platform |
|-------|-------------|----------|
| *Coming soon* | Deployment patterns, monitoring, backups | |

### Configuration

| Guide | Description | Platform |
|-------|-------------|----------|
| *Coming soon* | Agent setup, skills, hooks, memory management | |

### Workflows

| Guide | Description | Platform |
|-------|-------------|----------|
| *Coming soon* | Sub-agent orchestration, multi-channel routing, cron patterns | |

## Who This Is For

Engineers running OpenClaw on real infrastructure: bare metal, VPS, homelab, or enterprise. If you're managing an always-on AI agent that has access to your systems, you need to lock it down properly. These guides assume you're comfortable with Linux administration and want actionable steps, not blog posts.

## Guide Format

Every guide follows the same structure:

1. **What changed** and why
2. **Before/after** configurations
3. **Step-by-step** implementation
4. **Verification** commands you can run right now
5. **Gotchas** and implementation notes from real deployments

## Contributing

Found a better approach? Running OpenClaw on a different distro or platform? PRs welcome.

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

[MIT](LICENSE)
