import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import { notify } from "./notify";
import { attachHoverCard } from "./hover";
import { relTime, type ShareMap, type ShareRecord } from "./state";

export const SHARES_VIEW = "mininote-shares";
export const MINI_ICON = "mininote-mini";

// SharesHost is the slice of the plugin the view needs — keeps the view decoupled from the plugin.
export interface SharesHost {
  shares(): ShareMap;
  isConnected(): boolean;
  connect(): void;
  shareActive(): void;
  shareUrlFor(rec: ShareRecord): string;
  openLink(url: string): void;
  openNote(path: string): void;
  manageByPath(path: string): void;
  revokeByPath(path: string): Promise<void>;
  forceResync(path: string): void;
  folderNotes(folderPath: string): string[]; // ALL .md notes under a shared folder (recursive) — for the count
  folderChildren(folderPath: string): { folders: string[]; notes: string[] }; // IMMEDIATE children — for the tree
}

// SharesView is the mininote sidebar leaf: every note/folder this vault has shared, with quick
// actions (open, copy, manage, stop). Refreshed by the plugin whenever the share set changes.
export class SharesView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private host: SharesHost) { super(leaf); }

  // Which folder rows are expanded to show their contained notes. Kept on the instance so the state
  // survives a re-render (the plugin re-renders the view on every share-set change).
  private expanded = new Set<string>();

  getViewType() { return SHARES_VIEW; }
  getDisplayText() { return "mininote shares"; }
  getIcon() { return MINI_ICON; }

  async onOpen() {
    // Header actions live on the view's title bar (survive re-render, which only clears contentEl).
    this.addAction("share", "Share current note", () => this.host.shareActive());
    this.addAction("refresh-cw", "Refresh", () => this.render());
    this.render();
  }
  async onClose() { this.contentEl.empty(); }

  render() {
    const c = this.contentEl;
    c.empty();
    c.addClass("mn-shares-view");

    if (!this.host.isConnected()) {
      this.emptyState(c, "Not connected", "Connect your mininote account to publish notes and see your shares here.", "Connect to mininote", () => this.host.connect());
      return;
    }

    const entries = Object.entries(this.host.shares());
    if (entries.length === 0) {
      this.emptyState(c, "No shares yet", "Right-click any note or folder, then mininote → Share to publish it. Your shares show up here.");
      return;
    }
    const folders = entries.filter(([k]) => !k.endsWith(".md")).sort(byName);
    const notes = entries.filter(([k]) => k.endsWith(".md")).sort(byName);
    if (folders.length) this.section(c, "Folders", folders, true);
    if (notes.length) this.section(c, "Notes", notes, false);
  }

  // emptyState is the connect / no-shares placeholder: the Mini glyph over a heading + one line, so
  // the panel never reads as a bare sentence. An optional CTA button follows.
  private emptyState(parent: HTMLElement, heading: string, body: string, cta?: string, onCta?: () => void) {
    const wrap = parent.createDiv({ cls: "mn-sv-empty" });
    const glyph = wrap.createDiv({ cls: "mn-sv-empty-glyph" });
    setIcon(glyph, MINI_ICON);
    wrap.createDiv({ cls: "mn-sv-empty-title", text: heading });
    wrap.createDiv({ cls: "mn-sv-empty-body", text: body });
    if (cta && onCta) {
      const b = wrap.createEl("button", { cls: "mod-cta mn-sv-empty-cta", text: cta });
      b.onclick = onCta;
    }
  }

  private section(parent: HTMLElement, title: string, entries: [string, ShareRecord][], isFolder: boolean) {
    const head = parent.createDiv({ cls: "mn-sv-section" });
    head.createSpan({ cls: "mn-sv-section-label", text: title });
    head.createSpan({ cls: "mn-sv-section-count", text: String(entries.length) });
    const list = parent.createDiv({ cls: "mn-sv-list" });
    for (const [path, rec] of entries) {
      const row = list.createDiv({ cls: "mn-sv-row" });

      // A shared folder publishes its whole subtree under one link — make the row expandable to reveal
      // the notes inside it. The leading icon doubles as the disclosure chevron.
      const notes = isFolder ? this.host.folderNotes(path) : [];
      const open = isFolder && this.expanded.has(path);
      const icon = row.createDiv({ cls: "mn-sv-rowicon" });
      if (isFolder) {
        icon.addClass("mn-sv-chevron");
        setIcon(icon, open ? "chevron-down" : "chevron-right");
        icon.setAttr("aria-label", open ? "Hide notes" : "Show notes");
        icon.onclick = (e) => {
          e.stopPropagation();
          if (open) this.expanded.delete(path); else this.expanded.add(path);
          this.render();
        };
      } else {
        setIcon(icon, "file-text");
      }

      const main = row.createDiv({ cls: "mn-sv-main" });
      main.createDiv({ cls: "mn-sv-name", text: nameOf(path) });
      const sub = main.createDiv({ cls: "mn-sv-sub mn-muted" });
      sub.setText(
        isFolder ? plural(notes.length, "note")
          : rec.lastSyncedAt ? "synced " + relTime(rec.lastSyncedAt)
          : rec.updatedAt ? "updated " + relTime(rec.updatedAt)
          : path,
      );
      main.onclick = () => this.host.manageByPath(path);
      attachHoverCard(main, (card) => this.buildCard(card, path, rec, isFolder, notes));

      const acts = row.createDiv({ cls: "mn-sv-acts" });
      this.act(acts, "copy", "Copy link", async () => {
        await navigator.clipboard.writeText(this.host.shareUrlFor(rec)).catch(() => {});
        notify("mininote: link copied");
      });
      this.act(acts, "external-link", "Open link", () => this.host.openLink(this.host.shareUrlFor(rec)));
      this.act(acts, "more-vertical", "More actions", (e) => this.rowMenu(path, rec, isFolder, e));

      // Right-click anywhere on the row opens the same menu.
      row.addEventListener("contextmenu", (e) => { e.preventDefault(); this.rowMenu(path, rec, isFolder, e); });

      // Expanded folder: render its subtree (nested subfolders get their own expanders).
      if (open) this.renderTree(list, path);
    }
  }

  // renderTree draws a shared folder's contents as a real tree: immediate subfolders (each its own
  // expander, keyed by path in `expanded`) then notes. Nesting indents via the .mn-sv-children rule.
  private renderTree(parent: HTMLElement, folderPath: string) {
    const { folders, notes } = this.host.folderChildren(folderPath);
    const box = parent.createDiv({ cls: "mn-sv-children" });
    if (!folders.length && !notes.length) {
      box.createDiv({ cls: "mn-sv-child mn-sv-child-empty", text: "Empty folder" });
      return;
    }
    for (const sub of folders) {
      const open = this.expanded.has(sub);
      const row = box.createDiv({ cls: "mn-sv-child mn-sv-child-folder" });
      const ic = row.createDiv({ cls: "mn-sv-rowicon mn-sv-chevron" });
      setIcon(ic, open ? "chevron-down" : "chevron-right");
      row.createDiv({ cls: "mn-sv-child-name", text: nameOf(sub) });
      row.setAttr("aria-label", open ? "Hide notes" : "Show notes");
      row.onclick = () => { if (open) this.expanded.delete(sub); else this.expanded.add(sub); this.render(); };
      if (open) this.renderTree(box, sub);
    }
    for (const kp of notes) {
      const row = box.createDiv({ cls: "mn-sv-child" });
      const ic = row.createDiv({ cls: "mn-sv-rowicon" });
      setIcon(ic, "file-text");
      row.createDiv({ cls: "mn-sv-child-name", text: nameOf(kp) });
      row.setAttr("aria-label", kp);
      row.onclick = () => this.host.openNote(kp);
    }
  }

  // buildCard fills the rich hover preview for a share row: identity, the public link, sync state,
  // and the enabled options as badges — the detail that doesn't fit a one-line row.
  private buildCard(card: HTMLElement, path: string, rec: ShareRecord, isFolder: boolean, notes: string[]) {
    const head = card.createDiv({ cls: "mn-hover-head" });
    const hi = head.createDiv({ cls: "mn-hover-icon" });
    setIcon(hi, isFolder ? "folder" : "file-text");
    head.createDiv({ cls: "mn-hover-title", text: nameOf(path) });

    const rows = card.createDiv({ cls: "mn-hover-rows" });
    this.cardRow(rows, "Path", path);
    this.cardRow(rows, "Link", this.host.shareUrlFor(rec), true);
    if (isFolder) this.cardRow(rows, "Contents", plural(notes.length, "note"));
    if (rec.updatedAt) this.cardRow(rows, "Updated", relTime(rec.updatedAt));       // page's last edit (server)
    if (rec.lastSyncedAt) this.cardRow(rows, "Synced", relTime(rec.lastSyncedAt));  // last push from this vault

    const o = rec.options;
    const badges: string[] = [];
    if (o.password) badges.push("Password");
    if (o.allowFork) badges.push("Forkable");
    if (o.allowRaw) badges.push("Raw source");
    if (o.allowAnnotations) badges.push("Annotations");
    if (o.allowExport) badges.push("Downloads");
    const ps = rec.pageSettings;
    if (ps?.width === "wide") badges.push("Wide");
    if (ps?.unlisted) badges.push("Unlisted");
    const bar = card.createDiv({ cls: "mn-hover-badges" });
    if (badges.length) for (const b of badges) bar.createSpan({ cls: "mn-hover-badge", text: b });
    else bar.createSpan({ cls: "mn-hover-badge mn-hover-badge-plain", text: "Public · view only" });
  }

  private cardRow(parent: HTMLElement, label: string, value: string, mono = false) {
    const r = parent.createDiv({ cls: "mn-hover-row" });
    r.createSpan({ cls: "mn-hover-label", text: label });
    r.createSpan({ cls: "mn-hover-value" + (mono ? " mn-hover-mono" : ""), text: value });
  }

  private rowMenu(path: string, rec: ShareRecord, isFolder: boolean, e: MouseEvent) {
    const url = this.host.shareUrlFor(rec);
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Open link").setIcon("external-link").onClick(() => this.host.openLink(url)));
    menu.addItem((i) => i.setTitle("Copy link").setIcon("copy").onClick(async () => {
      await navigator.clipboard.writeText(url).catch(() => {});
      notify("mininote: link copied");
    }));
    if (!isFolder) menu.addItem((i) => i.setTitle("Open note").setIcon("pencil").onClick(() => this.host.openNote(path)));
    menu.addItem((i) => i.setTitle("Force resync").setIcon("refresh-cw").onClick(() => this.host.forceResync(path)));
    menu.addItem((i) => i.setTitle("Manage share…").setIcon("settings").onClick(() => this.host.manageByPath(path)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(isFolder ? "Stop sharing folder" : "Stop sharing").setIcon("trash-2").setWarning(true).onClick(() => void this.host.revokeByPath(path)));
    menu.showAtMouseEvent(e);
  }

  private act(parent: HTMLElement, icon: string, label: string, fn: (e: MouseEvent) => void) {
    const b = parent.createEl("button", { cls: "mn-sv-act clickable-icon", attr: { "aria-label": label } });
    setIcon(b, icon);
    b.onclick = (e) => { e.stopPropagation(); fn(e); };
  }
}

const nameOf = (path: string): string => path.replace(/\.md$/i, "").split("/").pop() || path;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const byName = (a: [string, ShareRecord], b: [string, ShareRecord]) => nameOf(a[0]).localeCompare(nameOf(b[0]));
