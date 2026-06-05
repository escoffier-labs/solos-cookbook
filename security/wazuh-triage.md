# Wazuh Triage: RCA, Fix, Narrow Suppress, One Pass

> When a Wazuh alert fires, find the root cause first, fix the underlying problem, and only then write the narrowest possible suppression. Do all three in one pass so the alert channel stays high-signal. 🦞

**Tested on:** Wazuh manager 4.14.5 in an LXC container, watching a 14-agent home fleet (one AI agent host, one hypervisor, one Windows desktop, plus containers)
**Last updated:** 2026-06-04

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

The point: tune the agent host's noise sources deliberately, but do not turn off the categories that would also catch a compromise. An attacker on an agent host looks a lot like the agent. That is exactly why you keep the rules on and tune by narrow exception instead.

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

Create the list, one entry per line, `key:value` (value optional):

```
# /var/ossec/etc/lists/agent-expected-paths
/home/you/.openclaw/workspace/nightshift/.sandbox-bin:
/home/you/bin:
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
- **Dedup by rule ID plus agent in a time window.** If rule 2902 fires 40 times on one agent in five minutes, send one message that says "rule 2902 x40 on <agent>", not 40 messages. A small forwarding script keyed on `(rule_id, agent_id)` with a short cooldown does this. The Wazuh integration (`<integration>` block in `ossec.conf`) is the hook point; the dedup logic lives in the receiving script or your automation layer.
- **Escalate the cluster, mute the singletons.** As in example 2, use a frequency rule so a burst pages you once at high level while the individual events stay quiet.

Either way, the goal is one message per distinct problem, not one per event. The fleet is small enough that any real cluster is a real thing worth one ping.

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
```

Expected: dry run prints OK, manager is active, agent list shows your fleet active. Then watch the alert stream for the next cycle to confirm the targeted alert is gone and adjacent alerts still fire. A suppression you do not watch land is a suppression you cannot trust.

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

## Related

- [`incident-runbook.md`](incident-runbook.md) - when an alert turns out to be a real incident, this is the response sequence
- [`agent-security-hardening.md`](agent-security-hardening.md) - reduce the agent's attack surface so there is less to alert on
- [`linux-hardening.md`](linux-hardening.md) - host hardening that cuts down baseline noise (SSH lockdown, service binding)
- [`../infrastructure/homelab-topology.md`](../infrastructure/homelab-topology.md) - the fleet layout: agent host, hypervisor, desktop, containers, and where the manager runs
