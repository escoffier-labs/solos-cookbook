# Wazuh Triage: RCA, Fix, Narrow Suppress, One Pass

> When a Wazuh alert fires, find the root cause first, fix the underlying problem, and only then write the narrowest possible suppression. Do all three in one pass so the alert channel stays high-signal. 🦞

**Tested on:** Wazuh manager 4.14.8 (all-in-one: manager, indexer, dashboard in one LXC container, Debian 12), watching a 21-agent home fleet (one AI agent host, one hypervisor, Windows desktops, security VMs, plus containers). Earlier sections were written against 4.14.5.
**Last updated:** 2026-10-17

---

## Why This Matters

A self-hosted SIEM is only useful if you trust the alerts. The failure mode is not too few alerts, it is too many. After a week of a noisy ruleset, you start ignoring the channel, and the one real alert that matters scrolls past unread.

The temptation when an alert is annoying is to disable the rule. That is the wrong move almost every time. Disabling rule 510 because rootcheck keeps flagging your shadow-utils binaries also disables it for the actual trojaned binary you bought the SIEM to catch. Blanket suppression trades a noisy channel for a blind one.

The discipline here is a single pass with three steps, in order:

1. **Root-cause the alert.** Is it a real finding, a false positive, or a misfiring CPE/signature match? You cannot suppress correctly until you know which.
2. **Fix the underlying issue** if there is one. Patch the package, mask the crash-looping service, remove the exposed listener. Most alerts that look like noise are actually a small real problem.
3. **Write the narrowest suppression** that silences exactly this case and nothing adjacent. Scope it by rule ID plus field match, never by disabling the parent rule.

If you skip step 1 you suppress real signal. If you skip step 2 the alert comes back. If step 3 is too broad you create a blind spot. One pass, all three.

## The Agent-Host Problem

A normal Linux box generates a predictable trickle of security events. An always-on AI agent host does not. The agent runs thousands of shell commands a day: it greps, it edits configs, it restarts services, it pokes at package managers, it spawns subprocesses, it touches files all over the tree. To an EDR-style ruleset this looks like a very busy, slightly suspicious human who never sleeps.

Concrete noise sources unique to an agent host:

- **Command-execution rules** (`group:syslog`, sudo/auth rules) fire constantly because the agent legitimately runs privileged commands all day. You will see far more 5402/5403-class events than on a human-operated box.
- **FIM (file integrity monitoring)** lights up because the agent edits config files, writes memory cards, and rewrites scripts as part of normal work. Rule 550 (checksum changed) is real signal you mostly want to keep, but you need to scope FIM directories tightly or it drowns everything else.
- **Rootcheck** flags the agent's temp files, sandbox shims, and any hidden dotfiles it creates.
- **Process anomaly rules** can trip on the agent spawning lots of short-lived children.
- **Disk and syslog error rules** can flood when a different host in the fleet runs out of space and its logs repeat the same error thousands of times (next section).

The point: tune the agent host's noise sources deliberately, but do not turn off the categories that would also catch a compromise. An attacker on an agent host looks a lot like the agent. That is exactly why you keep the rules on and tune by narrow exception instead.

## The 2026-09 Alert Flood That Filled the SIEM

The worst triage failure I have had was not a noisy rule I suppressed wrongly. It was a noisy rule I did not suppress at all, and it took the SIEM itself down.

**What happened.** Rule 1007 ("File system full", level 7, matches `file system full` or `No space left on device`) started firing from one threat-intel container whose own disk was full, and every log line about it generated another alert. Over about 40 days that rule produced roughly 52.8 million alerts. The flood filled the Wazuh container's disk, the indexer crossed OpenSearch's flood-stage watermark, and on 2026-09-11 every index went read-only. No alerts were indexed for 13 days. The manager kept receiving events, and its on-disk archives were complete, so a triage pass that read the archives instead of the index saw a healthy system and missed the gap.

**Root cause, three parts:**

1. The flood source was a true positive (a full disk) reporting itself in a tight loop. Rule 1007 had no rate cap.
2. The SIEM's own disk had no retention. Raw alerts and indexed data grew until the container was full.
3. Nothing watched the watcher. The chat channel was the only consumer, and it depended on the indexer being writable.

**Fix:**

- Grew the SIEM container's disk (50G to 100G).
- Added an OpenSearch ISM (index state management) policy that deletes `wazuh-alerts-*` indices after 90 days, and kept raw alert files on the manager for 30 days.
- Added a rate cap on the flooding rule, a local early-warning rule that fires at 90% partition usage (level 10, with a 2-hour ignore window so it does not repeat), and a self-health check that compares indexer daily document counts to archive counts.
- Applied the same retention thinking to the other disk eaters on the fleet: Suricata log rotation (eve logs 14 days, fast logs 90 days, stats 7 days) and a larger disk on the NIDS VM.

The retention policy is an ISM policy applied through the indexer's `_plugins/_ism/policies/<name>` endpoint, using the indexer admin client certificate rather than a password. Mine is named for its 90-day window, so `ISM` plus the number is easy to find in the policy list. Make sure the policy's index template pattern actually matches `wazuh-alerts-*`, and check a day-old index to confirm it picked up the policy.

**Triage rule that came out of it:** check the indexer's daily document counts, not only the archives, and count a missing day as an incident. A green manager does not prove the index is writable.

## local_rules.xml Hygiene

All your custom rules and suppressions live in one file on the manager:

```
/var/ossec/etc/rules/local_rules.xml
```

Rules:

1. **Back up before every edit.** Keep timestamped copies next to the file.

   ```bash
   cp /var/ossec/etc/rules/local_rules.xml \
      /var/ossec/etc/rules/local_rules.xml.bak-$(date +%Y%m%d-%H%M%S)
   ```

2. **Use the custom rule ID range.** Wazuh reserves `100000`+ for your rules. Start at `100000` and go up. Never reuse a built-in rule's ID.

3. **Comment every suppression.** Each custom rule needs a one-line `<!-- -->` saying what it suppresses and why, with the date and the evidence you used to confirm it was benign. Future you will not remember why rule 100101 exists.

4. **Validate before restart.** A syntax error in `local_rules.xml` keeps the whole manager from starting. Dry-run first:

   ```bash
   /var/ossec/bin/wazuh-analysisd -t
   ```

   Silent output with exit code 0 means good. Only then restart:

   ```bash
   systemctl restart wazuh-manager
   ```

   Note: `wazuh-control configtest` does not exist. The control binary only does start/stop/restart/status. Use `wazuh-analysisd -t` for the dry run.

### OS_Regex Gotchas (these will bite you)

The Wazuh rule matchers are not PCRE. Two traps cost real time:

- **`<regex>` does not support optional groups.** Patterns like `(/usr)?/bin/passwd` cause `wazuh-analysisd: ERROR: (5107): Syntax error on tag 'regex'` and the manager refuses to start. Use pipe-separated full alternatives instead: `/bin/passwd|/usr/bin/passwd`, or rely on substring matching.
- **`<match>` is substring-only, no alternation.** If you need OR logic, use `<regex>`. If you just need a substring, use `<match>` because it is cheaper.

## Levels and Tuning

Wazuh rules have a level 0 to 15. Level is your primary tuning knob, and you have more options than on/off:

| Action | When to use |
|--------|-------------|
| Set level to 0 | Full suppress. The event is decoded but generates no alert. Use for confirmed false positives. |
| Lower the level | The event is real but lower priority than the default. Drops it below your alerting threshold without going dark. |
| Keep the level, route differently | The event is real and you want it, just not paging you at 3am. Keep it in the dashboard, exclude from chat. |

Your alert-to-chat threshold is usually level 7 and up. A custom rule that sets a noisy-but-real event from level 7 down to level 3 keeps it queryable in the dashboard while taking it out of the chat firehose. That is often the right answer for things like dpkg install events during a change window: real signal, but not worth a notification each time.

Things worth keeping unsuppressed even though they are frequent on an agent host:

| Rule | Level | Why keep it |
|------|-------|-------------|
| 2902 | 7 | dpkg new install. Real signal during change windows. |
| 550 | 7 | FIM checksum changed. Useful audit trail, scope the dirs instead of muting the rule. |
| systemd L5 service-exit | 5 | A service crash-looping is a real outage (see the worked example below). |

## CDB Lists for Allowlists

When you are suppressing many specific values of the same kind (known-good file paths, expected process names, allowlisted source IPs), do not write one custom rule per value. Use a CDB list: a flat key/value file Wazuh loads into memory and matches against with `<list>`.

Create the list, one entry per line, `key:value` (value optional). Replace `/absolute/path/to/agent-home` with the monitored account's absolute home directory:

```
# /var/ossec/etc/lists/agent-expected-paths
/absolute/path/to/agent-home/.openclaw/workspace/nightshift/.sandbox-bin:
/absolute/path/to/agent-home/bin:
```

Compile and reference it. Add to `ossec.conf`:

```xml
<ruleset>
  <list>etc/lists/agent-expected-paths</list>
</ruleset>
```

Then match in `local_rules.xml`:

```xml
<rule id="100110" level="0">
  <if_sid>554</if_sid>
  <field name="file">
    <list field="file" lookup="address_match_key">etc/lists/agent-expected-paths</list>
  </field>
  <description>Suppress FIM on agent-expected sandbox paths (CDB allowlist)</description>
</rule>
```

CDB lists scale where individual rules do not. When the allowlist grows, you edit a flat file instead of authoring XML.

## Worked Example 1: Rootcheck "Trojaned Version of File"

**The alert.** Rule 510 (rootcheck), level 7, fired repeatedly against `/bin/passwd`, `/bin/chsh`, `/bin/chfn`, and the rest of the SUID shadow-utils. Description: "Trojaned version of file detected."

**RCA.** Rootcheck's trojan signature is a generic string match (`bash`, `file.h`, `proc.h`, `/dev/ttyo`, and similar tokens) against the binary contents. The SUID shadow-utils legitimately contain some of those byte sequences. This is a signature misfire, not a compromise. Confirmed clean with the package manager's own verifier:

```bash
dpkg --verify passwd
```

No output means the on-disk files match the package's recorded checksums. The binaries are pristine. The signature is just too loose.

**Fix.** There is nothing to fix on the host. The binaries are correct. The fix is entirely on the SIEM side: stop the false positive without blinding rootcheck to a real trojaned binary.

**Narrow suppression.** Scope to rule 510 AND the specific shadow-utils paths. Anything outside that path list still alerts.

```xml
<!-- 100100: Suppress rootcheck 510 trojan FP on SUID shadow-utils.
     dpkg --verify confirms clean 2026-04-15. Generic signature matches
     normal byte sequences in these binaries. Other paths still alert. -->
<rule id="100100" level="0">
  <if_sid>510</if_sid>
  <match>Trojaned version of file</match>
  <regex>/bin/chsh|/bin/chfn|/bin/passwd|/bin/chage|/bin/gpasswd|/bin/newgrp|/bin/expiry</regex>
  <description>Rootcheck trojan FP on shadow-utils (verified clean)</description>
</rule>
```

The `<regex>` uses substring alternation so it covers both `/bin/passwd` and `/usr/bin/passwd`. It does not use an optional group, which would crash the manager. Rule 510 on any other path is untouched. If a binary outside this list ever trips the signature, you still get paged.

## Worked Example 2: A Service Crash-Looping Behind a Quiet Channel

**The alert.** Systemd service-exit alerts (level 5) flooding from one container's agent: 49 in the recent window, and it turned out to be running for 32 days unnoticed because each individual alert was below the chat threshold.

**RCA.** A DNS service container had run out of disk, then its YAML config got corrupted with an orphaned key. The service crash-looped over 68,000 times across a month. Nobody saw it because the network silently fell back to an upstream resolver, so there was no user-visible outage, and the level-5 alerts never crossed into chat. The SIEM was technically recording the problem the whole time. The signal was there, the routing was wrong.

**Fix.** Resize the disk, repair the corrupted config line, clear the failed unit state, restart:

```bash
systemctl reset-failed <service>
systemctl restart <service>
```

The underlying problem was real. This is the opposite of a false positive: it is a true positive that got buried. You do not suppress this. You fix the service.

**The tuning that matters here is not a suppression, it is an escalation.** Continuous L5 service-exit from the same agent and service is a real outage signature. Add a custom rule that correlates frequency and bumps the level so it crosses into chat:

```xml
<!-- 100120: Escalate repeated systemd service-exit (L5) from one agent.
     Continuous crash-loop = real outage. Frequency correlation, not
     suppression. Catches the silent-fallback case from 2026-04. -->
<rule id="100120" level="10" frequency="20" timeframe="600">
  <if_matched_sid>40704</if_matched_sid>
  <same_source_ip />
  <description>Service crash-looping: 20+ systemd L5 exits in 10 min</description>
</rule>
```

This is the inverse of suppression and it belongs in the same triage discipline. Sometimes the right answer to a noisy low-level alert is to make it louder when it clusters, not quieter. The single events stay at level 5, the cluster escalates to level 10 and pages you.

## Wiring Alerts to Chat with Dedup

An alert nobody reads is not an alert. Route level 7 and up to a chat channel, but dedup or you recreate the firehose you just tuned away.

Approaches that work:

- **Threshold at the source.** Only forward level 7+. Everything below stays in the dashboard for when you go looking.
- **Dedup by rule ID plus agent in a time window.** If rule 2902 fires 40 times on one agent in five minutes, send one message that says "rule 2902 x40 on <agent>", not 40 messages. A small forwarding script keyed on `(rule_id, agent_id)` with a short cooldown does this. The Wazuh integration (`<integration>` block in `ossec.conf`) is the hook point. The dedup logic lives in the receiving script or your automation layer.
- **Escalate the cluster, mute the singletons.** As in example 2, use a frequency rule so a burst pages you once at high level while the individual events stay quiet.

Either way, the goal is one message per distinct problem, not one per event. The fleet is small enough that any real cluster is a real thing worth one ping.

## Keep Agents From Outrunning the Manager

An agent must never run a newer version than the manager. Agents that are behind are supported. Agents that are ahead are the real problem, because the manager may not understand what they send.

The failure mode is a routine `apt upgrade`. The Wazuh repository publishes a new agent before you have upgraded the manager, and an unattended upgrade walks every Linux agent ahead. I pin them:

```bash
sudo apt-mark hold wazuh-agent
apt-mark showhold | grep wazuh-agent
```

A held `wazuh-agent` showing up forever in `apt list --upgradable` means the guard is working. To upgrade on purpose, go in this order and take a snapshot of the SIEM container first: indexer, then manager, then dashboard, then agents. Upgrade Linux agents with apt (unhold, `apt-get install --only-upgrade wazuh-agent`, hold again, restart), never with a WPK package, which makes dpkg disagree with reality. Windows agents upgrade remotely from the manager:

```bash
/var/ossec/bin/agent_upgrade -l             # fleet drift check
/var/ossec/bin/agent_upgrade -a 001 014     # space-separated agent IDs
```

Agent IDs are space-separated. Commas fail with error 1701.

The hold stops `apt upgrade`. It does not stop a manual `dpkg -i` or a package pulled in another way. I have seen an agent end up a patch release ahead of the manager despite the hold, so check versions after every upgrade. Use the agent list (version column), not an assumption that the hold worked.

## Verification

After any suppression or tuning change:

```bash
# 1. Dry-run the ruleset. Silent + exit 0 = valid.
/var/ossec/bin/wazuh-analysisd -t && echo OK

# 2. Restart only if the dry run passed.
systemctl restart wazuh-manager

# 3. Confirm the manager came back up.
systemctl status wazuh-manager --no-pager

# 4. Confirm agents are still reporting.
/var/ossec/bin/agent_control -l

# 5. Confirm no agent is newer than the manager.
/var/ossec/bin/wazuh-control info | grep WAZUH_VERSION
/var/ossec/bin/agent_upgrade -l

# 6. Confirm the indexer is writable and retention is in place (run from the SIEM host).
C="--cert /etc/wazuh-indexer/certs/admin.pem --key /etc/wazuh-indexer/certs/admin-key.pem"
curl -sk $C "https://localhost:9200/_cat/indices/wazuh-alerts-*?h=index,docs.count&s=index:desc" | head -3
curl -sk $C "https://localhost:9200/_plugins/_ism/policies" | jq '.policies[].policy.policy_id'
df -h /var/ossec /var/lib/wazuh-indexer | tail -n +2
```

Expected: dry run prints OK, manager is active, agent list shows your fleet active (one disconnected laptop is normal). The agent version lines show nothing newer than the manager. The newest alert index has a document count for today, the retention policy ID is listed, and the disks are under about 80%. Then watch the alert stream for the next cycle to confirm the targeted alert is gone and adjacent alerts still fire. A suppression you do not watch land is a suppression you cannot trust.

To confirm a suppression is narrow and not blanket, query the parent rule and make sure non-matching cases still alert:

```bash
# Via the API / MCP: pull recent alerts for the parent rule ID
# and verify only the intended field-match cases stopped firing.
```

## Gotchas

1. **Disabling a rule is almost never the answer.** A blanket disable on rule 510 or 23505 trades a noisy channel for a blind spot. Always scope by `if_sid` plus a field or path match.

2. **A syntax error keeps the whole manager down.** One bad tag in `local_rules.xml` and `wazuh-manager` will not start, so your entire fleet goes unmonitored. Always `wazuh-analysisd -t` before restart, always keep a timestamped backup.

3. **CPE version matchers misfire on major-version prefixes.** The vuln-detector flagged a 2016 polkit CVE against a fully patched 2024 polkit because the matcher keyed on the major version. Confirm with the package manager (`dpkg -l`, compare installed vs candidate) before you decide it is a false positive, then suppress by rule ID plus the specific CVE string.

4. **`<regex>` has no optional groups.** `(/usr)?/bin/x` crashes the manager. Use pipe alternation: `/bin/x|/usr/bin/x`.

5. **Lag is not a false positive.** Right after a patch, the vuln-detector may still alert until its next scan reconciles installed versions. Check installed-vs-candidate before suppressing. If they match, it is lag, give it a cycle before writing any rule.

6. **The agent host's noise overlaps with compromise.** An attacker on an AI agent host looks like the agent: lots of shell commands, lots of file edits, privileged operations. Tune narrowly, never mute whole categories. The exception you write should match the agent's specific benign pattern, not the category it lives in.

7. **A true positive can hide below your chat threshold.** A crash-loop at level 5 ran for 32 days unseen because nothing escalated the cluster. Triage is not only about quieting noise, it is also about making sure real clustered signal gets loud.

8. **Scope FIM, do not mute it.** FIM is high-value on an agent host because the agent edits files constantly and so would an attacker. Narrow the monitored directories and use a CDB allowlist for known-good paths. Do not disable rule 550.

9. **A SIEM needs its own retention and its own disk alarm.** Retention on the indexer and logs is part of the install, not later cleanup. The 2026-09 flood happened because the thing collecting disk-full alerts had no protection against its own disk filling.

10. **A true-positive flood is still a flood.** Rule 1007 was telling the truth about a full disk and still took out the SIEM. Cap the rate of any rule a single sick host can trigger in a loop (`frequency`/`timeframe`, or `<ignore>` for repeats), and alert on the first instance, not the millionth.

11. **Check the index, not the archive.** Manager archives can be complete while the indexer is read-only. A daily indexer-count check catches the gap in a day instead of two weeks.

12. **Do not let agents outrun the manager.** Hold the agent package, and confirm versions from the agent list.

## Related

- [`incident-runbook.md`](incident-runbook.md) - when an alert turns out to be a real incident, this is the response sequence
- [`agent-security-hardening.md`](agent-security-hardening.md) - reduce the agent's attack surface so there is less to alert on
- [`linux-hardening.md`](linux-hardening.md) - host hardening that cuts down baseline noise (SSH lockdown, service binding)
- [`mcp-incident-response.md`](mcp-incident-response.md) - the agent-driven loop that reads these alerts, and the read-only credentials to give it
- [`../infrastructure/homelab-topology.md`](../infrastructure/homelab-topology.md) - the fleet layout: agent host, hypervisor, desktop, containers, and where the manager runs
