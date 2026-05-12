# What This Stack Is Not

> Easier to write a cookbook by listing what is not in it. Every entry below is a thing other people put in their stacks, that I tried, considered, or watched fail, and explicitly do not do here.

## What this is

A list of negative space. The technical guides explain how things are done. This explains what is deliberately absent and why. If your stack does include one of these, that is fine; this is not a value judgment of you. It is a clarification of the design constraints behind the rest of the cookbook so you can decide if the patterns generalize to your case.

## Why this matters

A surprising amount of the cookbook's shape only makes sense if you also know what was rejected. A guide that says "use systemd timers" is not interesting on its own. The same guide gets useful when you know it was chosen *over* k8s CronJobs, Airflow, GitHub Actions, Temporal, n8n-for-everything, and a custom Python scheduler.

The cost of leaving the negative space implicit is that readers cargo-cult the visible part of the pattern without absorbing the constraint that produced it. So here is the list, with reasons.

## Hard nos

The list, with a one-line reason and a paragraph of context. Skip to the ones that apply to your stack.

### No Kubernetes

I am not running Kubernetes. Not k3s, not k0s, not microk8s, not "just to learn it." The agent stack and its peripherals fit on one host (see [`why-one-host.md`](why-one-host.md)). Adding k8s to a one-host setup is not "kubernetes-lite"; it is the worst case for k8s, because you are paying the operational cost without getting any of the benefits.

For the homelab side, where there are a handful of services that benefit from isolation (Adguard, n8n, a small social-automation stack), the answer is LXC containers under Proxmox. They are lighter, they boot in under a second, and they speak SSH like a real machine. When LXC becomes insufficient, I will revisit. It has not become insufficient yet.

### No microservices

The agent is one process. The orchestrator is one daemon. The dashboard sidecar is one FastAPI app. Each is a single repo, a single binary, a single systemd unit. Where I have split things, the split is along a real boundary (the dashboard UI talks to the sidecar over HTTP because the UI is a JS bundle and the sidecar is Python), not along an imagined boundary ("the auth service should be separate from the user service").

The rule of thumb: split when the split removes a coupling that was actually causing trouble. Do not split because "modular is better." Modular is not better; coupling is bad, and coupling sometimes correlates with deployment topology, but most of the time it does not.

### No SaaS lock-in

Every paid SaaS in the stack passes one test: I can leave with one weekend of work and lose nothing of value. Examples that pass:

- A subscription LLM API. The agent treats every model as a tool behind a uniform interface; swapping providers is a config edit.
- A SaaS scheduler. The cron config is JSON files in `~/.openclaw/cron/`; if the scheduler died tomorrow, I would rewrite it as a few hundred lines of Python and lose nothing.
- A SaaS dashboard. The data lives in the workspace as flat files; the dashboard is one view over them.

Examples that would fail and are not in the stack:

- A SaaS database with proprietary query language. If your data is in their dialect, you are stuck.
- A SaaS observability platform that holds your historical metrics. Six months in, switching costs are real.
- A SaaS that needs an export step every time you want to read your own data.

The rule: keep your data, your config, and your logic on disk in formats you can read with `cat`. Pay for compute, pay for delivery, never pay for someone to hold your state.

### No untested fashion

A short list of technical fashions I have deliberately not adopted:

| Fashion | Reason for skipping |
|---------|--------------------|
| Service mesh (Istio, Linkerd) | Single-host; mesh solves multi-host problems |
| Event sourcing for the agent's state | The agent's state fits in JSONL files plus a few sqlite databases; "event sourcing" adds replay cost for no real query benefit |
| GraphQL anywhere | The number of queries this stack issues is small enough that REST + a few specific endpoints is cheaper to write and easier to debug |
| GitOps for the homelab | The homelab has maybe ten services. The cost of building a GitOps pipeline exceeds the cost of editing config files |
| Distributed tracing | Useful for systems with many hops between services. This system has approximately one hop |
| A general-purpose feature flag system | I have one engineer. "Comment out the line" is a feature flag |

The pattern: every fashion was invented to solve a real problem at a scale this stack does not have. Adopting it preemptively pays the cost without gaining the benefit.

### No infrastructure-as-code framework for the host

The single host's config is in `/etc/`, version-controlled via etckeeper. systemd units live in `~/.config/systemd/user/` and are backed up by restic. The workspace is at `~/.openclaw/workspace/` and is backed up by restic. That is the entire infrastructure-as-code story.

Ansible, Salt, Pulumi, Terraform, Nix - all are valuable for managing many hosts. None of them earn their keep on one host. The closest the stack gets is a few shell scripts in `~/bin/` that wrap the most-touched config edits, plus a wrapper around `openclaw update` that preserves customizations across upgrades.

If I add a second host that needs the same shape, the cookbook will get a Nix or Ansible guide. Until then, this is YAGNI in its purest form.

### No production secrets in any prompt

The agent is allowed to read env vars in scripts it shells out to. The agent is not allowed to see the values of those env vars directly in its prompt. The orchestrator's secret resolution is one-way: it provides a reference, the resolver substitutes at execution time, the prompt never contains the value.

This is not a usability complaint about LLMs; it is a defense-in-depth posture. A leaked transcript should not also be a leaked credential. The cookbook's secret-management guide ([`../security/secret-management.md`](../security/secret-management.md)) is the implementation; this is the reason.

### No always-on remote access

The agent host is not directly exposed to the internet. SSH from outside the LAN comes through a VPN (the homelab runs Twingate inside an LXC); no port 22 on the public IP, no Cloudflare Tunnel terminating at the host. The dashboard binds to `127.0.0.1` by default and only opens to the LAN when explicitly configured.

The cost: a few seconds of overhead when I am traveling. The benefit: the host's attack surface is the VPN's, not the public internet.

### No vibes-based monitoring

A daily report runs at a fixed hour, classifies a known set of services as up/degraded/down, and posts the result to a single chat channel I read. The report tells me what changed since yesterday and what failed in the last 24 hours. That is the whole monitoring story. There is no Grafana wall, no PagerDuty integration, no metrics retention policy.

This works because:

1. The system is small enough that a daily summary captures the interesting state.
2. The failure modes I care about (cron job failed, backup did not run, browser session died) are all enumerable, not statistical.
3. The latency-sensitive consumer is a person reading a chat channel, not a machine triggering an autoscaler.

A bigger or more public-facing system would warrant real metrics. This one does not.

## Soft nos

Less black-and-white. These are things I am skeptical of but might change my mind on with evidence.

### Skeptical of: running 70B+ local models on the agent host

The math is fine; the operational cost is not. A 70B-class model on the agent host competes for RAM with browser automation, the agent process, and a desktop. Better to dedicate a separate machine to that workload and treat it as a service the agent calls, if and when the workload justifies it.

### Skeptical of: containerizing the agent itself

The agent talks to the filesystem extensively, ships its own plugin loader, and benefits from being a normal user process under systemd. A container would add a layer of indirection without much benefit. The peripheral services (n8n, social automation, the dashboard sidecar) are happily containerized; the agent is not.

### Skeptical of: a "real" CI/CD pipeline for personal repos

GitHub Actions for personal repos that publish to npm: acceptable when it stays out of the way. A full pipeline with staging environments, blue-green deploys, and rollback automation: not for a one-engineer audience. The redeploy script ([`../tools/repo-redeploy.md`](../tools/repo-redeploy.md)) is the entire deploy pipeline. Adding more layers requires evidence the current layer is failing.

### Skeptical of: heavy meta-tooling for prompts

The prompt library is a directory of markdown files and a tiny FastAPI service that lists them. There is no template engine, no version control beyond git, no A/B testing harness. Prompts are short enough and stable enough that a `prompts/` directory works. If I were building prompts for a team with many concurrent experiments, I would reach for something heavier.

## When this list expires

A piece of advice is only as good as its context. Re-read this list any time:

- The audience changes from "you and me" to "many users you do not control"
- The host count goes above one
- A workload that you thought you would never have becomes load-bearing
- A tool you skipped because it was "too heavy" now solves a problem you actually have

At that point, the right answer is to revisit each entry. Some will stay no. Some will move to yes with a guide. Either is fine; the cost was in deciding deliberately, not in saying no.

## Templates

This piece is about constraints, not artifacts. The technical guides that operationalize each constraint:

- [`../infrastructure/openclaw-host-topology.md`](../infrastructure/openclaw-host-topology.md) - what the single-host topology actually looks like
- [`../automation/cron-patterns.md`](../automation/cron-patterns.md) - the three-layer scheduling story chosen over Airflow / Temporal / k8s CronJobs
- [`../security/secret-management.md`](../security/secret-management.md) - the secret model that supports the "no production secrets in prompts" rule

## Related

- [`why-one-host.md`](why-one-host.md) - the affirmative case for the topology constraint
- [`why-dogfood-everything.md`](why-dogfood-everything.md) - the rule that prevents new fashion from entering this list quietly
- [`manifesto-vs-framework.md`](manifesto-vs-framework.md) - why this stack is shipped as a cookbook, not as a tool
