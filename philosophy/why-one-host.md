# Why One Host

> One bare-metal box. Not a cluster, not a VPS fleet, not a Pi farm. The trade you are making is "operational simplicity now" against "availability you would not actually use." I will take that trade every time for a single-engineer setup.

## What this is

A position piece on why the agent stack in this cookbook runs on exactly one machine, and why I think most solo or small-team engineers should do the same, at least until they have evidence they need otherwise.

This is opinion. The technical guides in the rest of the cookbook are recipes; this one is the argument behind the recipe.

## The default we are arguing against

The default story in 2026, especially for engineers who came up through the cloud-native era, is some version of:

- A control plane on host A
- Workers on hosts B and C
- A database on host D, with read replicas on E and F
- A reverse proxy on host G
- A message queue on host H
- "Highly available," "horizontally scalable," "production-grade"

For a single engineer running an AI agent stack at home, every word in that story is a tax. The tax is paid in:

- More machines to keep current
- More inter-host networking to understand and harden
- More failure modes that involve two hosts disagreeing
- More observability surface to build before you can debug
- More moving parts that can fail when you are asleep

The tax buys you availability you almost certainly never use. The only way to get real value from a distributed setup is to actually need it: real concurrent users, real geographic distribution, real regulatory uptime requirements. A solo engineer with an always-on AI agent has none of those.

## The case for one host

### 1. Operational surface is the actual cost

The cost of running a stack is not CPU cycles. It is the amount of system-level state you have to keep in your head: which service runs where, which file is the source of truth, which path is mounted from where, what is the failure mode when X talks to Y.

A single host collapses all of that into "one machine, this directory, this systemd-user view." You can sit at the keyboard and answer any question about the stack in five seconds. Two hosts double the lookup time; ten hosts make it impossible without tooling that has its own operational cost.

### 2. Latency is unavoidable; you do not want to add to it

The agent's main wait is the LLM. That is a 200 ms - 30 s round trip you cannot reduce. Everything else - file reads, sqlite queries, tool dispatch - is microseconds on a local machine and milliseconds across a network. Splitting the agent and its tools across hosts adds latency to the only thing that was already fast.

### 3. One host fits in your head; a cluster does not

You will hit a bug at midnight. The bug will be in the seam between two components. If both components live in `~/.openclaw` on the same machine, the seam is one `journalctl --user -u <service>` away. If they live on different hosts, the seam now includes the network, name resolution, mTLS, time sync, two firewalls, and the fact that you forgot which user the systemd unit runs as on the other box.

"It's just SSH" is what people say before they spend Saturday morning debugging why an SSH key got rotated three months ago.

### 4. Backups are cheaper for one host

A single host with a clear backup strategy ([`infrastructure/backup-recovery.md`](../infrastructure/backup-recovery.md)) is recoverable in hours. A cluster requires backup-and-restore tested across every component. Most solo engineers do not actually test cluster restores. One-host restores get tested every time you reinstall the host or roll forward an LVM volume.

### 5. Hardware is cheap; engineers are not

A single modern desktop with 64 GB of RAM, two NVMe drives, and a 16-thread CPU costs less than a year of a comparable cloud VM fleet, and runs faster for the workloads in this cookbook. The capex story tilts further every year as desktop CPUs catch up to server SKUs.

The argument "but cloud lets you scale!" assumes you will scale. You will not. The agent serves you and a few people at most. The number of cores you actually use peaks at single digits.

## The case against one host (and where it fails)

### "But what if the host dies?"

Then you reinstall. The data is on the LV ([`hardware/disk-layout-lvm.md`](../hardware/disk-layout-lvm.md)), the off-host backups are restic snapshots on a NAS and on cloud, and the OS-level config lives in version control. The recovery time is hours, not days. For a system that supports one engineer, that is acceptable.

If you do not have backups, the answer is to fix that, not to add a second host. A two-host setup without backups is two hosts that lose data, not one host that survives a fire.

### "But what if the agent is busy when I want to work?"

The agent is responsive to interactive use even when ten background tasks are running. The CPU is not the bottleneck. If you can show the agent is actually CPU-starved on real workloads (not synthetic benchmarks), revisit the spec, not the topology.

### "But I want to learn distributed systems"

Fair, but do that on a project that is supposed to teach you distributed systems. Do not pay the distributed-systems tax on a stack whose job is to be reliably useful to you.

### Real cases where one host stops working

A small list. If you are in one of these, you do need more than one host:

1. **Real users.** Plural, paying, with SLAs. Then you are not the solo engineer this cookbook is for.
2. **A workload that genuinely does not fit.** Local LLMs at 70 B parameters do not fit on the host this cookbook targets. If you want to run those, dedicate a separate machine to that workload and treat it as a service the agent calls.
3. **A workload that needs a different environment.** Windows-only services (some media servers, some security tools) live on a Windows box. The agent talks to them over SSH. That is not a "cluster"; that is one host with peripherals.
4. **A workload that should fail independently.** A consumer-facing service whose downtime should not coincide with the agent's downtime can live on a separate VPS. That is a single-tenancy decision, not a horizontal-scaling decision.

The agent's homelab includes some of (3) and (4) - a Proxmox node hosting a few LXCs for services that benefit from isolation, a Windows desktop hosting media-server processes - but the agent itself, its memory, its cron, its plugins, all live on one host.

## What "one host" actually buys you

A few things that do not look like benefits until you have them:

- **You can describe the entire stack on a piece of paper.** People who understand the stack can give you useful advice.
- **A reboot tests the whole thing in three minutes.** "Does it come back up?" is a `reboot` followed by a single command.
- **Onboarding a new agent or skill takes minutes, not hours.** No new firewall rules, no new mTLS, no new service mesh entry.
- **Profiling actually works.** `htop`, `iostat`, `journalctl` all see the whole system. There is no "but on the other host" to chase.
- **The system fits in cron output.** A daily health-check report is a few hundred lines of text, not a Grafana board you have to sign in to.

## The honest counter

A few things you give up:

- **No failover.** If the host dies, the agent is down until you fix or replace the host. If your job depends on the agent being up, this matters.
- **No isolated blast radius.** A bad cron job can wedge the host. Sandbox shims ([`automation/sandbox-shims.md`](../automation/sandbox-shims.md)) help, but a CPU-pegging agent process can starve everything else until you `kill` it.
- **No "scale to zero" cost story.** The host runs 24/7 whether you are using it or not. The electricity bill is real. The cloud-native counter-argument is that you only pay for what you use; with one always-on host, you pay the idle cost.

For my use case, those are acceptable. Your tolerance is yours.

## Templates

There is no template for this; the whole cookbook is the implementation. Starting points:

- [`../hardware/bare-metal-setup.md`](../hardware/bare-metal-setup.md) - what to buy and how to install it
- [`../infrastructure/backup-recovery.md`](../infrastructure/backup-recovery.md) - the off-host backup story that makes "one host" recoverable

## Related

- [`why-dogfood-everything.md`](why-dogfood-everything.md) - the related stance on running what you build, in production, against yourself
- [`what-this-stack-is-not.md`](what-this-stack-is-not.md) - the explicit list of things one-host means we are not doing
- [`../hardware/bare-metal-setup.md`](../hardware/bare-metal-setup.md) - the spec that "one host" actually points at
