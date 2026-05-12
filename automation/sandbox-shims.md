# Sandbox Shims

> Put cheap wrappers in front of risky commands so worker lanes fail closed before they touch the network, git remote, or host secrets.

**Tested on:** shell `PATH` shims, read-only git wrappers, restricted worker lanes, content-guard publish checks
**Last updated:** 2026-05-11

## What this is

Sandbox shims are tiny executable wrappers placed earlier in `PATH` than the real tools. They let a restricted worker run harmless commands while blocking dangerous ones such as `git push`, `ssh`, `curl`, package-manager installs, or broad shell operations.

This is not a full container sandbox. It is a practical guardrail for agent and sub-agent lanes where the worker should read, analyze, and edit inside an assigned scope, but should not publish, deploy, exfiltrate, or mutate shared state.

## Why this way

Agent permission systems are uneven. One runtime gives you per-tool allowlists. Another gives a shell. A sub-agent may run inside a harness that can edit files but cannot use your host git setup. A hook can block some calls, but only if the orchestrator actually routes through that hook.

`PATH` shims are boring and portable:

- they work with any process that calls `git`, `curl`, `ssh`, or package managers by name
- they fail before the real command runs
- they can log denied attempts
- they can be tested without the agent
- they pair cleanly with tool permissions, hooks, and incident runbooks

They are defense in depth. Use them with tool allowlists, service boundaries, and secret management. Do not treat them as the only security boundary for hostile code.

## Prerequisites

- Linux shell environment
- Control over the worker process environment
- A directory you can place before system paths in `PATH`
- `git`, `bash`, `chmod`, and `ln`
- A clear policy for what the worker lane is allowed to do

## Before / After

Before:

- Worker agents inherit the operator's full `PATH`.
- `git push`, `ssh`, `curl`, and package-manager installs are one shell call away.
- A model can discover deploy commands while exploring scripts.
- Denied attempts are invisible unless the user watches the full transcript.
- Incident response has to infer what the worker tried.

After:

- Restricted lanes get their own shim directory.
- Read-only commands pass through.
- risky commands fail with exit code `126`.
- denied attempts can be logged.
- publish, deploy, network, and secret-bearing actions stay in the main lane.

## Implementation

### 1. Define lane classes

Start with lane policy, not command names.

| Lane | Allowed | Denied |
|------|---------|--------|
| read-only explorer | `rg`, `sed`, `git status`, `git diff`, `git log`, `git show` | writes, network, package installs, pushes |
| patch worker | read commands, scoped file edits, local tests | git remote writes, ssh, deploy, secret reads |
| build worker | package manager install in a disposable workspace, local test commands | publish, deploy, ssh, host service changes |
| release lane | publish commands with human approval | autonomous release or broad shell |

Most sub-agents should be read-only explorer or patch worker lanes. Keep release actions in the main session where the operator can review them.

### 2. Create a shim directory

Make a lane-local bin directory:

```bash
install -d -m 755 .agent-sandbox/bin
```

Copy the templates:

```bash
cp templates/sandbox/git-wrapper.sh .agent-sandbox/bin/git
cp templates/sandbox/deny-command.sh .agent-sandbox/bin/curl
cp templates/sandbox/deny-command.sh .agent-sandbox/bin/ssh
cp templates/sandbox/deny-command.sh .agent-sandbox/bin/scp
cp templates/sandbox/deny-command.sh .agent-sandbox/bin/rsync
chmod +x .agent-sandbox/bin/*
```

Then launch the worker with the shim directory first:

```bash
PATH="$PWD/.agent-sandbox/bin:$PATH" <worker-command>
```

The worker sees `git`, `curl`, and `ssh` as usual. The wrapper decides whether the real command is allowed.

### 3. Wrap git as read-only by default

The template git wrapper allows inspection commands and blocks everything else:

```bash
case "${1:-}" in
  status|diff|log|show|branch|rev-parse|ls-files)
    exec /usr/bin/git "$@"
    ;;
  *)
    echo "sandbox: git ${1:-<none>} is not allowed in this worker lane" >&2
    exit 126
    ;;
esac
```

This lets workers inspect history and diffs while blocking:

- `git push`
- `git pull`
- `git fetch`
- `git remote`
- `git checkout`
- `git reset`
- `git clean`
- `git commit`

If a worker needs to produce a patch, let it edit files. The main lane can review, stage, commit, and push.

### 4. Deny network tools by default

For most worker lanes, deny direct network tools:

```bash
for cmd in curl wget ssh scp rsync ftp sftp nc ncat socat; do
  ln -sf deny-command.sh ".agent-sandbox/bin/$cmd"
done
```

Use explicit tools or brokered APIs for network access instead. That gives you logging, scoping, rate limits, and a place to scrub results.

If a build worker needs network access for package install, put it in a disposable workspace and log the exception. Do not grant network access to a general explorer lane just because one task might need it later.

### 5. Deny package-manager mutation unless disposable

Package managers can execute lifecycle scripts, fetch arbitrary code, and mutate lockfiles.

For read-only or patch lanes, deny:

```bash
for cmd in npm pnpm yarn pip pip3 uv cargo go gem bundle; do
  ln -sf deny-command.sh ".agent-sandbox/bin/$cmd"
done
```

If tests require package commands, provide a narrow wrapper:

```bash
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  test|run|exec)
    exec /usr/bin/npm "$@"
    ;;
  *)
    echo "sandbox: npm ${1:-<none>} is not allowed in this worker lane" >&2
    exit 126
    ;;
esac
```

Keep install, publish, login, and token commands out of normal worker lanes.

### 6. Log denied attempts

Denials are useful incident evidence. Extend the deny wrapper with a local log path when you need auditability:

```bash
log="${SANDBOX_DENY_LOG:-}"
if [ -n "$log" ]; then
  mkdir -p "$(dirname "$log")"
  printf '%s command=%s args=%q\n' "$(date -Is)" "$(basename "$0")" "$*" >> "$log"
fi
```

Keep the log outside public repos:

```bash
SANDBOX_DENY_LOG="$HOME/.local/state/agent-sandbox/denied.log"
```

Do not log secret-bearing arguments unless you have a scrubber in front of the log. For sensitive environments, log command name and lane id only.

### 7. Pair shims with orchestrator permissions

Use every layer that is available:

| Layer | Control |
|-------|---------|
| orchestrator tool config | allow or deny shell access by agent |
| tool-call hook | block dangerous commands before execution |
| `PATH` shim | fail closed when a command reaches the shell |
| OS permissions | prevent access to secret directories and host services |
| publish boundary | catch leaks before artifacts leave the host |

The shim catches accidents and harness gaps. It does not replace host permissions.

### 8. Keep secrets out of worker reach

Restricted workers should not inherit broad secret environments.

Launch with a minimal environment when possible:

```bash
env -i \
  HOME="$HOME" \
  PATH="$PWD/.agent-sandbox/bin:/usr/bin:/bin" \
  WORKSPACE="$PWD" \
  <worker-command>
```

If the worker needs a token, prefer a task-scoped token with a short lifetime and narrow permissions. Do not pass the operator's whole shell environment into the worker.

## Verification

Check wrapper ordering:

```bash
PATH="$PWD/.agent-sandbox/bin:$PATH" command -v git curl ssh
```

Expected result: each command resolves inside `.agent-sandbox/bin` for the restricted worker.

Check allowed git commands:

```bash
PATH="$PWD/.agent-sandbox/bin:$PATH" git status
PATH="$PWD/.agent-sandbox/bin:$PATH" git diff --stat
```

Expected result: both commands pass through to real git.

Check denied git commands:

```bash
PATH="$PWD/.agent-sandbox/bin:$PATH" git push
```

Expected result: exit code `126` and a message that `git push` is not allowed.

Check denied network tools:

```bash
PATH="$PWD/.agent-sandbox/bin:$PATH" curl https://example.com
PATH="$PWD/.agent-sandbox/bin:$PATH" ssh example-host
```

Expected result: exit code `126` from the deny wrapper.

Check that the real commands still exist outside the shim lane:

```bash
/usr/bin/git --version
```

Run shell syntax checks:

```bash
bash -n templates/sandbox/deny-command.sh templates/sandbox/git-wrapper.sh
```

## Gotchas

1. **`PATH` shims only work when commands are called by name.** A script that calls `/usr/bin/git` bypasses a `git` shim. Pair shims with tool-call hooks and OS permissions for stronger control.

2. **Shell builtins need different controls.** `cd`, `echo`, `test`, and shell redirection are not external binaries. Use workspace permissions and shell policy for those.

3. **Package managers run code.** `npm install`, `pip install`, and similar commands can execute scripts. Do not allow them in ordinary patch lanes.

4. **Deny logs can leak arguments.** If you log full command lines, you may log tokens. For sensitive lanes, log command name, lane id, and timestamp only.

5. **Workers may need real git history.** Do not block `git log`, `show`, or `diff` for code-review lanes. Read-only git is high value and low risk.

6. **Shims are not containers.** They do not restrict filesystem reads, syscalls, or absolute binary paths. Use them as a cheap front door, not the whole house.

7. **Main lane owns publishing.** Let workers propose patches. Let the main lane stage, commit, push, deploy, or publish after review.

## Templates

- [`../templates/sandbox/deny-command.sh`](../templates/sandbox/deny-command.sh) - generic deny wrapper for risky commands
- [`../templates/sandbox/git-wrapper.sh`](../templates/sandbox/git-wrapper.sh) - read-only git wrapper
- [`../templates/hooks/`](../templates/hooks/) - hook skeletons for command-aware blocking
- [`../templates/security/incident-note.md`](../templates/security/incident-note.md) - capture denied attempts when they become incidents

## Related

- [`hooks.md`](hooks.md) - use hooks when command policy needs orchestrator context
- [`../security/agent-security-hardening.md`](../security/agent-security-hardening.md) - agent permissions and destructive endpoint design
- [`../security/secret-management.md`](../security/secret-management.md) - keep secret stores out of worker reach
- [`../security/incident-runbook.md`](../security/incident-runbook.md) - preserve denied attempts and convert incidents into controls
- [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md) - public-boundary checks after worker output becomes an artifact
