# Agent Incident Runbook

> When an agent breaks something, stop the bleeding first, preserve evidence second, and only then fix the root cause.

**Tested on:** agent API exposure incidents, secret-leak drills, publish-boundary checks, backup restore workflows
**Last updated:** 2026-05-11

## What this is

This is the calm checklist for agent incidents: destructive tool calls, leaked secrets, bad publishes, corrupted memory, broken automation, runaway browser sessions, and suspicious external actions. It is written for a single-host agent stack, but the sequence works for any setup where an AI agent can touch real systems.

The runbook has one job: keep you from debugging while the incident is still getting worse.

## Why this way

Most incident mistakes come from doing the right actions in the wrong order. People start reading logs while the automation is still running. They rotate a token but leave the old one in a service env file. They restore data before preserving the broken state. They delete the only transcript that explains what happened.

The order matters:

1. freeze risky actors
2. preserve evidence
3. classify the incident
4. contain the blast radius
5. restore service or rotate secrets
6. remove the root cause
7. write down the durable lesson

Prompts are not the fix. If an agent could do the destructive thing once, the permanent fix belongs in permissions, API shape, hooks, scrubbers, backups, or service boundaries.

## Prerequisites

- Shell access to the host
- Ability to stop user services
- Access to service logs and agent session logs
- Backups you have tested
- Credential rotation access for affected providers
- A local place to store incident notes that is not public by default

## Before / After

Before:

- Incidents are handled from memory.
- The agent keeps running while you investigate.
- Logs, transcripts, and bad artifacts get overwritten.
- The fix is a prompt reminder.
- The lesson never reaches docs or memory.

After:

- Risky automation is paused early.
- Evidence is copied before cleanup.
- Incidents are classified by type and severity.
- Recovery follows a known path.
- Root cause fixes land in permissions, services, templates, or guides.
- Durable lessons become memory handoffs or cookbook updates.

## Implementation

### 1. Freeze risky automation

Stop the surfaces that can keep causing damage. Pick the smallest freeze that contains the issue, but err on the side of pausing automation before deep investigation.

Common freezes:

```bash
# Stop the main gateway if the agent is actively doing unsafe work.
systemctl --user stop openclaw-gateway.service

# Stop a specific user service if the incident is isolated.
systemctl --user stop <service-name>.service

# Disable a timer if a scheduled job is repeating the failure.
systemctl --user disable --now <timer-name>.timer
```

If browser automation is the issue, close the lane by taking the lock or stopping its runner. If a publishing workflow is the issue, remove the artifact from the downstream queue before editing the content.

Do not delete files yet. The broken state is evidence.

### 2. Capture volatile evidence

Create an incident folder outside the public repo:

```bash
incident_id="$(date +%Y%m%d-%H%M)-agent-incident"
mkdir -p "$HOME/incidents/$incident_id"
chmod 700 "$HOME/incidents/$incident_id"
```

Capture service status and logs:

```bash
systemctl --user status openclaw-gateway.service > "$HOME/incidents/$incident_id/gateway-status.txt" 2>&1 || true
journalctl --user -u openclaw-gateway.service --since "2 hours ago" > "$HOME/incidents/$incident_id/gateway-journal.txt" 2>&1 || true
```

Capture repo state if files were modified:

```bash
git status --short > "$HOME/incidents/$incident_id/git-status.txt" 2>&1 || true
git diff > "$HOME/incidents/$incident_id/git-diff.patch" 2>&1 || true
```

Capture a copy of suspect artifacts:

```bash
cp -a staging/public "$HOME/incidents/$incident_id/staging-public-copy" 2>/dev/null || true
cp -a exports "$HOME/incidents/$incident_id/exports-copy" 2>/dev/null || true
```

Do not copy secrets into public incident notes. If a raw log contains secrets, keep it private and write a sanitized summary later.

### 3. Classify the incident

Use the first matching class:

| Class | Examples | First action |
|-------|----------|--------------|
| destructive action | deleted data, modified production files, bad API write | freeze actor, snapshot evidence, restore from backup |
| secret exposure | token in repo, log, screenshot, chat, memory | rotate first, then scrub and investigate |
| public leak | private hostname, ID, path, screenshot published | remove public artifact, preserve copy, rotate if needed |
| runaway automation | cron loop, repeated browser jobs, message spam | disable timer or queue, inspect trigger |
| prompt injection | untrusted content caused tool use or policy bypass | freeze external-action tools, preserve prompt and source |
| memory corruption | false durable claim, secret in memory, bad rule | stop ingestion, quarantine handoff or card |
| service outage | gateway, plugin, or dependency failed | preserve logs, restart only after status capture |

Severity is about blast radius, not drama:

| Severity | Definition | Response |
|----------|------------|----------|
| S1 | data loss, exposed secret, public leak, external action, account risk | stop automation, rotate or restore, write incident note |
| S2 | broken service, repeated failed jobs, bad private artifact | pause affected lane, fix root cause, verify |
| S3 | contained doc error, warning-only scanner finding, harmless failed run | fix in normal workflow, note if recurring |

### 4. Contain by incident type

#### Destructive action

1. Stop the actor.
2. Capture logs and diff.
3. Identify touched files, database tables, API operations, or external services.
4. If data may be corrupted, take a fresh backup or filesystem snapshot before restore.
5. Restore from the last known-good backup.
6. Remove or gate the destructive path.
7. Re-enable only after verification.

Do not solve this with "tell the model not to do that." Remove the endpoint, narrow the token, add an allowlist, or require approval.

#### Secret exposure

1. Revoke or rotate the secret.
2. Update the vault and local env file.
3. Restart affected services.
4. Search for the old value or handle in repos, logs, transcripts, staged artifacts, screenshots, and memory handoffs.
5. Scrub or delete exposed artifacts.
6. Add a scanner rule or publish-boundary check if the leak class was not covered.

Do not paste the old secret into the incident note. Refer to it by handle and provider.

#### Public leak

1. Remove or unpublish the artifact if possible.
2. Preserve a private copy for evidence.
3. Decide whether the leaked value is sensitive enough to rotate.
4. Replace public content with placeholders.
5. Run scrubber and content-guard.
6. Republish the corrected artifact.
7. Check caches, releases, attachments, and downstream mirrors.

If the public leak is a screenshot, inspect image metadata and alt text too.

#### Runaway automation

1. Disable the timer, queue, or workflow.
2. Capture the last successful and first failing run.
3. Check whether retries are stacking behind a lock.
4. Reduce retry count or add backoff.
5. Add a maximum runtime and a clear failure state.
6. Re-enable with a smoke test.

#### Prompt injection

1. Preserve the untrusted source that triggered the behavior.
2. Freeze external-action tools if the prompt caused actions.
3. Check what the agent did after reading the source.
4. Move the affected workflow behind stronger model review, stricter parsing, or human approval.
5. Add a fixture so the same injection is tested later.

#### Memory corruption

1. Stop or pause memory ingestion if it is still processing.
2. Quarantine the bad handoff, card, or rule.
3. Replace the false claim with a corrected note that includes evidence.
4. If a secret landed in memory, rotate it before cleanup.
5. Add a handoff explaining the root cause and durable correction.

### 5. Restore service carefully

Bring services back in layers:

```bash
systemctl --user daemon-reload
systemctl --user start <service-name>.service
systemctl --user status <service-name>.service
```

Watch logs during the first run:

```bash
journalctl --user -u <service-name>.service -f
```

Run a smoke test that cannot repeat the incident. For example:

- read-only health endpoint, not a write endpoint
- dry-run publish scan, not publish
- single cron job with delivery disabled
- browser lane status check, not a full posting workflow

### 6. Write the incident note

Use the template:

```bash
cp templates/security/incident-note.md "$HOME/incidents/$incident_id/incident-note.md"
```

Fill it with sanitized facts:

- what happened
- when it started and stopped
- which actor or service was involved
- what data or account was affected
- what was rotated, restored, or removed
- what root cause fix was made
- what verification passed
- what durable memory or guide update is needed

Keep raw logs private. Put public-safe summaries in docs or handoffs.

### 7. Convert the lesson into a control

Every incident should produce at least one control:

| Root cause | Durable control |
|------------|-----------------|
| destructive endpoint reachable | remove endpoint, split admin API, require approval |
| broad token | narrow scope, shorten lifetime, rotate |
| secret in public artifact | scrub rule, content-guard policy, publish checklist |
| runaway cron | lock, timeout, backoff, circuit breaker |
| browser profile collision | per-lane `flock`, one profile per workflow |
| memory accepted false claim | evidence requirement, quarantine path, review gate |
| prompt injection succeeded | parse gate, stronger model review, reduced tool access |

If the fix is only a prompt, the incident is not closed.

## Verification

Check that risky services are paused:

```bash
systemctl --user list-units 'openclaw*' --state=running
systemctl --user list-timers --all | rg '<affected-job>|openclaw|agent' || true
```

Check that evidence exists:

```bash
find "$HOME/incidents/$incident_id" -maxdepth 2 -type f -printf '%p\n'
```

Check for new public leaks:

```bash
templates/scrubbers/scrub-content.sh staging/public/ 2>/dev/null || true
PYTHONPATH="$CONTENT_GUARD_DIR/src" \
  python3 -m content_guard scan "$PWD" \
  --policy "$CONTENT_GUARD_DIR/policies/public-repo.json"
```

Check for tracked env or secret files:

```bash
git ls-files | rg '(^|/)\.env$|\.env\.|secrets?\.|credentials?' || true
```

Check service recovery:

```bash
systemctl --user status <service-name>.service
journalctl --user -u <service-name>.service --since "10 minutes ago"
```

Expected result: affected automation is either still paused intentionally or has passed a low-risk smoke test, content-guard has no blockers, and the incident note names the root-cause control.

## Gotchas

1. **Do not restart before capturing logs.** A restart can clear the only useful stack trace, run id, or plugin initialization error.

2. **Do not restore over evidence.** Copy or snapshot the broken state first. Restore after you can explain what you are replacing.

3. **Secret incidents start with rotation.** You can investigate after the token is dead. Leaving a suspected secret live while you read logs is backwards.

4. **Browser incidents may still be logged in.** Closing a browser window does not revoke cookies. Sign out or revoke sessions from the provider if the profile may have been copied.

5. **Public leaks have downstream copies.** Check releases, package registries, mirrored repos, screenshots, search caches, and chat attachments.

6. **Runaway retries hide behind locks.** A queue may look quiet because jobs are waiting on `flock`. Check pending jobs and timers, not only CPU usage.

7. **A prompt reminder is not closure.** Closure means the destructive path is gone, gated, scoped, or monitored.

## Templates

- [`../templates/security/incident-note.md`](../templates/security/incident-note.md) - sanitized incident note template
- [`../templates/security/service.env.example`](../templates/security/service.env.example) - secret env-file shape for service recovery
- [`../templates/scrubbers/`](../templates/scrubbers/) - publish-boundary scrubber templates
- [`../templates/hooks/pre-push`](../templates/hooks/pre-push) - final git boundary guard

## Related

- [`agent-security-hardening.md`](agent-security-hardening.md) - remove destructive paths and scope agent permissions
- [`secret-management.md`](secret-management.md) - rotate secrets and keep values out of logs, repos, and memory
- [`../infrastructure/backup-recovery.md`](../infrastructure/backup-recovery.md) - restore from encrypted snapshots
- [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md) - public leak cleanup and publish-boundary checks
- [`../automation/cron-patterns.md`](../automation/cron-patterns.md) - pause and reshape scheduled jobs
