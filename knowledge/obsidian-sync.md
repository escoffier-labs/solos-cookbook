# Obsidian Sync Without Conflict Roulette

> One vault, one sync layer, one place for automation to write. That is how you get bidirectional cloud sync without waking up to three "conflicted copy" files and a broken notes index.

## What this is

Obsidian sync gets messy fast when desktop, phone, and automation all act like they own the vault. You end up with duplicate notes, attachments that exist on one device only, and indexes that drift because two writers touched the same file seconds apart.

This guide is the pattern that has held up best for me: one canonical vault, one sync mechanism, inbox-first capture on mobile, and strict rules about which files automation is allowed to touch. The vault itself follows a PARA-style Zettelkasten note system: projects, areas, resources, and archive as the folder spine, with small atomic notes instead of giant omnibus files. It is cloud-backed and bidirectional, but it is not a free-for-all.

## Why this way

There are three common approaches:

| Approach | Feels easy | Actually breaks because |
|----------|------------|-------------------------|
| **Two independent vault copies** | No setup beyond pointing each device at a folder | They drift immediately. Plugins, attachment paths, and note IDs stop matching. |
| **Multiple sync tools stacked together** | "Extra safety" | It is not safety. It is conflict multiplication. One tool uploads while the other rewrites metadata. |
| **One canonical vault + one sync layer + writer rules** | Slightly stricter up front | This is the one that stays boring, which is the whole point. |

The hard truth: sync failures are usually not a cloud-provider problem. They are a writer-discipline problem. If phone capture, desktop editing, and automation all touch the same long-lived files, conflict copies are inevitable.

## Prerequisites

- Obsidian on every device that needs the vault
- One cloud sync layer only. Obsidian Sync, a drive-mirror folder, or a provider-backed sync plugin are all fine. Pick one.
- Comfort editing Obsidian settings and checking hidden files
- Acceptance that automation should write to a narrow part of the vault, not the whole thing

## Before / After

**Before:** notes arrive from mobile, desktop, and scripts into random folders. Some filenames collide. Daily notes get edited by more than one device at once. Attachments lag behind note text. Search results show duplicate files with slightly different timestamps.

**After:**

- Every device points at the same vault structure
- Mobile capture lands in an inbox first
- Automation writes only to approved folders
- Index or summary files have a single owner
- Conflict files are rare enough to treat as incidents, not background noise

## Implementation

### 1. Pick one canonical vault root

Every device should mount or open the same vault layout.

Example structure:

```text
Obsidian/
└── Cerebro/
    ├── 00 - Inbox/
    ├── 01 - Projects/
    ├── 02 - Areas/
    ├── 03 - Resources/
    ├── 04 - Archive/
    └── Attachments/
```

That layout is intentionally PARA-shaped. The note style inside it is Zettelkasten-flavored: short atomic notes, strong links, and as little monolithic "master note" sprawl as possible.

Do not keep a "desktop vault" and a separate "mobile vault" and try to merge them later. That is how you get duplicate note universes.

### 2. Use exactly one sync layer

Choose one of these patterns:

| Pattern | Good fit | Rule |
|--------|----------|------|
| **Obsidian Sync** | You want the least operational drama | Let Obsidian own the sync path. Do not also mirror the vault with a cloud-drive client. |
| **Cloud drive mirror** | Desktop-first setup with a local synced folder | The vault lives inside the mirrored folder. Every device uses that same mirror path. |
| **Provider-backed sync plugin** | You need a backend Obsidian can talk to directly | Let the plugin be the sync layer. Do not stack a second sync client on top. |

The rule is blunt because it needs to be: **one vault, one sync engine**.

### 3. Separate capture from curation

Mobile should be optimized for fast capture, not perfect filing.

- Phone and tablet: create notes in `00 - Inbox/`
- Desktop: process inbox notes into their long-term folders
- Automation: write only to approved target folders, usually inbox or a dedicated generated-notes area

This keeps sync boring because only one surface is doing heavy reorganization.

### 4. Give summary files a single owner

Master indexes, dashboards, and generated overview files are conflict magnets. They change often, they stay open for a long time, and they tempt every automation script to rewrite them.

Pick one owner for each class of file:

- **Daily notes:** human-owned
- **Master indexes:** desktop or automation, not both
- **Generated summaries:** automation-owned
- **Inbox triage notes:** automation may create, human may review

If a file is likely to stay open in Obsidian for hours, do not let a background script rewrite it.

### 5. Keep automation atomic

Automation should prefer creating or updating small, topic-scoped notes instead of rewriting giant "everything" files.

Good:

```text
00 - Inbox/2026-05-06-router-maintenance.md
03 - Resources/networking/bgp-community-notes.md
```

Bad:

```text
03 - Resources/master-notes.md
Home.md
Today.md
```

Atomic notes sync cleanly. Monolithic notes invite merge hell.

### 6. Normalize filenames and attachment paths

Set and enforce a few boring rules:

- One attachment folder for the whole vault or one per folder. Pick one and stick to it.
- Filename scheme should be deterministic. Date prefix + slug works well.
- Avoid note titles that differ only by case.
- Do not let automation emit placeholder names like `Untitled.md` or `NN -  - Title.md`.

Most sync conflicts start as naming slop long before they become visible as conflict copies.

### 7. Add a reconciliation pass

Once a day or once a week, do a quick audit:

- Look for conflicted copies
- Look for duplicate note names
- Check that attachments referenced in recent notes actually exist
- Verify generated notes are landing in the expected folders

This is five minutes well spent. Letting small vault drift sit for a month is how you end up losing a Saturday to note archaeology.

## Verification

On a desktop with a local mirror of the vault:

```bash
# 1. Find obvious conflict artifacts
find ~/Obsidian/Cerebro -type f \( -iname '*conflict*' -o -iname '*conflicted copy*' \)

# 2. Find duplicate basenames in different folders
find ~/Obsidian/Cerebro -type f -name '*.md' -printf '%f\n' | sort | uniq -d

# 3. Spot notes with missing attachments (basic check)
grep -Rho '!\[\[.*\]\]' ~/Obsidian/Cerebro | sed 's/^!\[\[//; s/\]\]$//' | while read -r f; do
  find ~/Obsidian/Cerebro -type f -name "$f" | grep -q . || echo "Missing attachment: $f"
done
```

Manual test loop:

1. Create a note on desktop in `00 - Inbox/`
2. Confirm it appears on mobile
3. Edit one line on mobile
4. Confirm the same file updates on desktop without a duplicate file appearing
5. Move the note on desktop to its long-term folder
6. Confirm mobile sees the move, not a second copy

If that six-step loop is clean, your sync model is probably healthy.

## Gotchas

**Stacking sync tools is the fastest path to pain.** Running Obsidian Sync plus a cloud-drive mirror plus a provider plugin sounds redundant and safe. It is neither. Each layer notices file changes at slightly different times and happily manufactures conflicts for you.

**Mobile background sync lies by omission.** Many phones delay app network activity when the app is not foregrounded. You think the note synced because the spinner stopped. It did not. Open the vault and verify recent notes actually landed before assuming capture is safe.

**Generated index files are conflict magnets.** If an automation job rewrites a dashboard note while you are staring at it on another device, the sync tool has no magical way to know which copy you "meant." Give summary files one owner and keep the other devices read-mostly.

**Attachments drift more quietly than notes.** Text sync failures are obvious. Attachment failures are sneaky. The note is there, the image link looks fine, and the actual file never arrived on the phone. Check attachment paths during reconciliation.

**Filename normalization matters more than people think.** Two notes that differ only by punctuation, whitespace, or letter case will eventually hurt you on a mixed device fleet. Decide the naming scheme once and keep it boring.

## Related

- [`memory-architecture.md`](memory-architecture.md) — what belongs in long-term notes versus short-lived workflow state
- [`session-jsonl.md`](session-jsonl.md) — using transcript logs as a search source instead of dumping raw conversations into the vault
- [`claude-code-memory-handoffs.md`](claude-code-memory-handoffs.md) — when durable machine-local knowledge should become canonical shared memory
