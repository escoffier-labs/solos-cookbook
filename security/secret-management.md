# Secret Management

> Secrets belong in narrow local stores with boring permissions, not in prompts, repos, screenshots, or memory.

**Tested on:** Ubuntu 24.04, systemd 255 user services, 1Password CLI 2.41, Claude Code 2.1.302, OpenClaw 2026.10.4, Brigade 0.28.0
**Last updated:** 2026-10-17

## What this is

Secret management for an agent stack is the discipline of keeping tokens, API keys, cookies, OAuth state, browser profiles, webhook URLs, and account identifiers out of places the agent reads, summarizes, commits, publishes, or logs casually.

The practical pattern is simple: secrets live in a vault or in local env files with restrictive permissions, services load them at process start, agents receive only the access they need, and publish-time scanners catch anything that drifts toward public artifacts.

There are two variants in this guide. The minimal one is a directory of `0600` env files that systemd loads (sections 2 to 4). The one I run now renders those env files from a vault into tmpfs at boot, so no long-lived plaintext copy exists on disk (section 5). Start with the minimal variant. Move to the render pattern when you have more than a handful of secrets or more than one host.

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
- A password manager, secrets manager, or encrypted vault for durable source-of-truth secrets (the render pattern assumes 1Password service accounts plus an optional KeePass mirror)
- For the sealed-credential step: a TPM2 device the service user can open (membership in the `tss` group) and systemd 250 or newer
- `chmod`, `install`, `systemctl`, `jq`, and `rg`
- Brigade's embedded guard or another content scanner with a public-repo policy
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

- Real secret values live only in a vault, plus env files that are rendered into tmpfs at boot (or, in the minimal variant, local `0600` env files).
- Repo templates contain placeholders, never real values.
- systemd services load secrets through `EnvironmentFile`.
- Agents refer to secret handles, not secret values.
- Browser profiles and OAuth state are treated as credentials.
- Publish-time scrubbers and Brigade guard run before artifacts leave the host.

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
  brigade.env
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
BRIGADE_GUARD_POLICY=<local-policy-path>
```

Do not put the env file in the repo. The repo can include a template with placeholders, but the real file belongs on the machine.

### 5. Render from a vault to tmpfs

The `0600` env directory in section 2 still leaves a long-lived plaintext copy on disk, and it gets backed up, snapshotted, and copied by tools that walk the home directory. What I run instead is a vault that holds the values and a small systemd oneshot that renders env files into `/run/user/<uid>/...` (tmpfs) at boot. The files vanish on reboot and are rebuilt from the vault each time.

The parts:

1. **Two 1Password service accounts, one read-only and one read-write**, both scoped to a single runtime vault. Day-to-day reads and rendering use the read-only one. The read-write one exists for creating and editing items and has an expiry date.
2. **Two wrapper scripts, `op-sa` and `op-sa-rw`**, that run the `op` CLI non-interactively as each account. Each looks up its token from the login keyring and then does `exec op "$@"`.
3. **A template file per consumer** that holds references instead of values.
4. **A renderer** that resolves the references and writes the env file.
5. **A oneshot unit and a retry timer** that run the renderer and order the consuming service after it.
6. **A TPM-sealed service-account credential** so the oneshot works on a headless boot.
7. **A KeePass mirror** as an offline copy of the vault.

#### The wrappers

The important property is that the wrapper fails closed. `op` with no token set falls back to desktop-app integration, which prompts for approval and hangs in an unattended run. The wrapper refuses to run `op` at all if the token lookup comes back empty:

```bash
#!/usr/bin/env bash
# op-sa: non-interactive `op` as the read-only service account.
set -euo pipefail
token="$(secret-tool lookup service op-service-account account <read-only-account> 2>/dev/null)" || token=""
if [ -z "${token//[[:space:]]/}" ]; then
  echo "op-sa: service-account token is unavailable, not running op" >&2
  exit 1
fi
export OP_SERVICE_ACCOUNT_TOKEN="$token"
unset token
exec op "$@"
```

`op-sa-rw` is the same script pointed at the read-write account. Use it only for writes:

```bash
op-sa item list --vault <runtime-vault>        # read-only account
op-sa-rw item create ...                       # read-write account, only when writing
```

Do not wrap this in `eval "$(op-sa --export)"` for convenience. That puts the service-account token into your shell environment, where every child process and every shell snapshot (see the gotchas) can capture it.

#### Template files

A template is a dotenv file whose values are references, not secrets:

```dotenv
# gateway.env.tpl: a TEMPLATE. Never source this file.
PROVIDER_TOKEN=op://<runtime-vault>/<item>/<field>
WEBHOOK_URL=op://<runtime-vault>/<item>/<field>
LEGACY_TOKEN=keepass://<entry-title>
```

`op://` references resolve against 1Password. `keepass://` references resolve against a KeePass entry by exact, unique title (the KeePass side is the fallback source and the mirror target). Templates are safe to keep in a private dotfiles repo, since they hold no values, but they still reveal vault and item names, so keep them out of public repos.

A template must never be sourced or loaded with `export $(grep ... | xargs)`. Doing that exports the literal reference string as the value. The failure is quiet and misleading: a tool that uses the variable as a keyring password reports an integrity-check failure that looks like a corrupted keyring, when the real problem is that it was handed the string `keepass://...` instead of the password. If a tool complains about a secret that you know is correct, check whether it came from a template.

#### The renderer

The renderer reads a template, resolves every `op://` reference through one `op` child process, and writes the result atomically. Mine creates the output directory at `0700`, writes a temp file at `0600`, and then renames it into place, so a reader never sees a half-written file. Whatever you use, hold it to the same contract: one resolution pass, `0700` directory, `0600` file, atomic replace, and never write the service-account token into the output.

#### The oneshot and the retry timer

```ini
# ~/.config/systemd/user/secrets-render.service
[Unit]
Description=Render service secrets from the vault
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
UMask=0077
TimeoutStartSec=90
LoadCredentialEncrypted=op-service-account-token:%h/.config/agent-secrets/op-service-account-token.cred
ExecStart=%h/bin/render-env --env-file %h/.config/agent-secrets/gateway.env.tpl --write-env %t/agent-secrets/gateway.env

[Install]
WantedBy=default.target
```

`%t` is the user runtime directory (`/run/user/<uid>`), which is tmpfs. The consuming service orders itself after the render and loads the output:

```ini
# in the consuming service
[Unit]
Requires=secrets-render.service
After=secrets-render.service

[Service]
EnvironmentFile=%t/agent-secrets/gateway.env
```

Two settings in the oneshot came from a real outage. A `Type=oneshot` unit defaults to `TimeoutStartSec=infinity`. After a reboot with linger enabled, my renderer started before the desktop login unlocked the keyring, blocked on the token lookup forever, and the gateway that required it never started (about five hours of downtime). Bounding the start time fixes the hang. A retry timer fixes the recovery:

```ini
# ~/.config/systemd/user/secrets-render.timer
[Timer]
OnBootSec=30
OnUnitInactiveSec=45
Unit=secrets-render.service

[Install]
WantedBy=timers.target
```

While the render keeps failing, the unit goes inactive and the timer re-fires about every 45 seconds. Once it succeeds, `RemainAfterExit=yes` keeps the unit active, so the timer stops firing on its own. A drop-in with `ExecStartPost=-systemctl --user --no-block start <consumer>.service` brings the consumer up the moment a retry succeeds. The `--no-block` is required, because the consumer is ordered after the render and a blocking `start` would deadlock until the 90-second timeout. The leading `-` keeps a consumer hiccup from failing the render.

Active does not mean fresh. With `RemainAfterExit=yes`, an `active (exited)` unit says nothing about whether the last render worked, so compare the output file's mtime to the unit's last completion time (see Verification). Another cause of render failures is archived vault items that share a title with active ones. List with `op-sa item list --vault <runtime-vault> --include-archive` when a reference that should resolve does not.

#### Seal the service-account credential to the TPM

The oneshot needs the service-account token at boot, with nobody logged in. Rather than leaving it in a file, seal it to the TPM and let systemd decrypt it into the service's private credentials directory:

```bash
# read the token from the keyring and seal it, without it touching disk or argv
secret-tool lookup service op-service-account account <read-only-account> \
  | systemd-creds encrypt --with-key=tpm2 --tpm2-pcrs=7 \
      --name=op-service-account-token - ~/.config/agent-secrets/op-service-account-token.cred
chmod 600 ~/.config/agent-secrets/op-service-account-token.cred
```

The unit's `LoadCredentialEncrypted=` line (above) decrypts it at start. The name given to `--name` must match the name on the `LoadCredentialEncrypted=` line. The renderer reads it from `$CREDENTIALS_DIRECTORY` and hands the final application only the rendered values, never the service-account token.

Things to know before relying on this:

- **PCR 7 drifts, and `LoadCredentialEncrypted=` fails hard.** Sealing to PCR 7 ties the blob to the Secure Boot state. A firmware update or a Secure Boot database (dbx) update changes it and the credential stops decrypting. systemd decrypts a `LoadCredentialEncrypted=` credential while it sets up the service, before any `ExecStart=` runs, so the unit fails to start and the renderer never gets a chance to fall back to the keyring. Recovery is to re-seal the credential with `systemd-creds encrypt` after the update (the command above, from a logged-in session so the keyring can supply the token), then start the unit again. If you want a fallback instead of a hard failure, leave `LoadCredentialEncrypted=` off the unit and have the renderer call `systemd-creds decrypt` itself, falling back to the keyring when that fails. I do that for a second sealed secret, and the render degrades to the keyring path and the timer retries until someone logs in.
- **Keep a recovery copy.** I keep a TPM-only copy with no PCR binding next to each active credential, also at `0600`, so a firmware change does not strand the host. It is bound to the machine but not to the boot state, so treat it as a weaker secret and do not copy it elsewhere.
- **Validate without printing.** `systemd-creds decrypt --name=<credential-name> <path> /dev/null` exits `0` if the blob is good. Leaving out `--name` can produce a misleading failure.
- **The trade-off is explicit.** Any process running as the service user, or as root, on the booted host can now obtain the token without a human logging in. The seal protects the blob off the machine and against offline disk theft. It does not protect against code already running on the host.
- **TPM access.** The service user needs the `tss` group (a fresh login session picks it up). A boot session that predated the group change also needed a temporary ACL on `/dev/tpmrm0`.

#### KeePass mirror

1Password is the source of truth, and KeePass is the offline copy that survives a vault lockout or an account problem. A daily timer runs a mirror script that copies every runtime item into a KDBX under a dedicated group, using a title prefix that keeps mirrored entries from colliding with runtime entry titles. It matches by 1Password item ID, updates when the item changes, and never deletes, so KeePass keeps an item even after it leaves 1Password. A separate timer syncs the KDBX between two storage locations every two minutes. Compare the copies byte for byte so a stale or diverged copy shows up.

Two lessons from running it:

- Entry titles used by `keepass://` references must be unique. Mirrored entries get a prefix for exactly that reason.
- Make the renderer fail closed on any load warning. A phone client saved my KDBX in an older format that my Python library could not decrypt. The library returned ciphertext as field values without raising, and the next save through it corrupted most of the protected fields. Recovery came from the storage provider's revision history. Now the render and write tools refuse to continue on any "could not unprotect" warning, and the mirror takes a timestamped backup before every save.

If you do not run 1Password, the same shape works with any vault that has a non-interactive CLI: scoped read-only credential, template of references, renderer, oneshot into tmpfs.

### 6. Give agents handles, not values

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

### 7. Keep secrets out of memory

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

### 8. Limit what MCP servers inherit

Claude Code passes its entire launching environment to stdio MCP servers by default. If your shell (or the service that launched Claude Code) holds a cloud token, every MCP server it starts holds that token too, including third-party servers fetched with `npx`. Two environment variables tighten this:

- `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1` limits each server to a safe baseline plus the `env` block configured for it.
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips credential-shaped variables from subprocesses.

I recorded this against Claude Code 2.1.289 from the project's environment-variable documentation and have not re-tested it on 2.1.302, so confirm on your version before relying on it. Turning the allowlist on breaks any server that was quietly relying on an inherited variable, so move those servers to an explicit `env` block first.

A wrapper that sources a secrets file and then `exec`s the server is the other common approach. If you use one, give each server its own file. A single shared file hands every wrapped server every other server's credentials. Make the wrapper exit non-zero when the file is unreadable, because a wrapper that logs a warning and starts the server anyway fails open. Pin third-party servers to a version rather than `@latest`.

### 9. Treat browser profiles as credentials

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

### 10. Scrub logs and publish artifacts

Secrets leak through logs more often than through config.

Check common leak paths:

```bash
rg -n "TOKEN=|API_KEY=|SECRET=|Authorization:|Bearer " \
  logs/ staging/ exports/ 2>/dev/null || true
```

Before publishing:

```bash
templates/scrubbers/scrub-content.sh staging/public/
brigade scrub --target staging/public/ --policy public-content --no-receipt
```

For repos, keep the pre-push gate enabled:

```bash
git config core.hooksPath hooks
```

### 11. Rotate on exposure

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

Check the render pattern (skip this block if you use the minimal variant). The rendered directory should be tmpfs-backed at `0700` with `0600` files:

```bash
d="$XDG_RUNTIME_DIR/agent-secrets"
stat -c '%a %n' "$d" "$d"/*
findmnt -no FSTYPE -T "$d"
```

Expected result: `700` for the directory, `600` for each file, and `tmpfs` from `findmnt`.

Check that the render ran after the last boot and is not just "active":

```bash
systemctl --user show secrets-render.service -p ActiveState,SubState,Result
stat -c '%y %n' "$XDG_RUNTIME_DIR"/agent-secrets/*.env
```

Expected result: `ActiveState=active`, `SubState=exited`, `Result=success`, and file mtimes at or after the boot time.

Check that the sealed credential still decrypts, without printing it:

```bash
systemd-creds decrypt --name=op-service-account-token \
  ~/.config/agent-secrets/op-service-account-token.cred /dev/null && echo "seal ok"
```

Expected result: `seal ok`. After a firmware or Secure Boot update, a failure here means the PCR 7 seal needs redoing.

Check that no template is being sourced by a shell startup file:

```bash
rg -n '(source|^\.) +\S+\.tpl' ~/.bashrc ~/.profile ~/.zshrc 2>/dev/null || true
```

Expected result: no matches.

Check agent shell-snapshot directories (see Gotchas) for exported secrets, listing file names only:

```bash
for d in ~/.claude/shell-snapshots; do
  stat -c '%a %n' "$d"
  grep -l -E 'export [A-Z_]*(TOKEN|KEY|PASSWORD|SECRET)[A-Z_]*=' "$d"/* 2>/dev/null | wc -l
done
```

Expected result: directory mode `700` and a count of `0`. Repeat for any other harness that keeps a snapshot directory.

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
systemctl --user cat openclaw-gateway.service | rg 'EnvironmentFile|OPENCLAW_|BRIGADE_' || true
```

Expected result: service reads a local env file or environment references, not hardcoded secret values.

Check public-boundary files:

```bash
rg -n "TOKEN=|API_KEY=|SECRET=|Authorization:|Bearer |BEGIN (RSA|OPENSSH|PRIVATE) KEY" \
  README.md ai-stack automation infrastructure knowledge publishing security templates skills
```

Expected result: no real secret values. Template placeholders are fine if they are obviously placeholders.

Run Brigade guard:

```bash
brigade scrub --target "$PWD" --policy public-repo
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

8. **Shell snapshot caches capture exported secrets in plaintext.** Agent harnesses snapshot your shell environment so each command starts with the same state. If a secret was exported when the snapshot was taken, it lands in a plain file. Codex shell snapshots on my host had captured plaintext exports at mode `664`, and live tokens had also ended up in transcript files. I have since stripped the exports from the existing snapshots, locked the directories to `0700` with `0600` files, and rotated the keyring password that had been captured. Treat transcripts as secret-bearing and rotate anything they captured. The harness keeps creating new snapshot files at the default umask, so re-check the modes periodically instead of fixing them once. Do not export secrets in the shell that launches agents. Inject them per process instead (a wrapper, `LoadCredential=`, or a service `EnvironmentFile`).

9. **Never source a template.** A file full of `op://` or `keepass://` references is not an env file. Sourcing it exports reference strings as if they were values, and the symptom is usually a downstream "integrity check failed" or auth error that sends you looking at the wrong thing.

10. **Systemd `active` is not "rendered".** A oneshot with `RemainAfterExit=yes` stays `active (exited)` after a failed re-render of a single file. Check the output file's mtime.

11. **Sealed credentials break on firmware updates.** A PCR 7 seal stops decrypting after a Secure Boot database or firmware change. A credential loaded through `LoadCredentialEncrypted=` fails the whole unit at setup, so no fallback in the renderer can run. Keep a recovery copy before you update, and re-seal after.

12. **Archived vault items shadow active ones.** If an archived item shares a title with an active item, a render by title can fail or pick the wrong one. List with `--include-archive` when a reference stops resolving.

13. **MCP servers inherit your whole environment.** See section 8. A secret exported anywhere in the launch chain reaches every server.

## Templates

- [`../templates/security/service.env.example`](../templates/security/service.env.example) - env-file placeholder shape for systemd `EnvironmentFile`, plus the reference-template shape for the render pattern
- [`../templates/scrubbers/`](../templates/scrubbers/) - publish-boundary scrubber templates
- [`../templates/hooks/pre-push`](../templates/hooks/pre-push) - final git boundary guard using Brigade guard

## Related

- [`agent-security-hardening.md`](agent-security-hardening.md) - agent permissions, API exposure, circuit breakers, and audit logs
- [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md) - outbound artifact scrub and scan workflow
- [`../ai-stack/browser-llm-stack.md`](../ai-stack/browser-llm-stack.md) - browser profiles and logged-in UI automation
- [`../knowledge/bootstrap-files.md`](../knowledge/bootstrap-files.md) - what belongs in durable workspace files
- [`../automation/hooks.md`](../automation/hooks.md) - boundary hooks and lifecycle hook placement
