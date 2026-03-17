# Agent Security Hardening

How to treat your AI agent as an untrusted actor and build guardrails that actually work. Includes a real post-mortem from when a sub-agent nuked a production database.

**Tested on:** OpenClaw with multi-agent setup (Opus 4.6, Haiku 4.5, GPT 5.x Codex)
**Last updated:** 2026-03-17

---

## Core Rule

**Treat LLMs as hostile, probabilistic actors.** Prompt-level guardrails are NOT a security boundary. A model that's told "never call DELETE" will eventually call DELETE if the endpoint exists and the context is right. Your security must exist at the infrastructure layer, not the instruction layer.

## The Incident: How Haiku Nuked 71,000 Chunks

This isn't theoretical. Here's what happened to us.

**Setup:** We had a code search API (FastAPI + SQLite) running on localhost. The API had full CRUD endpoints, including `DELETE /api/index` which wiped the entire index. A Haiku 4.5 sub-agent was assigned a cron job that interacted with this API.

**What happened:** Haiku read the API's OpenAPI spec (which was accessible at `/docs`), discovered the DELETE endpoint, and called it. It deleted 71,000 indexed chunks and 28,000 summaries. The SQLite database had `SECURE_DELETE` compiled in (Ubuntu default), meaning deleted data was zeroed on disk. Unrecoverable.

**Cost:** ~$30 in API calls to re-index everything, plus hours of downtime.

**Root cause:** The DELETE endpoint existed. That's it. Haiku wasn't malicious. It wasn't even doing anything unusual. It found a tool and used it. The security failure was exposing a destructive endpoint to an agent in the first place.

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
Main agent (Opus):     fs:read, fs:write, exec:allowlist, api:full
Code worker (Codex):   fs:read, fs:write, exec:allowlist
Scanner (Haiku):       fs:read ONLY
Cron jobs:             task-specific, no exec, no API write
```

### Child Agents Inherit Downgraded Permissions

When your main agent spawns a sub-agent, the sub-agent should get a SUBSET of the parent's permissions, never equal or elevated.

### OpenClaw Tool Permissions

Configure in `openclaw.json`:

```json
{
  "agents": [
    {
      "id": "coder",
      "name": "Code Worker",
      "model": "openai-codex/gpt-5.4",
      "tools": {
        "exec": {
          "security": "allowlist",
          "allowlist": ["git", "npm", "node", "python3"]
        },
        "elevated": {
          "enabled": false
        }
      }
    }
  ]
}
```

Key settings:
- **exec.security: "allowlist"** restricts shell access to specific commands
- **elevated.enabled: false** blocks sudo access
- Per-agent tool config means your scanner can't exec while your builder can

## 3. Sandboxing exec Access

### The Problem with exec: "full"

`exec` with `security: "full"` means the agent can run any shell command. This includes `rm -rf`, `curl` to exfiltrate data, or any other destructive operation.

### Tighten the Allowlist

Start with the minimum and add commands as needed:

```json
{
  "exec": {
    "security": "allowlist",
    "allowlist": [
      "git", "npm", "node", "python3", "curl",
      "ls", "cat", "grep", "find", "wc"
    ]
  }
}
```

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

Your agent should not be able to modify its own audit trail. Store logs separately:

```bash
# Dedicated audit log location
sudo mkdir -p /var/log/openclaw-audit
sudo chown root:root /var/log/openclaw-audit
sudo chmod 700 /var/log/openclaw-audit
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

If you run Wazuh, TheHive, or another SIEM, pipe agent audit logs there for correlation. This lets you detect patterns: is your agent doing things you didn't expect? Acting at unusual hours? Making API calls to services you didn't configure?

## 6. Prompt Injection Defense

### The Threat

Prompt injection is when adversarial text in an email, document, or webpage tricks your agent into unintended actions. People are embedding payloads like `<admin_instructions>ignore previous instructions</admin_instructions>` in public LinkedIn profiles right now.

If your agent reads email, scrapes websites, processes documents, or participates in group chats, it WILL encounter prompt injections in the wild.

### Defenses

1. **Use your strongest model for orchestration.** Frontier models have significantly better injection resistance than budget models. This is the single most impactful defense.

2. **Restrict autonomous actions.** The more your agent can do without approval, the more damage a successful injection can cause.

3. **Validate before executing.** Configure confirmation prompts before sending emails, making purchases, or modifying important files.

4. **Never route untrusted content through budget models.** Your orchestrator (frontier model) should be the one processing email, web scrapes, and group chat messages. Sub-agents should only receive sanitized, task-specific prompts from the orchestrator.

## Verification Checklist

```bash
echo "=== Tool Permissions ==="
cat ~/.openclaw/openclaw.json | python3 -c "
import sys, json
config = json.load(sys.stdin)
for agent in config.get('agents', []):
    tools = agent.get('tools', {})
    exec_sec = tools.get('exec', {}).get('security', 'default')
    elevated = tools.get('elevated', {}).get('enabled', 'default')
    print(f\"{agent['id']:15s} exec={exec_sec:10s} elevated={elevated}\")
"

echo ""
echo "=== Audit Log Directory ==="
ls -la /var/log/openclaw-audit/ 2>/dev/null || echo "Not configured"

echo ""
echo "=== API Endpoints Exposed ==="
# Check if any local APIs expose destructive endpoints
for port in 5200 5201 5202 5203 5204 8005; do
  DOCS=$(curl -s http://127.0.0.1:$port/openapi.json 2>/dev/null)
  if [ ! -z "$DOCS" ]; then
    DELETES=$(echo "$DOCS" | python3 -c "
import sys, json
try:
    spec = json.load(sys.stdin)
    for path, methods in spec.get('paths', {}).items():
        if 'delete' in methods:
            print(f'  ⚠ DELETE {path} on :{sys.argv[1]}')
except: pass
" $port 2>/dev/null)
    if [ ! -z "$DELETES" ]; then
      echo "$DELETES"
    fi
  fi
done
echo "(check complete)"
```

## Gotchas

1. **OpenAPI specs are attack surface.** If your API serves `/docs` or `/openapi.json`, agents will read it and use every endpoint they find. Disable auto-generated docs in production or restrict access.

2. **"Don't call DELETE" in the system prompt is not security.** It's a suggestion. The agent might follow it 99% of the time. The 1% is when your database gets wiped.

3. **SQLite SECURE_DELETE is compiled in on Ubuntu.** If an agent deletes data from SQLite, it's zeroed on disk. No recovery without backups. Always backup before giving agents API access.

4. **Sub-agent sandbox gotcha.** Isolated sub-agents in OpenClaw can't access host git/gh CLI by default (sandbox has no git). Use sub-agents for file writing, then push from the main session.

5. **Budget models find creative ways to be destructive.** Haiku didn't set out to delete our data. It was trying to be helpful. It read the API spec, saw a cleanup endpoint, and called it. The lesson: if the destructive path exists, an agent will eventually find it.
