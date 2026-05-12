# Publish-Time Scrubbing

> Scrub at the moment artifacts leave the private workspace, not after they are already public.

**Tested on:** deterministic scrubber templates, content-guard public repo policy, git pre-push boundary checks
**Last updated:** 2026-05-11

## What this is

Publish-time scrubbing is the outbound boundary for a private agent stack. It catches private hostnames, local endpoints, filesystem paths, operator identifiers, tokens, and account details before notes, guides, drafts, exports, or commits leave the host.

The rule is simple: private workspaces can contain private facts, public artifacts cannot. Scrub and scan the artifact at the boundary where it moves from private to public.

## Why this way

Trying to scrub every private chat message makes the agent worse. Sometimes the operator needs the exact service name, path, port, or hostname inside a private session. Scrubbing there destroys useful context and creates false confidence.

Waiting until after publish is worse. Once a repo, post, release note, screenshot, or exported bundle is public, cleanup becomes incident response.

The reliable middle ground is a publish boundary:

- private workspace stays useful
- staged artifact gets deterministic replacements
- scanner blocks known leak classes
- human reviews the scrubbed diff
- release proceeds only after the artifact is public-safe

This is a workflow, not a prompt. The model may help write, but deterministic tools decide what crosses the boundary.

## Prerequisites

- A deterministic scrubber such as [`../templates/scrubbers/scrub-content.sh`](../templates/scrubbers/scrub-content.sh)
- A scanner such as [content-guard](https://github.com/solomonneas/content-guard)
- A staging directory, git branch, draft folder, or export bundle that represents the outbound artifact
- A replacement policy for each leak class
- Someone willing to review the scrubbed diff before publishing

## Before / After

Before:

- Private notes are copied into public docs by hand.
- Screenshots and exports may include paths, account labels, or internal endpoints.
- Scrubbing happens as a vague "look it over" step.
- Git hooks catch some issues, but only when the artifact is already in a repo.
- A model rewrite can remove too much or miss exact identifiers.

After:

- Every public artifact passes through a staging boundary.
- Regex replacements are previewed before being applied.
- content-guard blocks hard leaks and reports warnings.
- Human review checks meaning, tone, and false positives.
- The final artifact is safe enough to commit, publish, attach, or send.

## Implementation

### 1. Define the artifact boundary

Pick one folder or branch where content becomes publishable. The boundary should be boring and visible:

```text
drafts/private/        source notes, transcripts, raw agent output
staging/public/        scrubbed artifact, ready for review
published/             final copies, release bundle, or committed files
```

For a git repo, the boundary can be the working tree plus pre-push hook. For blog posts, newsletters, screenshots, or exported PDFs, use a staging folder before upload.

The point is to avoid asking "did we scrub this?" after the fact. If it leaves through `staging/public/`, it gets scrubbed.

### 2. Choose leak classes

Start with leak classes that have mechanical patterns:

| Leak class | Examples to catch | Replacement |
|------------|-------------------|-------------|
| private infrastructure | hostnames, private service names, local endpoints | `[redacted-service]` |
| network details | private IPs, loopback URLs, internal ports | `[redacted-endpoint]` |
| operator identity | emails, handles, account names, phone numbers | `[redacted-identity]` |
| filesystem paths | home paths, repo paths, auth paths, profile paths | `[redacted-path]` |
| channels and chat targets | channel IDs, webhook names, routing labels | `[redacted-channel]` |
| secrets | tokens, keys, cookies, auth headers | `[redacted-secret]` |

Do not make one giant replacement. Stable placeholders preserve meaning while hiding the private detail.

### 3. Keep rules deterministic

Use explicit rules, not a model rewrite pass, for first-line scrubbing. The template rule file is tab-separated:

```tsv
# pattern	replacement
user@[A-Za-z0-9._-]+	[redacted-target]
channel:[A-Za-z0-9_-]+	[redacted-channel]
/home/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+	[redacted-path]
```

Project-specific rules should live outside public templates when they contain private terms:

```bash
export SCRUB_RULES="$HOME/.config/publication-scrub/rules.tsv"
```

Keep the public template generic. Keep private names in local config.

### 4. Preview before applying

Run the scrubber in preview mode first:

```bash
templates/scrubbers/scrub-content.sh staging/public/
```

Review the diff. If it is correct, apply it:

```bash
templates/scrubbers/scrub-content.sh --apply staging/public/
```

Then review the git diff or file diff again. A scrubber that destroys meaning is a different kind of bug.

### 5. Run the scanner after the scrubber

The scrubber normalizes known patterns. The scanner catches the rest.

```bash
PYTHONPATH="$CONTENT_GUARD_DIR/src" \
  python3 -m content_guard scan "$PWD" \
  --policy "$CONTENT_GUARD_DIR/policies/public-repo.json"
```

Use three scanner result classes:

| Result | Action |
|--------|--------|
| blocker | fix before publish |
| warning | review, then fix or allow with a narrow comment |
| clean | proceed to human review |

Allow comments should be rare and local to the line. Prefer rewriting examples with placeholders.

### 6. Add a git pre-push gate

For public repos, run the scanner again at push time:

```bash
git config core.hooksPath hooks
```

The pre-push hook is not a substitute for staging-time scrubbing. It is the final guardrail for mistakes that slipped through.

### 7. Scrub screenshots and generated media

Text scanners do not protect screenshots, PDFs, image exports, browser captures, or terminal recordings.

Use a manual media checklist before publishing:

- browser address bar hidden or generic
- account switchers and profile avatars hidden
- terminal prompt does not reveal host or user
- visible paths are generic
- chat channel names and IDs are hidden
- QR codes, invite links, and tokens are absent
- image alt text does not reintroduce the private detail

If an image needs real UI structure, redraw the sensitive parts or use a generated public-safe mock. Blurring can be recoverable or visually sloppy; replacement is better.

### 8. Keep a publish log

For repeated release flows, write a short log entry:

```text
artifact: cookbook guide
source: drafts/private/browser-stack-notes.md
staged: staging/public/browser-stack.md
scrubber: passed
scanner: passed, warnings reviewed
media: not applicable
published: public repo commit
```

The log is not for bureaucracy. It makes leaks easier to investigate because you can see which boundary ran and when.

## Verification

Run the scrubber fixture:

```bash
templates/scrubbers/scrub-content.sh templates/scrubbers/fixtures/input.txt
```

Expected result: the command previews replacements and leaves the fixture unchanged.

Validate the rule file has tab-separated pairs:

```bash
awk -F '\t' 'NF && $1 !~ /^#/ && NF != 2 { print "bad rule:", NR; bad=1 } END { exit bad }' \
  templates/scrubbers/rules.example.tsv
```

Run content-guard against the repo:

```bash
PYTHONPATH="$CONTENT_GUARD_DIR/src" \
  python3 -m content_guard scan "$PWD" \
  --policy "$CONTENT_GUARD_DIR/policies/public-repo.json"
```

Check the git hook is active:

```bash
git config --get core.hooksPath
test -x hooks/pre-push
```

For a staged artifact, the minimum publish gate is:

```bash
templates/scrubbers/scrub-content.sh staging/public/
PYTHONPATH="$CONTENT_GUARD_DIR/src" python3 -m content_guard scan staging/public/ --policy "$CONTENT_GUARD_DIR/policies/public-repo.json"
```

Expected result: no blockers, warnings reviewed, and no unreviewed private identifiers in the final diff.

## Gotchas

1. **Scrub at the artifact boundary, not every chat reply.** Private operator messages often need exact local details. Scrubbing them makes the agent less useful and still does not prove the exported artifact is safe.

2. **Generated screenshots are artifacts too.** A perfect markdown scrub does nothing for an image that shows a terminal prompt, account dropdown, or real channel name.

3. **Model rewrites are not scrubbers.** A model can help make prose public-safe, but deterministic rules and scanners should decide whether known leak patterns remain.

4. **Warnings need ownership.** A scanner warning that everyone ignores is just decorative noise. Either rewrite the line, add a narrow allow comment, or tune the policy.

5. **Do not commit private scrub rules.** Public templates should show generic patterns. Real hostnames, account names, and service labels belong in local config.

6. **Redaction can break examples.** Replace with meaningful placeholders, not blank strings. The public reader still needs to understand what kind of value goes there.

7. **Pre-push is late.** It protects the remote, not the blog editor, chat upload, newsletter draft, or release bundle. Run scrubbers before the artifact reaches any downstream system.

## Templates

- [`../templates/scrubbers/scrub-content.sh`](../templates/scrubbers/scrub-content.sh) - deterministic scrubber with preview and apply modes
- [`../templates/scrubbers/rules.example.tsv`](../templates/scrubbers/rules.example.tsv) - public-safe example rule file
- [`../templates/scrubbers/fixtures/`](../templates/scrubbers/fixtures/) - fixture shape for testing replacement behavior
- [`../templates/hooks/pre-push`](../templates/hooks/pre-push) - final git boundary guard

## Related

- [`../automation/hooks.md`](../automation/hooks.md) - where publish-boundary hooks fit in the three-layer hook model
- [`../security/agent-security-hardening.md`](../security/agent-security-hardening.md) - defense in depth for agents with real system access
- [`../ai-stack/browser-llm-stack.md`](../ai-stack/browser-llm-stack.md) - browser artifacts and screenshot review
- [`../ai-stack/skills-development.md`](../ai-stack/skills-development.md) - sanitizing private skills into public reusable patterns
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) - repo-level hostname scrub rule
