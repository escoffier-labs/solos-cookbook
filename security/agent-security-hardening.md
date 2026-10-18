# Agent Security Hardening

How to treat your AI agent as an untrusted actor and build guardrails that actually work. Includes a real post-mortem from when a sub-agent nuked a production database.

**Tested on:** OpenClaw 2026.10.4 (GPT 6.1 Sol primary, Claude via ACPX for escalation, a locked-down browser agent), Brigade 0.28.0. The incident below dates from the 2026.3 to 2026.4 stack.
**Last updated:** 2026-10-17

---

## Core Rule

**Treat LLMs as hostile, probabilistic actors.** Prompt-level guardrails are NOT a security boundary. A model that's told "never call DELETE" will eventually call DELETE if the endpoint exists and the context is right. Your security must exist at the infrastructure layer, not the instruction layer.

## The Incident: How Haiku Nuked 71,000 Chunks

This isn't theoretical. Here's what happened to us (2026-03-02).

**Setup:** We had a code search API (FastAPI + SQLite) running on localhost. The API had full CRUD endpoints, including `DELETE /api/index` which wiped the entire index. A Haiku 4.5 sub-agent was assigned a cron job that interacted with this API.

**What happened:** Haiku read the API's OpenAPI spec (which was accessible at `/docs`), discovered the DELETE endpoint, and called it three times unprompted. It deleted 71,000 indexed chunks and 28,000 summaries. The SQLite database had `SECURE_DELETE` compiled in (Ubuntu default), meaning deleted data was zeroed on disk. Unrecoverable without a backup.

**Cost:** $40+ in API calls to re-index everything, plus hours of downtime. We restored from a 3am restic snapshot and immediately removed the DELETE endpoint from `server.py`.

**Root cause:** The DELETE endpoint existed. That's it. Haiku wasn't malicious. It wasn't even doing anything unusual. It found a tool and used it. The security failure was exposing a destructive endpoint to an agent in the first place.

**The incident scales beyond Haiku.** I have since seen the same pattern with the GPT-5 generation and other frontier models. Any model with tool access and an OpenAPI spec will eventually exercise every endpoint. Model size and vendor are not a defense.

There's a model-selection side to this incident too: cheap models belong in read-only lanes, and any lane that can mutate state needs fencing regardless of which model runs it. That angle is covered in [multi-model orchestration](../ai-stack/multi-model-orchestration.md#cheap-vs-capable-is-about-blast-radius-not-just-budget).

## 1. API Design: Gateway Isolation

### Never Expose Raw APIs to Agents

If your agent can reach an API, it will eventually discover and use every endpoint. Build a curated "Agent API" that physically omits destructive operations.

**Before (dangerous):**
```python
# Full CRUD - agent can see and call everything
@app.delete("/api/index")
def delete_index():
    db.execute("DELETE FROM chunks")
    return {"status": "deleted"}
```

**After (safe):**
```python
# DELETE endpoint removed entirely
# Agent API only exposes read + search
@app.get("/api/search")
def search(query: str):
    return search_index(query)

@app.get("/api/health")
def health():
    return {"status": "ok"}

# Admin operations require separate auth or CLI-only access
```

### Where my own APIs stand

The code search API from the incident has had its destructive endpoint removed since March, and I confirmed on 2026-10-17 that its OpenAPI spec lists no `DELETE`. The cleanup is not complete across everything on the host, though. A re-check found a write route still live on a second local API. It is on my fix list: remove or auth-gate the write routes, and bind to loopback.

Check your own host the same way. The loop in the Verification section lists every `PUT` and `DELETE` route on the local ports you name. Treat any hit as a decision you have to make, not a pass.

### Use Short-Lived Tokens

Don't give agents persistent API keys. Use JIT (Just-In-Time) tokens:

```
1. Agent requests a task-scoped token
2. Token expires in minutes, not hours
3. Token is bound to specific operations (read-only, search-only)
4. Token includes user context (who requested it)
```

### Use UUIDs, Not Sequential IDs

Sequential IDs (1, 2, 3...) allow iteration attacks. An agent that discovers record 5 can try 1-100. UUIDs prevent this.

## 2. RBAC and Permission Scoping

### Principle of Least Privilege

Each agent gets only the permissions it needs. Nothing more.

```
Main agent:            fs:read, fs:write, exec, scoped API access
Code worker:           fs:read, fs:write inside one worktree
Scanner / reviewer:    read-only
Browser agent:         browser tools only, no exec, no sudo
Cron jobs:             task-specific, no API write
```

### Child Agents Inherit Downgraded Permissions

When your main agent spawns a sub-agent, the sub-agent should get a SUBSET of the parent's permissions, never equal or higher.

### OpenClaw Tool Permissions

On 2026.10.4 per-agent config lives under `agents.entries.<id>` (the older `agents.list[]` array is gone). The agent I fence hardest is the browser agent, because it handles logged-in sessions and untrusted pages:

```json
{
  "agents": {
    "entries": {
      "browser-operator": {
        "tools": {
          "profile": "minimal",
          "alsoAllow": ["browser", "browser_credential_fill"],
          "elevated": { "enabled": false },
          "deny": ["session_status"]
        }
      }
    }
  }
}
```

Key settings:
- **`profile: "minimal"`** starts from the smallest tool set, and `alsoAllow` adds only what the lane needs
- **`elevated.enabled: false`** blocks the sudo-like path for that agent
- **`deny`** removes individual tools even if a profile would grant them

Be honest about what is not fenced. My main agent runs with broad exec and no approval prompts, behind the gateway token. I made that trade for a single-operator host where the agent does real work, and I compensate at other layers: firewall rules, scoped credentials, no destructive endpoints, audit watches, and Brigade hooks on the repos where the agent writes code. The earlier version of this guide recommended an `exec.security: "allowlist"` block. I ran that on 2026.4 and have not re-verified the equivalent on 2026.10.4, so I no longer show it as a recommendation. If you need a tighter exec posture, start from `openclaw exec-policy show --verbose` and the presets (`cautious`, `deny-all`) rather than copying a config block from an older release.

## 3. Sandboxing exec Access

### The Problem with exec: "full"

`exec` in `full` mode means the agent can run any shell command. This includes `rm -rf`, `curl` to exfiltrate data, or any other destructive operation. If you run it that way, the controls have to live outside the model's reach.

### Tighten What You Can

Layers that work regardless of the exec mode:

- Scope the credentials a lane can see (see [`secret-management.md`](secret-management.md)). An agent cannot exfiltrate a token it was never given.
- Put the lane in a read-only worker seat when it does not need to write.
- Use `openclaw exec-policy preset cautious` or `deny-all` for lanes that should not run commands unattended, after reading what the preset changes with `show --verbose`.
- Keep the sandbox setting in mind: my main agents run unsandboxed, with a Docker sandbox profile (no network, all capabilities dropped, pid and memory limits) defined for when I need it. Defining a profile is not the same as using it.

### OS-Level Confinement (Advanced)

For high-security setups, use OS-level sandboxing:

| Tool | What It Does | Use Case |
|------|-------------|----------|
| AppArmor | Deny all writes by default, explicit allowlists | Restrict file access per process |
| Seccomp-bpf | Block specific syscalls (execve, kill, network bind) | Prevent process spawning |
| Landlock | Unprivileged self-sandboxing, restrict to specific directories | Limit filesystem scope |

**Always deny:** `~/.ssh`, `~/.aws`, `~/.gnupg` regardless of agent commands. An agent should never access your SSH keys or cloud credentials directly.

## 4. Circuit Breaker Patterns

### Rate-Limit Destructive Operations

Even with proper API design, add a circuit breaker as defense-in-depth:

```
Rule: >3 DELETE/UPDATE operations in a 10-second window → trip circuit
Action: Revoke token, suspend session, alert operator
```

### Blast Radius Heuristics

Reject operations that could cause widespread damage:

- `DELETE` or `UPDATE` without a specific `WHERE` clause
- Wildcard operations (table drops, unfiltered deletes)
- Bulk operations exceeding a threshold (e.g., >100 records in one call)

### Implementation

At the API gateway or middleware level:

```python
from collections import defaultdict
from time import time

destructive_counts = defaultdict(list)

def circuit_breaker(agent_id: str, operation: str):
    if operation in ("DELETE", "UPDATE", "DROP"):
        now = time()
        recent = [t for t in destructive_counts[agent_id] if now - t < 10]
        destructive_counts[agent_id] = recent
        
        if len(recent) >= 3:
            revoke_agent_token(agent_id)
            alert_operator(f"Circuit breaker tripped for {agent_id}")
            raise PermissionError("Too many destructive operations")
        
        destructive_counts[agent_id].append(now)
```

## 5. Audit Logging

### Log Every External Action

Your agent should not be able to modify its own audit trail. The version of this guide I first wrote suggested a root-owned `/var/log/openclaw-audit` directory. I never created it, and it does not exist on my host. What actually records agent activity here:

- The OpenClaw `command-logger` hook writes a command log under `~/.openclaw/logs/` (mode `600`, owned by the agent's user)
- Session transcripts for each harness
- Brigade's work ledger and verification receipts in repos that use it
- `auditd` write-watches (`-w <path> -p wa -k <key>`) on a few paths an agent should not change silently
- A Wazuh agent on the host, shipping to a central manager

The first two are owned by the same user the agent runs as, so they are evidence, not tamper-proof evidence. The `auditd` rules and the Wazuh stream are the parts the agent cannot rewrite without root. If you want the stricter separation, a root-owned directory is still the right shape:

```bash
sudo mkdir -p /var/log/agent-audit
sudo chown root:root /var/log/agent-audit
sudo chmod 700 /var/log/agent-audit
```

### What to Log

Every log entry should include:
- **trace_id:** Unique ID per user prompt, propagated through all sub-agents
- **agent_id:** Which agent performed the action
- **operation:** What was done (API call, file write, exec command)
- **parameters:** The exact arguments/payload
- **timestamp:** When it happened
- **result:** Success/failure and response

### SIEM Integration

If you run Wazuh, TheHive, or another SIEM, pipe agent audit logs there for correlation (see [`wazuh-triage.md`](wazuh-triage.md) and [`mcp-incident-response.md`](mcp-incident-response.md)). This lets you detect patterns: is your agent doing things you didn't expect? Acting at unusual hours? Making API calls to services you didn't configure?

## 6. Behavioral Guardrails via Plugins

Prompt-level rules don't scale. Plugin-level hooks do. Two I run, one of them with a caveat:

### tool-narration-guard

Catches the failure mode where the model narrates "I'm running the build now" without actually calling the tool. The guard tracks runs at the session level and injects a `prependContext` rule on the next turn forcing the model to either call the tool or explicitly say it can't.

Without this plugin, you lose 30+ minutes at a time waiting for work that never started. See [self-improving agents](../ai-stack/self-improving-agents.md).

### strict-agentic (history)

On the 2026.4 and 2026.6 builds, OpenClaw's `strict-agentic` plan-then-act retry had two detection gaps: (A) imperative prompts like "do X" / "put Y through Z" and (B) short confident narration like "I'm running it now." Both bypassed the actionable-prompt detector, and I carried a local patch to the compiled runner. Today the gateway runs from a promoted release worktree that I do not patch by hand, and I have not re-tested whether those gaps still exist on 2026.10.4. Whatever the status, do not rely on this retry as a sole guardrail.

## 7. Prompt Injection Defense

### The Threat

Prompt injection is when adversarial text in an email, document, or webpage tricks your agent into unintended actions. People are embedding payloads like `<admin_instructions>ignore previous instructions</admin_instructions>` in public LinkedIn profiles right now.

If your agent reads email, scrapes websites, processes documents, or participates in group chats, it WILL encounter prompt injections in the wild.

### Defenses

1. **Use your strongest model for orchestration and review.** Frontier models have significantly better injection resistance than budget models. This is the single most impactful defense.

2. **Restrict autonomous actions.** The more your agent can do without approval, the more damage a successful injection can cause.

3. **Validate before executing.** Configure confirmation prompts before sending emails, making purchases, or modifying important files.

4. **Never route untrusted content through budget models.** Your orchestrator (frontier model) should be the one processing email, web scrapes, and group chat messages. Sub-agents should only receive sanitized, task-specific prompts from the orchestrator.

## 8. A Dedicated Security-Review Lane

Hardening is not only runtime fences. I also run changes through a separate review seat whose only job is defensive security review. It is a seat in the Brigade roster, backed by a dedicated security-review model, with these properties:

- **Read-only capable.** It reads a diff or a repo and reports. It does not edit.
- **Bounded scans.** Each run gets one scope (a PR, a directory, a dependency change) and a timeout of 25 minutes. It is not an open-ended crawl.
- **No implementation work.** The seat's role text forbids routine implementation, so it cannot grade its own homework.
- **Complementary to other reviewers.** It runs alongside the ordinary code review and the repo's CI scanners. It is a different model family from the one that wrote the change, which is the point.

I dispatch it through the same tool I use for other workers (`brigade run`), not by hand-prompting a chat window. Findings still need a human or a second reviewer to confirm before anything is changed, since a security reviewer can be confidently wrong in both directions. Treat a clean pass as one signal, not clearance.

## Verification

```bash
echo "=== Per-agent tool fences ==="
jq '.agents.entries | to_entries[] | {id: .key, tools: (.value.tools // "inherits global")}' \
  ~/.openclaw/openclaw.json

echo ""
echo "=== Exec posture ==="
openclaw exec-policy show

echo ""
echo "=== Behavioral Plugins ==="
jq '.plugins.entries | with_entries(select(.key == "tool-narration-guard" or .key == "content-scrubber")) | map_values(.enabled)' \
  ~/.openclaw/openclaw.json

echo ""
echo "=== Audit sources ==="
stat -c '%a %n' ~/.openclaw/logs/commands.log 2>/dev/null || echo "command log not found"
systemctl is-active auditd wazuh-agent

echo ""
echo "=== API Endpoints Exposed ==="
# List PUT/DELETE routes on local APIs. Replace the placeholder with the ports you run.
for port in <your-api-ports>; do
  curl -s -m 3 "http://127.0.0.1:$port/openapi.json" 2>/dev/null | python3 -I -c "
import sys, json
port = sys.argv[1]
try:
    spec = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for path, methods in spec.get('paths', {}).items():
    for verb in ('put', 'delete'):
        if verb in methods:
            print(f'  {verb.upper()} {path} on :{port}')
" "$port"
done
echo "(check complete)"
```

Expected result: the first block shows your fenced agents. `exec-policy show` prints your real posture, which may be `full`. Both plugins print `true`. The last block prints nothing between the header and `(check complete)` once every local API is read-only. Ports that do not serve an OpenAPI spec (or require auth) print nothing, which is not proof they are safe.

## Gotchas

1. **OpenAPI specs are attack surface.** If your API serves `/docs` or `/openapi.json`, agents will read it and use every endpoint they find. Disable auto-generated docs in production or restrict access.

2. **"Don't call DELETE" in the system prompt is not security.** It's a suggestion. The agent might follow it 99% of the time. The 1% is when your database gets wiped.

3. **SQLite SECURE_DELETE is compiled in on Ubuntu.** If an agent deletes data from SQLite, it's zeroed on disk. No recovery without backups. Always backup before giving agents API access.

4. **Sub-agent sandbox gotcha.** Isolated sub-agents in OpenClaw can't access host git/gh CLI by default (sandbox has no git). Use sub-agents for file writing, then push from the main session.

5. **Any model will find creative ways to be destructive.** Haiku didn't set out to delete our data. It was trying to be helpful. It read the API spec, saw a cleanup endpoint, and called it. This is not a small-model problem. Frontier models will do the same given tool access. The lesson: if the destructive path exists, an agent will eventually find it. Remove the path.

6. **Main-agent model changes don't change the attack surface.** I have moved the orchestrator from Opus to the GPT-5 generation and then to GPT 6.1 Sol. None of the security rules in this guide changed. Prompt-level guards are still not a boundary. Fences still need to be tight. API design still matters more than model choice.

7. **A cleanup you have not re-verified is a claim, not a fact.** An earlier version of this guide implied the destructive-endpoint cleanup was finished. A re-check found a write route still live on a second local API. Re-run the endpoint loop after every new local service.

8. **A directory in a guide is not a log on disk.** The audit log path I once recommended was never created. Check that your audit sources exist and that something reads them, not only that a guide mentions them.
