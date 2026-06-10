# Secret Management

> Secrets belong in narrow local stores with boring permissions, not in prompts, repos, screenshots, or memory.

**Tested on:** Linux user services, systemd `EnvironmentFile`, local agent config, browser-profile workflows, content-guard publish checks
**Last updated:** 2026-05-11

## What this is

Secret management for an agent stack is the discipline of keeping tokens, API keys, cookies, OAuth state, browser profiles, webhook URLs, and account identifiers out of places the agent reads, summarizes, commits, publishes, or logs casually.

The practical pattern is simple: secrets live in local secret stores or env files with restrictive permissions, services load them at process start, agents receive only the access they need, and publish-time scanners catch anything that drifts toward public artifacts.

## Why this way

Agent stacks make secret sprawl easy. A human copies a token into chat for debugging, the agent writes a config example, a cron job logs its environment, a browser profile gets backed up with notes, and suddenly the "secret" exists in transcripts, memory, git, screenshots, and exports.

The fix is not "trust the model to be careful." The fix is to make secret paths boring and mechanical:

- one local place for service env files
- one local place for browser profiles
- no secrets in repo config
- no secrets in memory cards
- no secrets in screenshots
- no secrets in public templates
- scanner gates before publish

The model can reason about secret names and placeholders. It should not handle raw secret values unless the task absolutely requires it and the output boundary is controlled.

## Prerequisites

- Linux host with systemd user services or comparable service manager
- A password manager, secrets manager, or encrypted vault for durable source-of-truth secrets
- `chmod`, `install`, `systemctl`, `jq`, and `rg`
- A content scanner such as [content-guard](https://github.com/escoffier-labs/content-guard)
- A clear distinction between private workspace files and public repo files

## Before / After

Before:

- API keys live in checked-in JSON examples.
- `.env` files sit beside source files with loose permissions.
- Browser profiles are treated like cache instead of credential material.
- Agents paste secret values into chat or logs while debugging.
- Memory cards preserve tokens because they felt "operationally useful."
- Public docs rely on manual review to catch leaks.

After:

- Real secret values live only in a vault or local env files.
- Repo templates contain placeholders, never real values.
- systemd services load secrets through `EnvironmentFile`.
- Agents refer to secret handles, not secret values.
- Browser profiles and OAuth state are treated as credentials.
- Publish-time scrubbers and content-guard run before artifacts leave the host.

## Implementation

### 1. Classify secret material

Treat more than API keys as secrets:

| Material | Why it is secret | Store it where |
|----------|------------------|----------------|
| API keys and tokens | direct service access | vault plus local env file |
| OAuth refresh state | renewable account access | provider auth store or local app config |
| Browser profiles | live cookies and account sessions | private profile directory |
| Webhook URLs | bearer tokens disguised as URLs | vault plus local env file |
| SSH keys | host and repo access | SSH agent or key store, never agent-readable |
| Recovery codes | account takeover material | password manager only |
| Private scrub rules | reveal real hostnames and identifiers | local config outside repo |
| Account IDs and channel IDs | routing and identity metadata | local config or redacted docs |

If copying the value to a public issue would make you rotate it, treat it as a secret.

### 2. Pick a local secret layout

Keep service env files outside repositories:

```bash
install -d -m 700 "$HOME/.config/agent-secrets"
install -d -m 700 "$HOME/.config/agent-browser/profiles"
```

Example layout:

```text
~/.config/agent-secrets/
  openclaw.env
  content-guard.env
  browser-lanes.env

~/.config/agent-browser/
  profiles/
    research-primary/
    draft-publishing/
```

The exact names are local. The rule is portable: configs in repos contain placeholders, local secret files contain real values, and browser profiles are not copied into public artifacts.

### 3. Lock file permissions

Use restrictive permissions by default:

```bash
chmod 700 "$HOME/.config/agent-secrets"
chmod 600 "$HOME/.config/agent-secrets/"*.env
chmod 700 "$HOME/.config/agent-browser/profiles"
```

Verify:

```bash
find "$HOME/.config/agent-secrets" -maxdepth 1 -type f -printf '%m %p\n'
find "$HOME/.config/agent-browser/profiles" -maxdepth 1 -type d -printf '%m %p\n'
```

Expected env-file mode is `600`. Expected profile-directory mode is `700`.

### 4. Load secrets through systemd

Use `EnvironmentFile` rather than checked-in config values:

```ini
[Service]
EnvironmentFile=%h/.config/agent-secrets/openclaw.env
ExecStart=/usr/bin/env openclaw gateway
```

Keep the env file simple:

```dotenv
OPENCLAW_PROVIDER_TOKEN=<secret>
OPENCLAW_WEBHOOK_URL=<secret>
CONTENT_GUARD_POLICY=<local-policy-path>
```

Do not put the env file in the repo. The repo can include a template with placeholders, but the real file belongs on the machine.

### 5. Give agents handles, not values

Agent prompts and memory should refer to secret handles:

```text
Use the configured `OPENCLAW_PROVIDER_TOKEN` from the service environment.
Do not print, summarize, or copy its value.
```

Avoid:

```text
Here is the token: <real secret value>
```

The agent can verify that a secret is present without reading it:

```bash
test -n "${OPENCLAW_PROVIDER_TOKEN:-}" && echo "configured"
```

When debugging, print secret metadata, not values:

```bash
printf 'OPENCLAW_PROVIDER_TOKEN length=%s\n' "${#OPENCLAW_PROVIDER_TOKEN}"
```

### 6. Keep secrets out of memory

Memory systems are for durable knowledge, not secret storage.

Good memory:

```text
The gateway reads provider credentials from `OPENCLAW_PROVIDER_TOKEN`.
```

Bad memory:

```text
The provider token is <real secret value>.
```

If a transcript or handoff accidentally contains a secret, rotate the secret and remove the value from the memory proposal before it is ingested. Do not rely on later decay or cleanup.

### 7. Treat browser profiles as credentials

A browser profile can contain live cookies, OAuth sessions, upload history, drafts, and provider account state. It is not disposable cache.

Rules:

- keep profiles outside repos
- use mode `700`
- use one profile per browser lane where possible
- back up profiles only to encrypted storage
- never attach profile directories to bug reports
- never use profile paths in public docs
- wipe test profiles before sharing repros

If a profile is copied to an untrusted machine, treat the related accounts as exposed and sign out or rotate sessions from the provider side.

### 8. Scrub logs and publish artifacts

Secrets leak through logs more often than through config.

Check common leak paths:

```bash
rg -n "TOKEN=|API_KEY=|SECRET=|Authorization:|Bearer " \
  logs/ staging/ exports/ 2>/dev/null || true
```

Before publishing:

```bash
templates/scrubbers/scrub-content.sh staging/public/
PYTHONPATH="$CONTENT_GUARD_DIR/src" \
  python3 -m content_guard scan staging/public/ \
  --policy "$CONTENT_GUARD_DIR/policies/public-repo.json"
```

For repos, keep the pre-push gate enabled:

```bash
git config core.hooksPath hooks
```

### 9. Rotate on exposure

When a secret may have leaked, do not debate whether someone exploited it first. Rotate, then investigate.

Minimum rotation flow:

1. Revoke or rotate the exposed token at the provider.
2. Update the vault or password manager.
3. Update the local env file.
4. Restart the affected service.
5. Verify the new credential works.
6. Search repo, logs, transcripts, screenshots, and staged artifacts for the old value or handle.
7. Record what leaked, where, and which boundary failed.

Use incident notes for root cause and prevention. Do not store the old or new secret value in the incident note.

## Verification

Check for tracked env files:

```bash
git ls-files | rg '(^|/)\.env$|\.env\.|secrets?\.|credentials?' || true
```

Expected result: only public-safe templates or docs. Real env files should not be tracked.

Check local env-file permissions:

```bash
find "$HOME/.config/agent-secrets" -maxdepth 1 -type f -printf '%m %p\n'
```

Expected result: `600` for secret env files.

Check service config uses `EnvironmentFile`:

```bash
systemctl --user cat openclaw-gateway.service | rg 'EnvironmentFile|OPENCLAW_|CONTENT_GUARD_' || true
```

Expected result: service reads a local env file or environment references, not hardcoded secret values.

Check public-boundary files:

```bash
rg -n "TOKEN=|API_KEY=|SECRET=|Authorization:|Bearer |BEGIN (RSA|OPENSSH|PRIVATE) KEY" \
  README.md ai-stack automation infrastructure knowledge publishing security templates skills
```

Expected result: no real secret values. Template placeholders are fine if they are obviously placeholders.

Run content-guard:

```bash
PYTHONPATH="$CONTENT_GUARD_DIR/src" \
  python3 -m content_guard scan "$PWD" \
  --policy "$CONTENT_GUARD_DIR/policies/public-repo.json"
```

Expected result: no blockers. Warnings should be reviewed or rewritten with placeholders.

## Gotchas

1. **Webhook URLs are secrets.** Many webhook URLs are bearer tokens in URL form. Treat them like API keys.

2. **Browser profiles are not cache.** A copied profile can carry live sessions. Protect it, encrypt backups, and sign out from providers after exposure.

3. **Debug logs are leak factories.** `set -x`, full env dumps, failed curl commands, and verbose SDK logs can print secrets. Disable shell tracing around secret-bearing commands.

4. **Memory handoffs need the same discipline.** Handoffs should say which secret handle changed, not the value. If a handoff contains a value, rotate before ingestion.

5. **Placeholders must look fake.** Use `<secret>` or `[redacted-secret]`, not realistic key-shaped examples that can confuse scanners and humans.

6. **File permissions do not help after publish.** A mode `600` env file is good on disk, but a copied value in a public guide is public forever. Scrub before publish.

7. **Agents may read what they can reach.** Do not place real secrets under directories that broad file-search tools or sub-agents routinely scan.

## Templates

- [`../templates/security/service.env.example`](../templates/security/service.env.example) - env-file placeholder shape for systemd `EnvironmentFile`
- [`../templates/scrubbers/`](../templates/scrubbers/) - publish-boundary scrubber templates
- [`../templates/hooks/pre-push`](../templates/hooks/pre-push) - final git boundary guard using content-guard

## Related

- [`agent-security-hardening.md`](agent-security-hardening.md) - agent permissions, API exposure, circuit breakers, and audit logs
- [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md) - outbound artifact scrub and scan workflow
- [`../ai-stack/browser-llm-stack.md`](../ai-stack/browser-llm-stack.md) - browser profiles and logged-in UI automation
- [`../knowledge/bootstrap-files.md`](../knowledge/bootstrap-files.md) - what belongs in durable workspace files
- [`../automation/hooks.md`](../automation/hooks.md) - boundary hooks and lifecycle hook placement
