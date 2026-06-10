# MCP-Driven Incident Response: One Operator, One Agent, A Whole SOC

> A self-hosted SOC where an AI agent drives incident response through MCP servers you wrote yourself. A SIEM alert fires, the agent triages it, opens a case, runs observable analysis, enriches indicators against threat intel, and maps the activity to ATT&CK. The agent proposes every write. You approve the ones that matter. 🦞

**Tested on:** Wazuh manager 4.14.5 in an LXC container on a home Proxmox host watching a ~14-agent fleet; TheHive 5.4.11, Cortex 3.x, and MISP running as Hyper-V VMs on a Windows desktop; five first-party MCP servers (wazuh-mcp, thehive-mcp, cortex-mcp, misp-mcp, mitre-mcp) wired into one agent
**Last updated:** 2026-06-10

> The tool calls below are representative. The stack is real and running, but specific alert IDs, case numbers, and job IDs in the walkthrough are illustrative placeholders, not transcripts of a single incident.

---

## What this is

This is the loop a single operator runs when an AI agent does the SOC analyst work and the human stays in the approval seat.

The classic problem with a one-person SOC is that the tooling is built for teams. Wazuh, TheHive, Cortex, and MISP each have their own UI, their own auth, their own mental model. Pivoting an alert into a case, the case observables into Cortex, the Cortex verdicts into MISP, and the whole thing onto an ATT&CK matrix means five tabs and a lot of copy-paste. One person does not have the hours.

The fix here is to put each platform behind an MCP server and give one agent all five. The agent reads from every platform freely, correlates across them in a single turn, and proposes the write actions (open this case, add these observables, run this analyzer). The human reads the proposal and approves or rejects. The agent does the tab-switching and the copy-paste. The operator does the judgment.

Every MCP server in this loop is first-party. They are not wrappers someone else shipped; they are the operator's own code in `escoffier-labs` / `solomonneas`, which matters because it means the safety gates described below are auditable, not assumed.

## Why this way

Three design choices make this safe enough to actually run.

**1. Reads are free, writes are gated.** Each server tiers its tools into read, safe-write, and destructive. The agent can query the SIEM, list cases, pull analyzer reports, and search threat intel all day without a confirmation. The actions that change state or cause real-world side effects are off by default and require either an environment opt-in, a per-call `confirm` flag, or both. The agent cannot delete a case or detonate a sample just because it decided to.

**2. The human gate is structural, not a vibe.** "The agent proposes, the human approves" only works if the agent literally cannot execute the dangerous action without you. That is enforced in the server, not in the prompt. A prompt that says "ask before deleting" is a suggestion an LLM can rationalize past. An env var that the destructive tool checks before running is not.

**3. One agent, many servers, cross-stack correlation in one turn.** The point of MCP is that the agent holds context across all five platforms simultaneously. It can take a Wazuh rule ID, map it to an ATT&CK technique, pull every MISP event tagged with that technique, and check whether the source IP is already a known indicator, without you brokering data between five tools. mitre-mcp goes further and offers its own cross-stack tools that reach into the other platforms directly.

## Prerequisites

- A running Wazuh manager with REST API access, and the Wazuh Indexer (OpenSearch) reachable if you want alert and vulnerability queries (wazuh-mcp needs the indexer for `get_alerts` / `search_alerts`).
- TheHive 5.x with a non-admin org and an `org-admin` user (the `admin` org only has platform permissions, not case access).
- Cortex 3.x with at least a few analyzers enabled, connected to TheHive.
- MISP with API access and an auth key.
- An MCP-capable agent host (Claude Code, Claude Desktop, Codex CLI, OpenClaw, or any MCP client).
- The five MCP servers built and registered: wazuh-mcp, thehive-mcp, cortex-mcp, misp-mcp, mitre-mcp.
- API credentials for each platform, stored as environment variables, never inline in a guide or a commit.

On the deployment: the SIEM container runs on the hypervisor and watches the fleet. TheHive, Cortex, and MISP run as VMs on the Windows VM host. The agent host talks to all of them over the LAN. Refer to machines by role; do not hardcode hostnames or IPs anywhere the agent or its config can leak them.

## The loop

```
   Wazuh alert fires
          │
          ▼
  ┌───────────────┐   wazuh-mcp: get_alert / get_alerts / search_alerts,
  │  1. TRIAGE    │   get_rule, get_agent, get_agent_processes/ports
  └───────┬───────┘   (read-only; agent reads freely)
          │
          ▼
  ┌───────────────┐   thehive-mcp: thehive_create_case (GATED),
  │  2. OPEN CASE │   thehive_create_task, thehive_create_observable_bulk
  └───────┬───────┘   (write; human approves)
          │
          ▼
  ┌───────────────┐   cortex-mcp: cortex_analyze_observable,
  │  3. ANALYZE   │   cortex_run_analyzer, cortex_wait_and_get_report
  └───────┬───────┘   (analyzers safe-ish; responders GATED)
          │
          ▼
  ┌───────────────┐   misp-mcp: misp_correlate, misp_search_attributes,
  │  4. ENRICH    │   misp_check_warninglists, misp_add_attributes_bulk (GATED)
  └───────┬───────┘   (lookups free; writes/publish GATED)
          │
          ▼
  ┌───────────────┐   mitre-mcp: mitre_map_wazuh_alert,
  │  5. MAP ATT&CK│   mitre_thehive_enrich, mitre_cross_correlate
  └───────┬───────┘   (lookups free; SOC writes dry-run by default)
          │
          ▼
   Human reviews the case, approves the gated writes,
   closes the case with a resolution status.
```

The agent walks this top to bottom in a single conversation, narrating what it finds and stopping at each gated action to ask for approval.

## Walkthrough

What follows is a representative pass through the loop. Tool names are exact. Arguments are illustrative.

### Stage 1: Triage the alert (wazuh-mcp, read-only)

A level-10 alert fires for repeated failed authentication followed by a success on one fleet host. The agent pulls it and the surrounding context.

```
get_alerts  { "level": 10, "limit": 5, "search": "authentication" }
get_alert   { "alert_id": "<illustrative-id>" }
get_rule    { "rule_id": "5710" }
get_agent   { "agent_id": "007" }
```

If it wants to know whether the box is actually compromised rather than just noisy, it pulls live inventory from the agent:

```
get_agent_processes { "agent_id": "007", "include_command": true }
get_agent_ports     { "agent_id": "007" }
get_agent_network   { "agent_id": "007", "include_ip": true }
```

Note the opt-in flags. wazuh-mcp minimizes sensitive output by default: process command lines, agent IPs, and FIM hashes are hidden unless the call explicitly asks for them. The agent asks for them here because it is actively investigating, and that choice is visible in the transcript.

**What the agent does:** decides whether this is a real finding or tuning noise. (For the discipline of telling those apart and writing a narrow suppression when it is noise, see `wazuh-triage.md`.) If it is real, it pulls out the observables: the source IP of the brute force, the targeted username, the agent host, timestamps. No writes have happened yet. Everything so far is a read.

### Stage 2: Open a case with tasks and observables (thehive-mcp, GATED writes)

The agent proposes a case. This is the first gate.

```
thehive_create_case {
  "title": "Brute-force then success on fleet host 007",
  "description": "Rule 5710 cluster followed by 4624-equivalent success ...",
  "severity": 2,
  "tags": ["wazuh", "auth", "lateral-movement-suspect"]
}
```

`thehive_create_case` is a state-changing write. `description` is required (TheHive 5 rejects cases without one). The agent proposes the full payload and stops. You read it. You approve.

Once the case exists, the agent scaffolds the investigation:

```
thehive_create_task            { "case_id": "~1234", "title": "Confirm source IP reputation" }
thehive_create_task            { "case_id": "~1234", "title": "Check for lateral movement from 007" }
thehive_create_observable_bulk {
  "case_id": "~1234",
  "data_type": "ip",
  "observables": ["198.51.100.23"]
}
```

The agent can also pull a case template with `thehive_list_case_templates` if you keep a standard auth-incident layout, and it can summarize the whole case at any point with `thehive_case_timeline_summary`.

**The destructive verbs stay off.** `thehive_delete_case`, `thehive_delete_alert`, `thehive_merge_cases`, and `thehive_promote_alert` require `THEHIVE_ALLOW_DESTRUCTIVE_TOOLS=true` in the server environment. If you never set it, the agent simply cannot call them, no matter what it decides. The raw Query DSL tool (`thehive_query`) is likewise gated behind `THEHIVE_ENABLE_RAW_QUERY=true`.

### Stage 3: Analyze the observables (cortex-mcp)

Now the agent enriches the case's observables through Cortex analyzers.

```
cortex_list_analyzers   { "dataType": "ip" }
cortex_analyze_observable {
  "data": "198.51.100.23",
  "analyzers": ["Abuse_Finder_3_0", "MaxMind_GeoIP_4_0"]
}
cortex_wait_and_get_report { "jobId": "<illustrative-job-id>" }
cortex_get_job_artifacts   { "jobId": "<illustrative-job-id>" }
```

Two safety details matter here.

`cortex_analyze_observable` does **not** fan out to every analyzer by default. The agent must pass an explicit `analyzers` allowlist, or set `fanOut=true` to run all applicable analyzers (capped by `CORTEX_MAX_FANOUT`). That keeps a curious agent from submitting your internal IP to forty third-party services in one call.

**Responders are the hard gate.** `cortex_run_responder` causes real-world side effects (block an IP at the firewall, disable an account, send a notification). It requires both `CORTEX_ALLOW_DESTRUCTIVE=1` in the environment **and** `confirm=true` in the call. Two locks, deliberately. The agent can recommend "we should run the block-IP responder" in prose; it cannot pull that trigger on its own.

File analysis is sandboxed too: `cortex_run_analyzer_file` only reads files inside `CORTEX_FILE_BASE_DIR` (realpath-confined against symlink and `..` escapes), and if that dir is unset, path-based reads are refused entirely and you must submit content via `fileBase64`.

**What the agent does:** reads the analyzer taxonomy verdicts, writes them back as task logs or comments on the case (`thehive_create_task_log`, `thehive_create_comment`), and flags whether the source IP came back malicious, suspicious, or clean.

### Stage 4: Enrich against threat intel (misp-mcp)

The agent checks the indicators against your MISP instance and the feeds it pulls.

```
misp_correlate          { "value": "198.51.100.23" }
misp_search_attributes  { "value": "198.51.100.23", "type": "ip-src" }
misp_check_warninglists { "value": "198.51.100.23" }
misp_get_related_events { "value": "198.51.100.23" }
```

`misp_check_warninglists` is the false-positive guard. If the IP is on a known-benign list (cloud provider ranges, public resolvers), the agent learns that before it escalates, and the case gets downgraded instead of over-reacted to.

If the indicator is genuinely new and worth keeping, the agent proposes writing it back to a MISP event. This is gated.

```
misp_add_attributes_bulk {
  "event_id": "<illustrative-event-id>",
  "attributes": [
    { "type": "ip-src", "value": "198.51.100.23", "category": "Network activity" }
  ]
}
```

**MISP writes are guarded.** `misp_delete_event`, `misp_delete_attribute`, `misp_delete_object`, `misp_publish_event`, and tag removal require `confirm:true`. Setting `MISP_ALLOW_DESTRUCTIVE=true` pre-authorizes those for trusted automation, but permanent hard deletes need a second `confirmHard:true` that the env opt-in does not bypass. Publishing an event (which alerts your sharing partners) is intentionally not something the agent does without a confirm.

**What the agent does:** decides whether the indicator is known-bad (escalate), known-good (downgrade), or net-new intel (propose adding it to MISP and tagging the event).

### Stage 5: Map to ATT&CK (mitre-mcp)

Finally the agent frames the activity in ATT&CK terms so the case has analytic structure, not just raw events.

```
mitre_map_wazuh_alert { "ruleId": "5710", "ruleGroups": ["authentication_failed", "sshd"] }
mitre_get_technique   { "id": "T1110" }
mitre_thehive_enrich  { "caseId": "~1234", "techniques": ["T1110", "T1078"] }
```

mitre-mcp ships its own cross-stack tools that reach into the other platforms directly. `mitre_cross_correlate` searches a set of techniques across Wazuh, TheHive, and MISP at once:

```
mitre_cross_correlate { "techniques": ["T1110", "T1078"] }
```

**Its SOC writes default to dry-run.** `mitre_misp_create_event`, `mitre_thehive_create_case`, and `mitre_cortex_run_analyzers` return the action they *would* perform unless you pass `confirm:true` or set `MITRE_SOC_ALLOW_WRITES=true`. The highest-impact one, `mitre_cortex_run_analyzers`, can trigger live sandbox detonation, so it gets confirmed deliberately, never reflexively. `mitre_thehive_enrich` is read-mostly and only writes tags when you pass `addTags:true`.

**What the agent does:** attaches techniques and their mitigations to the case, optionally generates a Navigator layer (`mitre_navigator_layer`) so you can see where this incident sits on the matrix, and produces the case summary you actually read.

## The human gate

These are the actions that must not happen without an explicit human approval. The agent surfaces the proposed call and its arguments; you say yes or no.

| Action | Tool | What gates it |
|--------|------|---------------|
| Create / update a case | `thehive_create_case`, `thehive_update_case` | Write; agent proposes full payload, you approve |
| Delete / merge / promote | `thehive_delete_case`, `thehive_merge_cases`, `thehive_promote_alert`, `thehive_delete_alert` | `THEHIVE_ALLOW_DESTRUCTIVE_TOOLS=true` (leave it off) |
| Raw query DSL | `thehive_query` | `THEHIVE_ENABLE_RAW_QUERY=true` |
| Run a Cortex responder (real-world action) | `cortex_run_responder` | `CORTEX_ALLOW_DESTRUCTIVE=1` **and** `confirm=true` |
| Disable analyzer / delete job | `cortex_disable_analyzer`, `cortex_delete_job` | `confirm=true` |
| Fan out to all analyzers | `cortex_analyze_observable` | Off by default; needs explicit `analyzers` or `fanOut=true` |
| Add / delete IOC, publish event | `misp_add_attributes_bulk`, `misp_delete_event`, `misp_publish_event` | `confirm:true` (hard delete also `confirmHard:true`) |
| Cross-stack SOC writes | `mitre_misp_create_event`, `mitre_thehive_create_case`, `mitre_cortex_run_analyzers` | dry-run unless `confirm:true` or `MITRE_SOC_ALLOW_WRITES=true` |

The rule of thumb: anything that creates, mutates, deletes, publishes externally, or causes a real-world side effect is a gate. Everything that only reads is free. The operator's attention is the scarce resource, so it gets spent on the writes, not the reads.

## Wiring the MCP servers into your agent

Register all five servers with your agent. The shape below uses Claude Code; the same env vars apply to Claude Desktop JSON, Codex CLI, and OpenClaw. Keep every credential in the environment, never in the guide. Use role-based placeholder hostnames and document-only IP ranges (`192.0.2.x`) in any example you commit.

```bash
# SIEM (reads free; needs the indexer for alert queries)
claude mcp add wazuh \
  --env WAZUH_URL=https://siem.example.internal:55000 \
  --env WAZUH_USERNAME=wazuh-wui \
  --env WAZUH_PASSWORD="$WAZUH_PASSWORD" \
  --env WAZUH_INDEXER_URL=https://siem.example.internal:9200 \
  --env WAZUH_INDEXER_USERNAME=admin \
  --env WAZUH_INDEXER_PASSWORD="$WAZUH_INDEXER_PASSWORD" \
  -- wazuh-mcp

# Case management. Destructive verbs left OFF on purpose.
claude mcp add thehive \
  --env THEHIVE_URL=http://thehive.example.internal:9000 \
  --env THEHIVE_API_KEY="$THEHIVE_API_KEY" \
  -- thehive-mcp
  # NOT set: THEHIVE_ALLOW_DESTRUCTIVE_TOOLS, THEHIVE_ENABLE_RAW_QUERY

# Observable analysis. Responders left OFF on purpose.
claude mcp add cortex \
  --env CORTEX_URL=http://cortex.example.internal:9001 \
  --env CORTEX_API_KEY="$CORTEX_API_KEY" \
  -- cortex-mcp
  # NOT set: CORTEX_ALLOW_DESTRUCTIVE (responders stay disabled)

# Threat intel. Destructive + publish left gated by per-call confirm.
claude mcp add misp \
  --env MISP_URL=https://misp.example.internal \
  --env MISP_API_KEY="$MISP_API_KEY" \
  --env MISP_VERIFY_SSL=false \
  -- misp-mcp
  # NOT set: MISP_ALLOW_DESTRUCTIVE (writes need confirm:true)

# ATT&CK mapping + cross-stack. SOC writes stay dry-run.
claude mcp add mitre-attack \
  --env MITRE_MATRICES=enterprise \
  --env WAZUH_URL=https://siem.example.internal:55000 \
  --env WAZUH_USERNAME=wazuh-wui \
  --env WAZUH_PASSWORD="$WAZUH_PASSWORD" \
  --env THEHIVE_URL=http://thehive.example.internal:9000 \
  --env THEHIVE_API_KEY="$THEHIVE_API_KEY" \
  --env CORTEX_URL=http://cortex.example.internal:9001 \
  --env CORTEX_API_KEY="$CORTEX_API_KEY" \
  --env MISP_URL=https://misp.example.internal \
  --env MISP_API_KEY="$MISP_API_KEY" \
  -- mitre-mcp
  # NOT set: MITRE_SOC_ALLOW_WRITES (cross-stack writes stay dry-run)
```

The deliberate omissions are the whole point. Every `# NOT set` line above is a destructive capability you are choosing to leave disabled. The default-deny posture means a misbehaving or jailbroken agent hits a wall at the server, not at the prompt. Turn a gate on only when you have a specific, supervised reason, and turn it back off after.

A few env-gating notes worth keeping straight:

- **wazuh-mcp** redacts sensitive fields by default (IPs, command lines, hashes, manager secrets). The agent opts in per call with flags like `include_command`. `get_manager_config` stays redacted even with the opt-in flag unless `WAZUH_ALLOW_SENSITIVE_CONFIG=true` is set server-side.
- **TheHive 5** needs a real org. The `admin` org cannot manage cases; create a `SOC` org with an `org-admin` user and key the MCP server to that.
- **SSL verification** is scoped per client in every server. Setting `*_VERIFY_SSL=false` for a self-signed lab box relaxes TLS only for that one platform's requests, never process-wide.

## Verification

After wiring, confirm the agent actually sees each server and that the gates are where you think they are.

```bash
# 1. All five servers register.
claude mcp list   # expect: wazuh, thehive, cortex, misp, mitre-attack

# 2. Read path works end to end. Ask the agent:
#    "List active Wazuh agents, then list open TheHive cases."
#    -> list_agents (wazuh) + thehive_list_cases (thehive) both return.

# 3. Cross-stack read works. Ask:
#    "Cross-correlate techniques T1110 and T1078 across the SOC."
#    -> mitre_cross_correlate returns hits from Wazuh/TheHive/MISP.

# 4. The gate holds. Ask the agent to delete a test case.
#    -> thehive_delete_case must refuse because
#       THEHIVE_ALLOW_DESTRUCTIVE_TOOLS is unset. If it succeeds,
#       your env is wrong; stop and fix it before going further.

# 5. The responder gate holds. Ask the agent to run a Cortex responder.
#    -> cortex_run_responder must refuse (CORTEX_ALLOW_DESTRUCTIVE unset).
```

Step 4 and step 5 are the ones that matter. A loop that reads is convenient. A loop that cannot delete or detonate without you is the actual safety property. Verify the refusals, not just the successes. If a destructive tool runs when its env gate is unset, treat that as a server bug and a stop-the-line event, not a config preference.

## Gotchas

1. **The indexer is separate from the API.** wazuh-mcp's alert and vulnerability tools (`get_alerts`, `search_alerts`, `list_vulnerabilities`) read from the Wazuh Indexer (OpenSearch), not the REST API. If `WAZUH_INDEXER_URL` is unset, those tools return a config message and your triage stage has no alerts to read. Agents, rules, and inventory still work without it.

2. **TheHive `admin` org cannot manage cases.** If `thehive_create_case` fails with a permissions error, you keyed the server to the `admin` org. Create a dedicated org and an `org-admin` user. This bites everyone once.

3. **`description` is required on cases and alerts.** TheHive 5 rejects creation without it. If the agent drafts a thin case, the create call fails. Make the agent include a real description in every proposal.

4. **Cortex fan-out is opt-in for a reason.** `cortex_analyze_observable` with `fanOut=true` submits the observable to every applicable analyzer, many of them third-party. For an internal IP or an internal hostname, that is data exfiltration with extra steps. Prefer an explicit `analyzers` allowlist; reserve `fanOut` for indicators you are fine sending to VirusTotal-class services.

5. **Warninglists before escalation.** Always run `misp_check_warninglists` before treating an indicator as bad. Public resolvers and cloud ranges trip naive correlation constantly. The agent should downgrade on a warninglist hit, not page you.

6. **mitre-mcp writes are dry-run, which can look like a no-op.** When `mitre_thehive_create_case` "succeeds" but nothing appears in TheHive, it ran in dry-run and returned the action it *would* take. That is the default. Pass `confirm:true` (deliberately, per call) when you actually want the write.

7. **Two MCP servers can touch the same platform.** Both thehive-mcp and mitre-mcp can create TheHive cases. Decide which one owns case creation in your loop so you do not get duplicate cases from one incident. The pattern here: thehive-mcp owns the case lifecycle, mitre-mcp only enriches an existing case with ATT&CK context.

8. **Env opt-ins are session-wide, not per-action.** Setting `MISP_ALLOW_DESTRUCTIVE=true` or `MITRE_SOC_ALLOW_WRITES=true` removes the per-call confirm for *every* call in that session, not just the one you had in mind. If you flip a gate on for one supervised action, flip it back off, or scope it to a separate short-lived agent session.

9. **An agent with all five servers can move fast in the wrong direction.** Cross-stack convenience cuts both ways. The same agent that correlates an incident in one turn can, if a gate is wrong, cascade a mistake across five platforms in one turn. The default-deny env posture is what keeps the blast radius small. Treat every gate you turn on as temporary.

## Related

- [`wazuh-triage.md`](wazuh-triage.md) - the RCA-fix-narrow-suppress discipline for deciding whether a Wazuh alert is real signal or tuning noise before you ever open a case
- [`incident-runbook.md`](incident-runbook.md) - the calm ordering for agent-driven incidents (freeze, preserve, fix); the response sequence this loop plugs into when an alert turns out to be a real incident
- [`agent-security-hardening.md`](agent-security-hardening.md) - treating the agent as an untrusted actor; the philosophy behind the read-free / write-gated split
- [`secret-management.md`](secret-management.md) - keeping the MCP server credentials (API keys, passwords) out of config files, history, and anything the agent can leak
- [`../infrastructure/homelab-topology.md`](../infrastructure/homelab-topology.md) - the fleet and where the SIEM container, the case platform, and the threat-intel VMs actually live
