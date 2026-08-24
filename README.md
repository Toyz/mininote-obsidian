# mininote for Obsidian

Publish and share your Obsidian notes through [mininote](https://mininote.ink): push a note, get a public link. Your vault stays the source of truth.

This is a **publish** plugin, not a sync plugin. Notes flow one way — from your vault to mininote. mininote never writes back into your vault.

## What it does

- **Share a note** — publishes it to mininote and gives you a public link.
- **Share a folder** — mirrors every note under it and shares the folder as one public link (the whole subtree behind a single URL).
- **Keeps the copy in step (one way)** — when you edit, move, rename, or delete a shared note, the mininote copy follows. Each of these is a toggle; all off = a plain one-time publish.
- **Per-share control** — forking, raw source, downloads, annotations, password, plus page settings (reading width, unlisted). Set your own defaults once and every new share starts from them.
- **A shares sidebar** — everything this vault has published, with quick copy/open/manage/resync/stop and a hover preview of each share.

## Requirements

- Obsidian 1.5.0 or newer, desktop (the OAuth sign-in flow needs a real browser + custom-scheme redirect).
- A [mininote](https://mininote.ink) account.

## Install

The plugin isn't in the Obsidian community store yet. Two ways to install it in the meantime:

### With BRAT (recommended — auto-updates)

1. Install **BRAT** (Beta Reviewer's Auto-update Tool) from Community plugins and enable it.
2. Run **BRAT: Add a beta plugin**, enter `Toyz/mininote-obsidian`, and confirm.
3. BRAT installs mininote and keeps it up to date as new releases ship.
4. Enable **mininote** under Settings -> Community plugins.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Toyz/mininote-obsidian/releases/latest).
2. Put them in `<your vault>/.obsidian/plugins/mininote/`.
3. Reload Obsidian and enable **mininote** under Settings -> Community plugins.

## Connect

Run **Connect to mininote** (command palette, the status bar, or the settings tab). It opens your browser to sign in and authorize the plugin, then hands a scoped key back to Obsidian. You can **Disconnect** any time from the settings tab or the command palette.

The plugin only ever holds a scoped OAuth token for your account — it can read and write your pages, shares, and tags, and read your handle to brand share links. Nothing else.

## Sharing

- **A note:** right-click it (or the ribbon / command palette) -> mininote -> Share. Pick your options and Publish. You get a link you can copy or open.
- **A folder:** right-click the folder -> mininote -> Share folder. Every markdown note under it is mirrored and the folder is shared as one link. Page settings you choose apply to every note in the folder.
- **Quick share:** the **Quick share current note (use defaults)** command publishes the active note straight from your saved defaults — no dialog — and drops the link in a toast with Copy link / Open. Bind a hotkey to it for one-key publishing.

Notes are published under a **mirror folder** (default `Vault`) inside mininote, so they never collide with pages you made there directly. Re-publishing the same note updates the same page (stable link) instead of making a duplicate.

## One-way sync

Your vault is the source of truth. These keep the mininote copy current; mininote edits never flow back. All are toggles in settings:

- **Sync edits** — editing a shared note debounce-pushes the change to its live share.
- **Sync moves** — moving or renaming a shared note moves its mininote page to match (the public link is preserved).
- **Sync deletes** — deleting a shared note revokes its share and deletes the mininote page (off = revoke only, keep the page).
- **Sync tags** — pushes a note's tags (inline `#tags` + frontmatter). Additive: dropping a tag in Obsidian doesn't remove it on mininote.

## Page settings and defaults

Each share can set mininote page config the plugin manages:

- **Reading width** — Normal (focused column) or Wide (full-bleed, for tables and wide media).
- **Unlisted** — keep the page out of smart-folder / automatic exposure; direct links still work.

Set defaults for all of the above (sharing options included) under **Default share settings** in the settings tab. New shares start from your defaults; existing shares keep their own, and you can override anything per-share when you publish.

## Images and links

- **Images** — mininote never hosts your image bytes. Local images stay in your vault (they aren't published; a placeholder marks them). Remote image URLs are kept and load through mininote's external-image gate. The share dialog tells you up front what won't be published.
- **Links** — `[[wikilinks]]` (and leftover non-image embeds) are rewritten to the relative markdown links mininote resolves, so links between shared notes keep working. Links to notes you haven't shared become plain text rather than dead links.

## Commands

- Connect to mininote
- Share current note to mininote
- Quick share current note (use defaults)
- Stop sharing current note
- Disconnect from mininote

## License

MIT.
