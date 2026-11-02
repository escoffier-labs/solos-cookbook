# Octopool: Pooled GitHub Reads Through a Cloudflare Worker

> Every agent on every machine asks GitHub the same questions all day: what's the PR state, did the checks pass, what's the latest release. Octopool answers repeat questions from a shared cache on a Cloudflare Worker and only spends a GitHub token when it has to. This is how my fleet uses it, what it saves, and where it refuses on purpose.

**Tested on:** Octopool CLI (Go, static binary) against a self-hosted pilot of [`openclaw/octopool`](https://github.com/openclaw/octopool) on Cloudflare Workers, one pool (`maintainers`) with one pooled identity, four enrolled clients (control host, second Linux workstation, Windows desktop, CI runner container), GitHub CLI as the write path
**Last updated:** 2026-11-02

---

## What this is

[Octopool](https://docs.octopool.dev/) is a GitHub read relay and shared cache. One Cloudflare Worker sits between my agents and the GitHub API. A caller sends a read (`gh pr view`, `gh pr checks`, `gh run list`, `gh api repos/...`). The Worker serves it from its edge and D1 cache if a fresh copy exists. On a miss it prefers token-free GitHub endpoints, and only then picks a pooled identity (a PAT or a GitHub App installation) to make the call. Tokens stay in the Worker's secret store. Callers hold a short Octopool token and never a GitHub token.

I run it because my agents are read-heavy and repetitive. A Brigade orchestrator polling PR checks, a T3 thread watching CI, and a review bot reading the same PR all spend the same rate budget on the same answer.

## Why this way

| Option | What it costs | Why I did not stop there |
|--------|---------------|--------------------------|
| Every agent uses my personal `gh` token | Nothing to set up | One rate budget shared by every harness on every machine, and every agent holds a token that can also write |
| A separate PAT per machine | A token per host to rotate | Budgets stop colliding, but nothing is shared: four machines asking about the same PR make four calls |
| A local caching proxy | One more daemon per host | Caches per machine only, and still needs a token on each host |
| **Octopool on a Cloudflare Worker** | A Cloudflare account, one Worker, one D1 database | One cache for the whole fleet, tokens never leave the Worker, and the CLI refuses instead of falling back when I tell it to |

Cloudflare is a good fit here because the pieces Octopool needs are platform primitives. The Worker handles the requests. D1 holds the read-through cache, callers, identities, and policy. Durable Objects coordinate the parts that need one writer: identity selection per pool (`PoolCoordinator`), policy snapshots (`PolicyCoordinator`), and backend admission (`BackendAdmission`). Per the upstream operations docs, Durable Objects plus D1 need the Workers Paid plan.

## Prerequisites

- A Cloudflare account you control, on the Workers Paid plan (the upstream docs list it as required for Durable Objects and D1)
- A GitHub org whose membership gates who may call the relay
- At least one GitHub identity to pool: a fine-grained PAT, or a GitHub App installed on the repositories you read
- The `octopool` CLI on each client machine, plus the real GitHub CLI (`gh`) for writes and for anything Octopool refuses
- Comfort with `wrangler` if you deploy your own Worker instead of joining someone else's

## Before / After

**Before:** each agent harness called GitHub with whatever `gh` token the host had. Polling loops on CI and PR state were the biggest consumers. Two machines watching the same PR made two calls. Every agent process could read a token that could also push.

**After:** agents make reads with `octopool gh ...`. Repeat reads within the cache window come back from the Worker in about a quarter second without touching GitHub. Private repositories and writes never go through the relay. Each machine is a named client in the pool's stats, so I can see which host is spending what.

## Implementation

### How a read flows

```
agent on any host
   │  octopool gh pr list -R owner/repo ...
   ▼
octopool CLI ── caller token (~/.config/octopool/auth.json, mode 0600)
   │  POST /v1/github/request
   ▼
Cloudflare Worker
   ├─ caller auth + org membership check (re-verified when stale, default 24h)
   ├─ public-repo guard ── private or unknown? → 424 fallback_local (repo_not_public)
   ├─ edge cache / D1 cache ── fresh hit? → answer, GitHub never called
   ├─ token-free GitHub endpoint for this shape? → use it
   └─ PoolCoordinator (Durable Object, one per pool)
         picks an identity: sticky 10s lease, else highest remaining
         rate budget, skipping identities in cooldown
         → GitHub API with that identity → cache the answer → reply
```

Two details matter for agents:

- **Concurrent identical misses coalesce.** If three agents miss on the same read at once, one fetch fills the cache and the others wait for it. The coordinator also keeps a short lease so a burst of callers sticks to one identity instead of spreading across all of them.
- **Freshness is bounded and explicit.** Most cached shapes have a 60-second TTL, and the CLI asks for `max-age=60` by default. When a decision cannot tolerate a minute-old answer, `OCTOPOOL_FRESH=1` asks for a live read.

### Deploying the Worker

I followed the upstream [deployment guide](https://docs.octopool.dev/operations.html). The shape:

```bash
git clone https://github.com/openclaw/octopool.git
cd octopool
pnpm install
# edit wrangler.jsonc: account_id, routes (or a workers.dev route), org settings

# D1 location is fixed at creation; pick the region nearest your callers
wrangler d1 create octopool --location <region>
# copy database_id into wrangler.jsonc, then:
wrangler d1 migrations apply DB --remote

# every credential goes into the Worker's secret store, never into wrangler.jsonc or D1
wrangler secret put <SECRET_NAME>

wrangler deploy
```

The three Durable Object classes are created by migration tags on deploy. Keep the pool coordinator's location hint in the same region as D1, or every coordinator call crosses regions.

My pilot runs on a `workers.dev` route in my own account, with one pool and one pooled identity.

### Enrolling a machine

```bash
octopool login https://octopool.example.workers.dev --client <machine-name>
```

`login` reads a local GitHub.com token (`GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`), sends it once to the Worker's login exchange, and stores the returned caller token at `~/.config/octopool/auth.json` with mode 0600. The Worker checks that the GitHub user is a member of the allowed org before minting anything. The GitHub token itself is not stored by Octopool.

### The agent policy I run

Upstream ships an `octopool install-shim` command that puts a transparent `gh` wrapper first on `PATH`. I do not install it. Agents call Octopool explicitly, and every enrolled host exports one variable:

```bash
# ~/.config/octopool/env.sh, sourced by agent shells
export OCTOPOOL_NO_FALLBACK=1
```

The rules every harness follows:

1. Check `command -v octopool` and `octopool whoami` first. If either fails, say so and use the normal `gh` path.
2. Use `octopool gh ...` for public, read-only shapes: PR, issue, repo, release, workflow, run and check status, and `gh api` GETs.
3. Never send writes through Octopool: pushes, PR creation or merge, comments, labels, workflow dispatch, settings, releases. Those use the host's normal write-capable `gh`.
4. With `OCTOPOOL_NO_FALLBACK=1`, a refused route is an error the agent reports, not a silent switch to a personal token. The agent then decides, visibly, to use `gh`.

Without that variable, the CLI hands refused reads to your real `gh` with your own credentials, which is convenient for a human and invisible for an agent.

## Verification

Who am I, and is the pool healthy:

```bash
octopool whoami
# server: https://octopool.example.workers.dev
# pool: maintainers
# login: <github-login>
# client: <machine-name>

octopool health
# { "identities_healthy": 1, "identities_total": 1, "policy_version": 1, "pool": "maintainers" }
```

A miss, then a hit, on the same read (measured 2026-11-02 from the control host):

```bash
export OCTOPOOL_NO_FALLBACK=1
time octopool gh pr list -R escoffier-labs/brigade --limit 3 --json number -q length
# 3
# real 0m2.984s        <- miss: Worker fetched from GitHub

time octopool gh pr list -R escoffier-labs/brigade --limit 3 --json number -q length
# octopool: pr_list served from shared cache (hit); set OCTOPOOL_FRESH=1 for a live read
# 3
# real 0m0.266s        <- hit: GitHub not called
```

The public-repo guard refuses a private repository instead of serving it:

```bash
octopool gh api repos/<owner>/<private-repo> --jq .visibility
# Error: octopool requested local gh fallback: repo_not_public
```

Per-route stats for this client and the pool:

```bash
octopool stats --since 24h
# requests: 26 (0 service errors, 13 local fallbacks)
# cache: 0.0% hit (0 hits, 0 stale, 26 misses, 0 bypass, 0 unknown)
# top routes:
#   release_list: 7 req, ... 6 fallback
#   release_latest: 5 req, ...
# fallback reasons:
#   web_only_unavailable / release_list: 6 req
#   repo_not_public / issue_comments: 2 req
#   no_identity / contents: 1 req
```

## Gotchas

1. **The hit rate depends on how many callers share questions.** On a quiet day the control host alone showed 26 requests and a 0% hit rate, because each read was different. The day after the first host enrolled, with more agents polling the same PRs, it was 53 requests at 26.9% overall and 60.9% on `pr_list`. `issue_view` stayed at 0%: every issue is a distinct key. Octopool pays off for polling loops and shared repos. One agent browsing sees little benefit.

2. **Two hosts with the same GitHub token become one caller.** The relay keys a caller session by the token exchanged at login. When two machines' `gh auth token` returned the identical PAT, one machine's stats merged into the other's for about ten minutes. Give each machine its own GitHub login token before enrolling it.

3. **Windows over SSH has no usable `gh` token.** On the Windows desktop the `gh` token lives in Windows Credential Manager, which an SSH session cannot read. Over SSH, `octopool gh api <REST path>` and the plain table forms of `pr list` work, because the relay serves them without local `gh`. The `--json` list forms need the local `gh` and fail with 401.

4. **Changes take up to 30 seconds to land.** Caller auth, membership, pool policy, and identity lists sit in a 30-second isolate cache on the Worker. A revoked caller token or a policy edit can still work for half a minute. My fleet check script waits 35 seconds before asserting anything about new clients.

5. **`NO_FALLBACK` turns some ordinary reads into errors.** Release listings returned `web_only_unavailable` and some content and compare routes returned `no_identity` on my pool. The relay is reporting what it can serve. Use `gh` for that call on purpose and keep the flag.

6. **Private repos are always local.** The shared relay is public-repository-only by design, and the guard runs before the cache, so private data never lands in a shared cache entry. Plan for every private-repo read to go through your own `gh`.

7. **A stale answer is a real possibility for up to a minute.** CI that just finished or a PR that just merged can read as running or open within the TTL. For a merge decision or a "did checks pass on this exact head" gate, set `OCTOPOOL_FRESH=1`.

8. **GitHub App keys must be PKCS#8.** Per the upstream identity docs, the Worker imports App keys through WebCrypto, which only imports PKCS#8 PEM. The older PKCS#1 format that GitHub's download page can hand you (its header names RSA) fails with `503 github_app_key_format`. Convert the key to PKCS#8 before storing it as a secret.

## Templates

- Agent shell snippet: the `env.sh` block in [The agent policy I run](#the-agent-policy-i-run)
- Fleet check pattern: run `octopool whoami` on each host, wait out the 30-second cache, then confirm every client name appears in `octopool stats --since 1h`

## Related

- [`brigade.md`](brigade.md) - the orchestrator whose PR and CI polling generates most of these reads
- [`t3-code.md`](t3-code.md) - the T3 threads that watch PRs and checks
- [`../ai-stack/multiple-subscriptions.md`](../ai-stack/multiple-subscriptions.md) - the same "share the budget, don't multiply it" idea for model subscriptions
- [`../security/secret-management.md`](../security/secret-management.md) - where the write-capable GitHub token for each host comes from
- Upstream: [docs.octopool.dev](https://docs.octopool.dev/) and [`openclaw/octopool`](https://github.com/openclaw/octopool)
