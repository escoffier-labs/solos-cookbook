# PR Comment Boundary

> Treat PR comments as public artifacts. Scrub them before they leave the local workspace.

**Tested on:** GitHub PR review comments, outbound markdown drafts, Brigade guard public-repo policy
**Last updated:** 2026-07-06

## What this is

PR comment boundary is the outbound check for review comments, issue replies, and PR bodies written from an agent workspace. It catches private hostnames, local paths, internal endpoints, account labels, raw command output, and stack traces before they land in GitHub.

This guide is narrower than full publish-time scrubbing. It is for the comment you are about to post, not the whole repo.

## Why this way

PR comments feel casual, but they are durable. GitHub can email them, index them, quote them in notification systems, and preserve them after an edit. A leaked hostname or local path in a review comment is still a public leak.

Agents make this easier to miss because they often include the exact terminal output that helped them debug the issue. That output is useful locally, but it can carry more context than the reviewer needs.

The boundary should be simple:

- draft the comment in a file
- scan the file before posting
- replace private details with precise generic labels
- paste or post only the scrubbed version

## Prerequisites

- A draft file for the outbound comment, for example `/tmp/pr-comment.md`
- A mechanical leak sweep such as `rg`
- Brigade's embedded guard or another policy scanner with a public-repo ruleset
- A habit of posting comments from `--body-file` after review, not from an unscanned terminal buffer

## Before / After

Before:

- The agent posts raw failing output from a local shell.
- Review comments include absolute home paths and private service labels.
- A reproduction note names a private host, local port, or account alias.
- Reviewers get more local context than they need to act.

After:

- The comment draft exists as a file before it is posted.
- Mechanical scans catch private network ranges, local paths, and auth-shaped strings.
- Raw logs are summarized, with only the necessary public lines kept.
- Private infrastructure is replaced with stable labels such as `[private-host]`, `[local-path]`, and `[internal-endpoint]`.
- The final comment explains the finding, evidence, and requested action without leaking the operator's machine.

## Implementation

### 1. Draft comments into files

Do not post directly from a generated chat reply or a terminal scrollback. Write the comment body to a file first:

```bash
comment_file=/tmp/pr-comment.md
$EDITOR "$comment_file"
```

For GitHub, post from the reviewed file:

```bash
gh pr comment 123 --body-file "$comment_file"
```

For review comments, use the same rule even if the final post happens through a browser. The file is the boundary.

### 2. Keep the comment scoped

Every outbound PR comment should answer three public-safe questions:

1. What is wrong or what changed?
2. What evidence can the reviewer verify?
3. What action is needed?

Anything else is suspect. Local hostnames, absolute paths, private repo layouts, account names, dashboard links, and full raw logs usually answer a fourth question: where did the agent happen to be running? Do not include that.

### 3. Replace leak classes with stable labels

Use labels that preserve meaning without exposing the original value:

| Leak class | Replace with | Keep if public |
|------------|--------------|----------------|
| private hostnames | `[private-host]` | public domain owned by the project |
| private IPs or LAN URLs | `[internal-endpoint]` | documentation-range examples only |
| absolute home paths | `[local-path]` or a repo-relative path | paths inside the reviewed repo |
| user or account labels | `[account]` | public maintainer handle |
| raw environment output | `[redacted-env]` | variable names without values |
| stack traces with local paths | trimmed stack trace | repo-relative frames |
| terminal prompts | omitted | the command and public output only |

Prefer the narrowest label. `[local-path]` tells the reviewer more than `[redacted]`.

### 4. Scan the draft before posting

Run a mechanical sweep first:

```bash
rg -n '(\b10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)|/home/[A-Za-z0-9._-]+|/Users/[A-Za-z0-9._-]+|localhost:[0-9]+|[A-Za-z0-9._-]+\.local\b' "$comment_file"
```

Expected result: no matches.

Then run the policy scanner if it is installed:

```bash
brigade scrub --target "$comment_file" --policy public-repo --no-receipt
```

Expected result: no blockers, warnings reviewed.

The regex is a floor. Read the comment by eye for project-specific hostnames, dashboard names, account labels, and pasted logs.

### 5. Summarize logs instead of pasting them

Raw logs are where comment leaks hide. Replace large blocks with a short public trace:

```text
Verification failed in the link checker.

Command:
npm --prefix site run check:links

Public failure:
site/src/pages/index.astro links to a missing guide.

Requested action:
Update the link target or restore the guide before merge.
```

If a reviewer needs the full log, attach a scrubbed artifact or quote only the public lines.

### 6. Preflight batch review comments

For batches of review output, add a local preflight before posting:

```bash
review_dir=/tmp/review-comments
mkdir -p "$review_dir"

# Write each outbound body to one file, then scan the batch.
rg -n '(\b10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)|/home/[A-Za-z0-9._-]+|/Users/[A-Za-z0-9._-]+|localhost:[0-9]+|[A-Za-z0-9._-]+\.local\b' "$review_dir"
```

Expected result: no matches.

Post only the files that pass review. If one file needs redaction, fix it and scan the whole batch again.

## Verification

Create a safe fixture:

```bash
cat >/tmp/pr-comment.md <<'EOF'
Verification failed in the link checker.

Command:
npm --prefix site run check:links

Public failure:
README.md points to a missing publishing guide.
EOF
```

Run the mechanical scan:

```bash
rg -n '(\b10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)|/home/[A-Za-z0-9._-]+|/Users/[A-Za-z0-9._-]+|localhost:[0-9]+|[A-Za-z0-9._-]+\.local\b' /tmp/pr-comment.md
```

Expected result: exit 1 from `rg`, meaning no matches.

Preview the exact post command without sending it:

```bash
printf 'gh pr comment <number> --body-file %q\n' /tmp/pr-comment.md
```

Scan the file with Brigade guard:

```bash
brigade scrub --target /tmp/pr-comment.md --policy public-repo --no-receipt
```

Expected result: no blockers, warnings reviewed.

## Gotchas

1. **GitHub email makes leaks harder to retract.** Editing or deleting the comment later does not pull it back from inboxes and mirrors.

2. **Inline review comments still leak paths.** A comment on a public file can include a private local path in its body. The file context does not make the comment safe.

3. **Code fences are not safe zones.** Scanners and humans still need to inspect fenced logs, shell output, stack traces, and JSON snippets.

4. **Allow comments are for files, not PR bodies.** A reviewed allow tag in source does not justify posting a private value in a GitHub comment.

5. **Browser posting skips shell hooks.** If the final comment is pasted through the GitHub UI, the draft file scan is the guardrail.

6. **Batched comments need batch review.** A set of line comments can pass one by one and still leak through the one file nobody opened.

7. **Repo-relative paths are usually enough.** Reviewers need `site/src/pages/index.astro`, not a full path from the author's machine.

## Templates

- [`../templates/scrubbers/scrub-content.sh`](../templates/scrubbers/scrub-content.sh) - deterministic scrubber with preview and apply modes
- [`../templates/scrubbers/rules.example.tsv`](../templates/scrubbers/rules.example.tsv) - public-safe example rule file
- [`../templates/hooks/pre-push`](../templates/hooks/pre-push) - final git boundary guard for repository content

## Related

- [`publish-time-scrubbing.md`](publish-time-scrubbing.md) - wider artifact boundary for repos, exports, screenshots, and bundles
- [`../automation/hooks.md`](../automation/hooks.md) - where boundary hooks fit beside tool-call and lifecycle hooks
- [`../security/secret-management.md`](../security/secret-management.md) - keeping secrets out of env files, prompts, and exports
- [`../security/incident-runbook.md`](../security/incident-runbook.md) - what to do after a public leak
