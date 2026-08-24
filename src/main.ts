import { addIcon, App, Notice, Plugin, PluginSettingTab, TAbstractFile, TFile, TFolder, type Menu, type MenuItem, type ObsidianProtocolData, type SettingDefinitionItem, type WorkspaceLeaf } from "obsidian";
import { Api, ReauthNeeded, type TokenStore } from "./api";
import { Mn } from "./mn";
import { authorizeUrl, challengeFor, exchangeCode, randomUrlToken, type Tokens } from "./oauth";
import { pagePath, parentPath, mirrorNote, publishNote, shareNode, shareUrl, stripFrontmatter, type PublishResult } from "./publish";
import { rewriteImages, scanImages } from "./images";
import { ShareModal } from "./share-modal";
import { FolderShareModal } from "./folder-modal";
import { DEFAULT_OPTIONS, DEFAULT_PAGE_SETTINGS, relTime, type ShareMap, type ShareRecord, type PageSettings } from "./state";
import { SharesView, SHARES_VIEW, MINI_ICON } from "./shares-view";
import { notify, notifyErr, notifyAction, clearToasts, type ToastAction } from "./notify";
import { clearHovers } from "./hover";
import type { ShareOptions } from "./mn";

const REDIRECT_URI = "obsidian://mininote-auth";
const PROTOCOL_ACTION = "mininote-auth";

// setSubmenu shipped in Obsidian ~1.4 but isn't in the pinned obsidian type defs yet.
type MenuItemWithSubmenu = MenuItem & { setSubmenu(): Menu };

// Build flags (esbuild define — see esbuild.config.mjs, which owns the dev/prod values):
//   __MN_DEV__    true in dev builds (npm run dev), false in production (npm run build). Dev builds
//                 expose the Server URL / Client ID fields; production hides them so users just Connect.
//   __MN_BASE__   the mininote instance URL baked in at build time.
//   __MN_CLIENT__ the OAuth client id baked in at build time (public — appears in every authorize URL).
declare const __MN_DEV__: boolean;
declare const __MN_BASE__: string;
declare const __MN_CLIENT__: string;

// Mini, the mininote rabbit — mirrors frontend icons.tsx Rabbit, scaled from a 24x24 to addIcon's
// 100x100 viewBox. Swap this string to change the sidebar/ribbon glyph.
const MINI_SVG =
  `<g fill="currentColor" stroke="none" transform="scale(4.1667)">` +
  `<ellipse cx="9" cy="5.3" rx="1.5" ry="4" transform="rotate(-11 9 5.3)"/>` +
  `<ellipse cx="13.4" cy="4.9" rx="1.5" ry="4.1" transform="rotate(11 13.4 4.9)"/>` +
  `<circle cx="11" cy="11.4" r="3.5"/>` +
  `<ellipse cx="12" cy="18" rx="5" ry="4"/>` +
  `<circle cx="16.8" cy="18.6" r="1.3"/>` +
  `</g>`;

interface MininoteSettings {
  base: string;
  clientId: string;
  mirrorRoot: string;
  syncMoves: boolean;   // vault move/rename -> move the mininote page (URL preserved)
  syncDeletes: boolean; // vault delete -> revoke + delete the mininote page
  syncEdits: boolean;   // edit a shared note -> debounce-push the new body to mininote
  syncTags: boolean;    // push the note's tags (inline + frontmatter) to its mininote node
  syncNotices: boolean; // show a toast for each passive background sync (default off — status bar + sidebar already reflect it)
  defaultOptions: ShareOptions;  // the share options a NEW share starts from (user-set in settings)
  defaultPage: PageSettings;     // the page settings a NEW share starts from
  tokens: Tokens | null;
  subject: string;      // from userInfo (identity scope) -> the account these shares belong to
  handle: string;       // from userInfo (identity scope) -> brands share URLs
  appDomain: string;    // from userInfo -> <handle>.<appDomain>/s/<token>
  shares: ShareMap;
}

const DEFAULT_SETTINGS: MininoteSettings = {
  base: __MN_BASE__,
  clientId: __MN_CLIENT__,
  mirrorRoot: "Vault",
  syncMoves: true,
  syncDeletes: true,
  syncEdits: true,
  syncTags: true,
  syncNotices: false,
  defaultOptions: { ...DEFAULT_OPTIONS },
  defaultPage: { ...DEFAULT_PAGE_SETTINGS },
  tokens: null,
  subject: "",
  handle: "",
  appDomain: "",
  shares: {},
};

// Bridges the Api's token needs to persisted settings. Getters read live so a settings change takes
// effect without rebuilding the Api.
class SettingsTokenStore implements TokenStore {
  constructor(private plugin: MininotePlugin) {}
  get base() { return this.plugin.settings.base; }
  get clientId() { return this.plugin.settings.clientId; }
  get tokens() { return this.plugin.settings.tokens; }
  async save(t: Tokens | null) { this.plugin.settings.tokens = t; await this.plugin.saveSettings(); }
}

export default class MininotePlugin extends Plugin {
  settings!: MininoteSettings;
  api!: Api;
  mn!: Mn;
  private pending: { verifier: string; state: string } | null = null;
  private pendingTimer = 0; // clears an abandoned sign-in (browser closed / never returned)
  private statusEl: HTMLElement | null = null;
  private settingTab: MininoteSettingTab | null = null;
  private editTimers = new Map<string, number>(); // window.setTimeout ids (numbers in the Obsidian runtime)

  async onload() {
    await this.loadSettings();
    this.api = new Api(new SettingsTokenStore(this));
    this.mn = new Mn(this.api);

    addIcon(MINI_ICON, MINI_SVG);
    this.registerView(SHARES_VIEW, (leaf: WorkspaceLeaf) => new SharesView(leaf, this));

    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => this.onOAuthCallback(params));

    this.addRibbonIcon(MINI_ICON, "mininote: your shares", () => void this.activateView());
    this.addRibbonIcon("share", "Share current note to mininote", () => {
      const file = this.app.workspace.getActiveFile();
      if (file && file.extension === "md") void this.openShareModal(file);
      else notify("mininote: open a markdown note first");
    });

    // Persistent status-bar indicator for the active note: shared vs not, click to manage.
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    this.statusEl.onClickEvent(() => {
      if (!this.isConnected()) { void this.connect(); return; }
      const file = this.app.workspace.getActiveFile();
      if (file && file.extension === "md") void this.openShareModal(file);
    });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateStatus()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.updateStatus()));
    this.registerInterval(window.setInterval(() => this.updateStatus(), 60000)); // keep "synced Xm ago" fresh

    this.addCommand({
      id: "connect",
      name: "Connect",
      checkCallback: (checking) => {
        if (this.isConnected()) return false; // only when NOT connected
        if (!checking) void this.connect();
        return true;
      },
    });
    this.addCommand({
      id: "share",
      name: "Share current note",
      checkCallback: (checking) => {
        if (!this.isConnected()) return false;
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.openShareModal(file);
        return true;
      },
    });
    this.addCommand({
      id: "quick-share",
      name: "Quick share current note (use defaults)",
      checkCallback: (checking) => {
        if (!this.isConnected()) return false;
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.quickShare(file);
        return true;
      },
    });
    this.addCommand({
      id: "push-private",
      name: "Push current note (private, no share)",
      checkCallback: (checking) => {
        if (!this.isConnected()) return false;
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.pushPrivate(file);
        return true;
      },
    });
    this.addCommand({
      id: "unshare",
      name: "Stop sharing current note",
      checkCallback: (checking) => {
        if (!this.isConnected()) return false;
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.settings.shares[file.path]) return false;
        if (!checking) void this.unshare(file);
        return true;
      },
    });
    this.addCommand({
      id: "disconnect",
      name: "Disconnect",
      checkCallback: (checking) => {
        if (!this.isConnected()) return false; // only when connected
        if (!checking) void this.disconnect();
        return true;
      },
    });

    // Right-click a note or folder in the explorer -> a single "mininote" submenu.
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (file instanceof TFile && file.extension === "md") {
        const rec = this.settings.shares[file.path];
        const shared = !!rec?.token;
        const tracked = !!rec;
        menu.addItem((item) => {
          item.setTitle("mininote").setIcon("share");
          const sub = (item as MenuItemWithSubmenu).setSubmenu();
          sub.addItem((i) => i.setTitle(shared ? "Update share" : "Share").setIcon("share").onClick(() => void this.openShareModal(file)));
          sub.addItem((i) => i.setTitle("Push (private)").setIcon("upload").onClick(() => void this.pushPrivate(file)));
          if (shared) sub.addItem((i) => i.setTitle("Stop sharing").setIcon("x").onClick(() => void this.unshare(file)));
          else if (tracked) sub.addItem((i) => i.setTitle("Remove from mininote").setIcon("trash-2").onClick(() => void this.removeFromMininote(file)));
        });
      } else if (file instanceof TFolder) {
        const count = this.markdownFilesUnder(file).length;
        if (count === 0) return;
        const shared = !!this.settings.shares[file.path]?.token;
        menu.addItem((item) => {
          item.setTitle("mininote").setIcon("share");
          const sub = (item as MenuItemWithSubmenu).setSubmenu();
          // The folder modal offers BOTH Publish (share) and Push (private); this opens it.
          sub.addItem((i) => i.setTitle(shared ? `Update folder share (${count})` : `Share folder (${count})`).setIcon("share").onClick(() => this.shareFolder(file)));
          sub.addItem((i) => i.setTitle(`Push folder private (${count})`).setIcon("upload").onClick(() => void this.quickPushFolder(file)));
          if (shared) sub.addItem((i) => i.setTitle("Stop sharing folder").setIcon("x").onClick(() => void this.unshareFolder(file)));
        });
      }
    }));
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, _editor, view) => {
      const file = view.file;
      if (file && file.extension === "md") menu.addItem((i) => i.setTitle("Share to mininote").setIcon("share-2").onClick(() => void this.openShareModal(file)));
    }));

    // One-way sync: keep mininote in step when a shared vault file is edited, moved, or deleted.
    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultModify(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.onVaultRename(file, oldPath)));
    this.registerEvent(this.app.vault.on("delete", (file) => void this.onVaultDelete(file)));
    // A NEW note inside a shared folder should join that folder's share. Registered after layout-ready
    // so Obsidian's startup "create" storm (it fires create for every existing file on load) doesn't
    // re-publish the whole vault. Empty folders are ignored — nothing to share until a note exists.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", (file) => void this.onVaultCreate(file)));
    });

    this.settingTab = new MininoteSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.updateStatus();

    // Make the need-to-connect obvious on first run (Obsidian has no install hook). Deferred so it
    // shows after the workspace is ready, not mid-startup.
    if (!this.isConnected()) {
      this.app.workspace.onLayoutReady(() => {
        notify("mininote: connect your account to start sharing — click \"mininote: connect\" in the status bar, or run the \"Connect to mininote\" command.", 10000);
      });
    } else {
      // Already connected: reconcile the local share list with the account so shares made on another
      // machine (or lost from this one) show up. Deferred + best-effort — never block startup.
      this.app.workspace.onLayoutReady(() => void this.hydrateShares());
    }
  }

  // ---- auth ----------------------------------------------------------------

  async connect() {
    if (!this.settings.clientId) { notify("mininote: set a client id in settings first"); return; }
    this.clearPending(); // a restart of the flow supersedes any in-flight one
    const verifier = randomUrlToken(32);
    const state = randomUrlToken(16);
    this.pending = { verifier, state };
    // The sign-in happens off in the browser; if it's abandoned (tab closed, never returned) nothing
    // would ever clear `pending`. Time it out so a later callback can't complete a stale attempt and
    // the flow doesn't hang silently.
    this.pendingTimer = window.setTimeout(() => {
      if (this.pending) { this.pending = null; notify("mininote: sign-in timed out — run Connect again"); }
    }, 5 * 60 * 1000);
    const url = authorizeUrl(this.settings.base, this.settings.clientId, REDIRECT_URI, await challengeFor(verifier), state);
    notify("mininote: opening browser to sign in…");
    this.openExternal(url);
  }

  // clearPending ends the in-flight sign-in: drop the pending PKCE state + cancel its timeout.
  private clearPending() {
    if (this.pendingTimer) { window.clearTimeout(this.pendingTimer); this.pendingTimer = 0; }
    this.pending = null;
  }

  private async onOAuthCallback(params: ObsidianProtocolData) {
    if (this.pendingTimer) { window.clearTimeout(this.pendingTimer); this.pendingTimer = 0; }
    try {
      if (params.error) throw new Error(String(params.error));
      const p = this.pending;
      if (!p) throw new Error("no sign-in in progress");
      if (!params.state || params.state !== p.state) throw new Error("state mismatch — sign-in aborted");
      if (!params.code) throw new Error("no authorization code returned");
      const tokens = await exchangeCode(this.settings.base, this.settings.clientId, REDIRECT_URI, params.code, p.verifier);
      this.pending = null;
      this.settings.tokens = tokens;
      await this.saveSettings();
      await this.refreshIdentity(); // learn handle + app_domain so share links are branded
      await this.hydrateShares();   // rebuild the local share list from the account (this machine may have none)
      notify("mininote: connected" + (this.settings.handle ? ` as ${this.settings.handle}` : ""));
      this.refreshSettingsTab(); // connect finishes async (OAuth round-trip) — re-render an open settings tab
    } catch (e) {
      this.pending = null;
      notifyErr("mininote: sign-in failed — " + errMsg(e));
    }
  }

  async disconnect() {
    this.settings.tokens = null;
    this.settings.subject = "";
    this.settings.handle = "";
    this.settings.appDomain = "";
    this.settings.shares = {}; // shares are bound to the disconnected account — don't carry them over
    await this.saveSettings();
    this.updateStatus();
    this.refreshSettingsTab(); // command-triggered disconnect must re-render the tab too
    notify("mininote: disconnected");
  }

  // refreshSettingsTab re-renders the settings tab, but only when it's actually on screen — so an
  // async connect/disconnect reflects immediately, without nuking focus in a field on the 60s tick.
  private refreshSettingsTab() {
    if (this.settingTab && this.settingTab.containerEl.isConnected) this.settingTab.update();
  }

  // hydrateShares rebuilds the local share map from the account's live shares. The map is per-machine
  // (data.json), so connecting on a new machine — or reconnecting after a disconnect cleared it — would
  // otherwise show an empty sidebar even though the account has shares. Share.fromPath(mirrorRoot)
  // returns only the shares under our mirror (server normalizes the casing so "Vault" matches the
  // slug-lowercased tree) with each path RELATIVE to it. mininote slugifies path segments (lowercase,
  // hyphenated), so we resolve each back to the REAL vault file/folder case-insensitively — the vault
  // is the source of truth for the original casing. Additive: a locally-tracked share (with its richer
  // options + last-synced time) is left as-is; only shares we don't already know about are added.
  private async hydrateShares() {
    if (!this.settings.tokens) return;
    try {
      const { shares } = await this.mn.sharesFromPath(this.settings.mirrorRoot);
      if (!shares?.length) return;
      // Case-insensitive index of vault paths → their real (original-cased) path, so a slugified
      // mininote path resolves to the actual file/folder to key the share by.
      const byLower = new Map<string, string>();
      for (const f of this.app.vault.getAllLoadedFiles()) byLower.set(f.path.toLowerCase(), f.path);
      let added = 0;
      for (const sh of shares) {
        const rel = (sh.path ?? "").replace(/^\/+/, "");
        if (!rel) continue; // the mirror root folder itself
        const isFolder = sh.kind === "folder";
        const guess = isFolder ? rel : rel + ".md";                     // folder shares are keyed without .md
        const vaultKey = byLower.get(guess.toLowerCase()) ?? guess;     // real cased path if the file exists locally
        const existing = this.settings.shares[vaultKey];
        if (existing && existing.token === sh.token) continue;          // already tracked (keep its options + sync time)
        const updatedAt = sh.updated_at ? Date.parse(sh.updated_at) || undefined : undefined;
        this.settings.shares[vaultKey] = {
          pageId: sh.page_id,
          token: sh.token,
          mininotePath: pagePath(this.settings.mirrorRoot, vaultKey),   // recompute from the real vault path
          options: existing?.options ?? { ...DEFAULT_OPTIONS, allowFork: !!sh.allow_fork },
          lastSyncedAt: existing?.lastSyncedAt,
          updatedAt,
        };
        added++;
      }
      if (added) { await this.saveSettings(); this.updateStatus(); }
    } catch { /* offline / missing scope — the sidebar just shows whatever we already have locally */ }
  }

  // ---- share ---------------------------------------------------------------

  // refreshIdentity pulls the handle + app domain (identity scope) so share links can be branded.
  private async refreshIdentity() {
    try {
      const me = await this.mn.userInfo();
      const newSub = me.subject ?? "";
      // Reconnected as a DIFFERENT account: the stored shares (pageIds/tokens bound to the prior
      // user) don't belong to this one — drop them so they don't leak across accounts. Only fire
      // on a real mismatch (both non-empty); an empty stored subject is a fresh/pre-upgrade connect
      // that should adopt the new subject without wiping.
      if (this.settings.subject && newSub && this.settings.subject !== newSub) {
        this.settings.shares = {};
      }
      this.settings.subject = newSub;
      this.settings.handle = me.handle ?? "";
      this.settings.appDomain = me.app_domain ?? "";
      await this.saveSettings();
      this.updateStatus(); // reflect a wiped share list in the sidebar
    } catch { /* no identity scope / offline — links fall back to the apex /s/ path */ }
  }

  private async openShareModal(file: TFile) {
    if (!this.settings.tokens) { notify("mininote: run Connect first"); return; }
    const record = this.settings.shares[file.path] ?? null;
    let warn: string | null = null;
    try {
      const scan = scanImages(stripFrontmatter(await this.app.vault.read(file)));
      if (scan.local.length) {
        const s = scan.local.length === 1 ? "" : "s";
        warn = `${scan.local.length} local image${s} won't be published — they stay in your vault.`
          + (scan.remote.length ? ` ${scan.remote.length} remote image${scan.remote.length === 1 ? "" : "s"} will load through mininote's gate.` : "");
      }
    } catch { /* scan is best-effort */ }
    new ShareModal(this.app, {
      fileName: file.path,
      mininotePath: pagePath(this.settings.mirrorRoot, file.path),
      warn,
      existing: record,
      existingUrl: record?.token ? shareUrl(this.settings.base, record.token, this.settings.handle, this.settings.appDomain) : null,
      initial: record?.options ?? { ...this.settings.defaultOptions },
      initialPage: record?.pageSettings ?? { ...this.settings.defaultPage },
      publish: (opts, page) => this.doPublish(file, opts, page),
      unshare: () => this.unshare(file),
      openUrl: (url) => this.openExternal(url),
    }).open();
  }

  // quickShare publishes the active note straight from the saved defaults — no modal — and hands back
  // the link in an action toast. If it's already shared, it just surfaces the existing link.
  private async quickShare(file: TFile) {
    if (!this.settings.tokens) { notify("mininote: run Connect first"); return; }
    const existing = this.settings.shares[file.path];
    if (existing) { notifyAction("mininote: already shared", this.linkActions(this.shareUrlFor(existing))); return; }
    try {
      const res = await this.doPublish(file, { ...this.settings.defaultOptions }, { ...this.settings.defaultPage });
      notifyAction("mininote: shared", this.linkActions(res.url));
    } catch (e) {
      if (e instanceof ReauthNeeded) { notifyErr("mininote: " + e.message + " — run Connect"); return; }
      notifyErr("mininote: share failed — " + errMsg(e));
    }
  }

  // pushPrivate mirrors the active note UP to mininote WITHOUT sharing it — a one-way private copy in
  // your workspace, no public link. Tracked with token:"" so the sidebar + edit/move/delete sync all
  // treat it like any tracked note (minus the public-link actions). Promote it to a share any time.
  private async pushPrivate(file: TFile) {
    if (!this.settings.tokens) { notify("mininote: run Connect first"); return; }
    const existing = this.settings.shares[file.path];
    try {
      const raw = await this.app.vault.read(file);
      const pageId = await mirrorNote(this.mn, {
        base: this.settings.base,
        mirrorRoot: this.settings.mirrorRoot,
        vaultPath: file.path,
        title: titleFor(file, raw),
        body: this.buildPublishBody(file, raw),
        handle: this.settings.handle,
        appDomain: this.settings.appDomain,
      });
      const page = existing?.pageSettings ?? { ...this.settings.defaultPage };
      if (this.settings.syncTags) { try { await this.mn.syncTags(pageId, this.tagsFor(file)); } catch { /* tags best-effort */ } }
      try { await this.mn.applyPageConfig(pageId, page); } catch { /* page-config best-effort */ }
      const now = Date.now();
      this.settings.shares[file.path] = {
        pageId,
        token: existing?.token ?? "", // keep an existing share if this note was already public; else private
        mininotePath: pagePath(this.settings.mirrorRoot, file.path),
        options: existing?.options ?? { ...this.settings.defaultOptions },
        pageSettings: page,
        lastSyncedAt: now,
        updatedAt: now,
      };
      await this.saveSettings();
      this.updateStatus();
      notify(existing?.token ? "mininote: synced" : "mininote: copied to mininote (private)");
    } catch (e) {
      if (e instanceof ReauthNeeded) { notifyErr("mininote: " + e.message + " — run Connect"); return; }
      notifyErr("mininote: push failed — " + errMsg(e));
    }
  }

  private async doPublish(file: TFile, opts: ShareOptions, page: PageSettings): Promise<PublishResult> {
    const raw = await this.app.vault.read(file);
    if (!this.settings.handle) await this.refreshIdentity(); // ensure branded link even if connected before this build
    const res = await publishNote(this.mn, {
      base: this.settings.base,
      mirrorRoot: this.settings.mirrorRoot,
      vaultPath: file.path,
      title: titleFor(file, raw),
      body: this.buildPublishBody(file, raw),
      handle: this.settings.handle,
      appDomain: this.settings.appDomain,
    }, opts);
    if (this.settings.syncTags) { try { await this.mn.syncTags(res.pageId, this.tagsFor(file)); } catch { /* tags best-effort */ } }
    try { await this.mn.applyPageConfig(res.pageId, page); } catch { /* page-config best-effort */ }
    const now = Date.now();
    const rec: ShareRecord = { pageId: res.pageId, token: res.token, mininotePath: pagePath(this.settings.mirrorRoot, file.path), options: opts, pageSettings: page, lastSyncedAt: now, updatedAt: now };
    this.settings.shares[file.path] = rec;
    await this.saveSettings();
    this.updateStatus();
    return res;
  }

  // unshare revokes the public share but KEEPS the private mirror (token -> "") — sharing is a layer on
  // top of a mirrored copy, so removing it leaves the note in your workspace, still edit-synced.
  private async unshare(file: TFile) {
    const rec = this.settings.shares[file.path];
    if (!rec?.token) { notify("mininote: this note isn't shared"); return; }
    try {
      await this.mn.shareRevoke(rec.pageId); // the mirrored page stays; re-share re-finds it by path
      rec.token = "";
      await this.saveSettings();
      this.updateStatus();
      notify("mininote: stopped sharing — still mirrored (private)");
    } catch (e) {
      if (e instanceof ReauthNeeded) { notifyErr("mininote: " + e.message + " — run Connect"); return; }
      notifyErr("mininote: couldn't stop sharing — " + errMsg(e));
    }
  }

  // removeFromMininote deletes the mininote page entirely (revoking any share first) and drops tracking
  // — the full "take it off mininote", vs unshare which keeps the private copy.
  private async removeFromMininote(file: TFile) {
    const rec = this.settings.shares[file.path];
    if (!rec) { notify("mininote: this note isn't on mininote"); return; }
    try {
      if (rec.token) await this.mn.shareRevoke(rec.pageId);
      await this.mn.deletePage(rec.pageId);
      delete this.settings.shares[file.path];
      await this.saveSettings();
      this.updateStatus();
      notify("mininote: removed from mininote");
    } catch (e) {
      if (e instanceof ReauthNeeded) { notifyErr("mininote: " + e.message + " — run Connect"); return; }
      notifyErr("mininote: couldn't remove — " + errMsg(e));
    }
  }

  // ---- folder (bulk) share -------------------------------------------------

  private markdownFilesUnder(folder: TFolder): TFile[] {
    const all = this.app.vault.getMarkdownFiles();
    if (folder.isRoot()) return all;
    const prefix = folder.path + "/";
    return all.filter((f) => f.path.startsWith(prefix));
  }

  private folderMirrorPath(folder: TFolder): string {
    const root = this.settings.mirrorRoot.replace(/^\/|\/$/g, "");
    if (folder.isRoot()) return root;
    return (root ? root + "/" : "") + folder.path;
  }

  // quickPushFolder mirrors a folder privately straight from the context menu (no modal) — every note
  // upserted, no share — with a live progress notice for the (possibly many) notes.
  private async quickPushFolder(folder: TFolder) {
    if (!this.settings.tokens) { notify("mininote: run Connect first"); return; }
    const files = this.markdownFilesUnder(folder);
    if (files.length === 0) { notify("mininote: no notes in this folder"); return; }
    const existing = this.settings.shares[folder.path];
    const note = new Notice(`mininote: pushing 0/${files.length}…`, 0);
    try {
      const r = await this.pushFolderPrivate(folder, existing?.pageSettings ?? { ...this.settings.defaultPage }, (done) => note.setMessage(`mininote: pushing ${done}/${files.length}…`));
      note.hide();
      notify(`mininote: pushed ${r.ok}/${r.total} (private)`);
    } catch (e) {
      note.hide();
      if (e instanceof ReauthNeeded) { notifyErr("mininote: " + e.message + " — run Connect"); return; }
      notifyErr("mininote: push failed — " + errMsg(e));
    }
  }

  private shareFolder(folder: TFolder) {
    if (!this.settings.tokens) { notify("mininote: run Connect first"); return; }
    const files = this.markdownFilesUnder(folder);
    if (files.length === 0) { notify("mininote: no notes in this folder"); return; }
    const existing = this.settings.shares[folder.path] ?? null;
    new FolderShareModal(this.app, {
      folderPath: folder.path,
      count: files.length,
      existingUrl: existing?.token ? shareUrl(this.settings.base, existing.token, this.settings.handle, this.settings.appDomain) : null,
      initial: existing?.options ?? { ...this.settings.defaultOptions },
      initialPage: existing?.pageSettings ?? { ...this.settings.defaultPage },
      unshare: () => this.unshareFolder(folder),
      openUrl: (url) => this.openExternal(url),
      publishAll: (opts, page, onProgress) => this.publishFolder(folder, opts, page, onProgress),
    }).open();
  }

  // mirrorFolderNotes upserts every note under a folder (+ tags + cascaded page config) and ensures the
  // folder node exists — the shared building block behind BOTH the public folder share and the private
  // folder mirror. The page settings cascade to every note (only when non-default, so a plain push pays
  // no extra writes). Returns counts + the folder node id + its mininote path.
  private async mirrorFolderNotes(folder: TFolder, page: PageSettings, onProgress?: (done: number) => void) {
    const files = this.markdownFilesUnder(folder);
    const cascade = page.width !== "" || page.unlisted;
    let ok = 0, fail = 0, done = 0;
    for (const f of files) {
      try {
        const raw = await this.app.vault.read(f);
        const pg = await this.mn.upsert(pagePath(this.settings.mirrorRoot, f.path), titleFor(f, raw), this.buildPublishBody(f, raw));
        if (this.settings.syncTags && pg?.id) { try { await this.mn.syncTags(pg.id, this.tagsFor(f)); } catch { /* tags best-effort */ } }
        if (cascade && pg?.id) { try { await this.mn.applyPageConfig(pg.id, page); } catch { /* page-config best-effort */ } }
        ok++;
      } catch { fail++; }
      onProgress?.(++done);
    }
    const folderMirror = this.folderMirrorPath(folder);
    const folderNode = await this.mn.ensureFolder(folderMirror);
    return { ok, fail, total: files.length, folderId: folderNode.id, folderMirror };
  }

  // publishFolder mirrors the subtree then SHARES the folder node (one public link). Reused by the
  // folder modal + force-resync.
  private async publishFolder(folder: TFolder, opts: ShareOptions, page: PageSettings, onProgress?: (done: number) => void) {
    if (!this.settings.handle) await this.refreshIdentity();
    const m = await this.mirrorFolderNotes(folder, page, onProgress);
    const { token, url } = await shareNode(this.mn, m.folderId, opts, this.settings.base, this.settings.handle, this.settings.appDomain);
    const now = Date.now();
    this.settings.shares[folder.path] = { pageId: m.folderId, token, mininotePath: m.folderMirror, options: opts, pageSettings: page, lastSyncedAt: now, updatedAt: now };
    await this.saveSettings();
    this.updateStatus();
    return { ok: m.ok, fail: m.fail, total: m.total, url };
  }

  // pushFolderPrivate mirrors the subtree WITHOUT sharing — a private folder copy (token:""). Keeps an
  // existing share if the folder was already public (so a resync of a shared folder doesn't drop it).
  private async pushFolderPrivate(folder: TFolder, page: PageSettings, onProgress?: (done: number) => void) {
    const existing = this.settings.shares[folder.path];
    const m = await this.mirrorFolderNotes(folder, page, onProgress);
    const now = Date.now();
    this.settings.shares[folder.path] = { pageId: m.folderId, token: existing?.token ?? "", mininotePath: m.folderMirror, options: existing?.options ?? { ...this.settings.defaultOptions }, pageSettings: page, lastSyncedAt: now, updatedAt: now };
    await this.saveSettings();
    this.updateStatus();
    return { ok: m.ok, fail: m.fail, total: m.total };
  }

  // forceResync re-publishes a share on demand (re-upsert body + tags, re-apply share options).
  async forceResync(path: string) {
    const f = this.app.vault.getAbstractFileByPath(path);
    const rec = this.settings.shares[path];
    try {
      // Resync must preserve the note's access: a private mirror re-pushes privately, a share re-shares.
      if (f instanceof TFile && rec) {
        if (rec.token) { await this.doPublish(f, rec.options, rec.pageSettings ?? { ...DEFAULT_PAGE_SETTINGS }); notifyAction("mininote: resynced", this.linkActions(shareUrl(this.settings.base, rec.token, this.settings.handle, this.settings.appDomain))); }
        else { await this.pushPrivate(f); } // pushPrivate notifies
      } else if (f instanceof TFolder && rec) {
        if (rec.token) { const r = await this.publishFolder(f, rec.options, rec.pageSettings ?? { ...DEFAULT_PAGE_SETTINGS }); notifyAction(`mininote: folder resynced (${r.ok}/${r.total})`, this.linkActions(r.url)); }
        else { const r = await this.pushFolderPrivate(f, rec.pageSettings ?? { ...DEFAULT_PAGE_SETTINGS }); notify(`mininote: folder synced (${r.ok}/${r.total})`); }
      } else if (f instanceof TFile) { await this.pushUpdate(f); notify("mininote: resynced"); } // folder-member note
      else { notify("mininote: nothing to resync"); return; }
    } catch (e) {
      if (e instanceof ReauthNeeded) { notifyErr("mininote: " + e.message + " — run Connect"); return; }
      notifyErr("mininote: resync failed — " + errMsg(e));
    }
    this.refreshViews();
  }

  private async unshareFolder(folder: TFolder) {
    const rec = this.settings.shares[folder.path];
    if (!rec) { notify("mininote: this folder isn't shared"); return; }
    try {
      await this.mn.shareRevoke(rec.pageId); // revokes the folder share; the mirrored pages stay
      delete this.settings.shares[folder.path];
      await this.saveSettings();
      this.updateStatus();
      notify("mininote: stopped sharing folder");
    } catch (e) {
      if (e instanceof ReauthNeeded) { notifyErr("mininote: " + e.message + " — run Connect"); return; }
      notifyErr("mininote: couldn't stop sharing — " + errMsg(e));
    }
  }

  // ---- one-way vault sync --------------------------------------------------

  private async onVaultRename(file: TAbstractFile, oldPath: string) {
    const rec = this.settings.shares[oldPath];
    if (!rec || !(file instanceof TFile) || !this.settings.tokens) return;
    // Re-key tracking to the new path regardless (so the plugin keeps following the file).
    delete this.settings.shares[oldPath];
    const newMirrorPath = pagePath(this.settings.mirrorRoot, file.path);
    this.settings.shares[file.path] = { ...rec, mininotePath: newMirrorPath };
    await this.saveSettings();
    this.updateStatus();
    if (!this.settings.syncMoves) return;
    try {
      const parent = parentPath(this.settings.mirrorRoot, file.path);
      const parentId = parent ? (await this.mn.ensureFolder(parent)).id : ""; // "" = mirror/space root
      await this.mn.updatePage(rec.pageId, { parent_id: parentId, title: file.basename });
      if (this.settings.syncNotices) notify("mininote: moved shared note to match vault");
    } catch (e) {
      if (!(e instanceof ReauthNeeded)) notifyErr("mininote: move sync failed — " + errMsg(e));
    }
  }

  private async onVaultCreate(file: TAbstractFile) {
    if (!(file instanceof TFile) || file.extension !== "md") return; // folders: nothing to share yet
    if (!this.settings.syncEdits || !this.settings.tokens) return;
    if (!this.isSyncedPath(file.path)) return; // only auto-add inside an already-shared folder
    await this.pushUpdate(file); // upsert into the folder's shared subtree (+ tags)
  }

  private async onVaultDelete(file: TAbstractFile) {
    const rec = this.settings.shares[file.path];
    if (!rec) return;
    delete this.settings.shares[file.path];
    await this.saveSettings();
    this.updateStatus();
    if (!this.settings.tokens) return;
    try {
      if (rec.token) await this.mn.shareRevoke(rec.pageId); // only shared notes have a share to revoke
      if (this.settings.syncDeletes) await this.mn.deletePage(rec.pageId);
      if (this.settings.syncNotices) notify(rec.token ? "mininote: removed the shared note" : "mininote: removed the mirrored note");
    } catch (e) {
      if (!(e instanceof ReauthNeeded)) notifyErr("mininote: delete sync failed — " + errMsg(e));
    }
  }

  // ---- edit sync (debounced) ----------------------------------------------

  // A shared note (on its own or inside a shared folder) that you edit is debounce-pushed to mininote
  // so the live share stays current. One-way: mininote edits never flow back.
  private onVaultModify(file: TAbstractFile) {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (!this.settings.syncEdits || !this.settings.tokens) return;
    if (!this.isSyncedPath(file.path)) return;
    const prev = this.editTimers.get(file.path);
    if (prev) window.clearTimeout(prev);
    this.editTimers.set(file.path, window.setTimeout(() => { this.editTimers.delete(file.path); void this.pushUpdate(file); }, 2000));
  }

  // isSyncedPath: the note is shared directly, or lives under a shared FOLDER (folder records are
  // keyed by a folder path, which never ends in .md).
  private isSyncedPath(path: string): boolean {
    if (this.settings.shares[path]) return true;
    for (const key of Object.keys(this.settings.shares)) {
      if (!key.endsWith(".md") && (path === key || path.startsWith(key + "/"))) return true;
    }
    return false;
  }

  private async pushUpdate(file: TFile) {
    try {
      const raw = await this.app.vault.read(file);
      const page = await this.mn.upsert(pagePath(this.settings.mirrorRoot, file.path), titleFor(file, raw), this.buildPublishBody(file, raw));
      if (this.settings.syncTags && page?.id) { try { await this.mn.syncTags(page.id, this.tagsFor(file)); } catch { /* tags best-effort */ } }
      const rec = this.settings.shares[file.path];
      if (rec) { const now = Date.now(); rec.lastSyncedAt = now; rec.updatedAt = now; await this.saveSettings(); }
      this.updateStatus(); // reflects the fresh "synced" time (or, for folder members, a brief flash)
      if (!rec) this.flashStatus("mininote: synced");
    } catch { /* quiet: reauth needed / offline — the next edit or a manual re-share recovers */ }
  }

  private flashStatus(text: string) {
    if (!this.statusEl) return;
    this.statusEl.setText(text);
    window.setTimeout(() => this.updateStatus(), 1500);
  }

  // buildPublishBody produces the body we actually publish (the vault file is never touched): strip
  // frontmatter, placeholder local images (we never host bytes), and rewrite Obsidian links to the
  // relative markdown links mininote resolves.
  private buildPublishBody(file: TFile, raw: string): string {
    return this.rewriteLinks(file, rewriteImages(stripFrontmatter(raw)));
  }

  // rewriteLinks turns Obsidian [[wikilinks]] (and leftover non-image ![[embeds]]) into relative .md
  // markdown links mininote resolves. mininote's resolver (lib/links.ts) matches each path segment
  // against slugify(node.title), so we emit SLUGIFIED segments: folder names slugified, and the leaf
  // = slugify(the target's mininote title). Because we mirror the vault structure, the relative path
  // holds in the shared tree. Unresolvable targets become plain text — never a broken [[ ]].
  private rewriteLinks(file: TFile, body: string): string {
    return body.replace(/!?\[\[([^\]]+?)\]\]/g, (_m, inner: string) => {
      const [rawTarget, alias] = String(inner).split("|");
      const label = (alias ?? rawTarget).trim();
      const linkpath = rawTarget.replace(/#.*$/, "").trim(); // drop #heading/#^block for resolution
      const dest = linkpath ? this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path) : null;
      if (!(dest instanceof TFile)) return label; // unresolvable → plain text
      return `[${label}](${this.mininoteRelPath(file, dest)})`;
    });
  }

  // mininoteRelPath builds the relative link between two notes AS mininote addresses them: directory
  // segments slugified (folder titles = their slug), leaf = slugify(target's mininote title) + .md.
  private mininoteRelPath(from: TFile, dest: TFile): string {
    const fromDirs = from.path.split("/").slice(0, -1);
    const destDirs = dest.path.split("/").slice(0, -1);
    let i = 0;
    while (i < fromDirs.length && i < destDirs.length && fromDirs[i] === destDirs[i]) i++;
    const ups = fromDirs.slice(i).map(() => "..");
    const downs = destDirs.slice(i).map(mnSlug);
    const leaf = mnSlug(this.mininoteTitleOf(dest)) + ".md";
    const rel = [...ups, ...downs, leaf].join("/");
    return rel.startsWith(".") ? rel : "./" + rel;
  }

  // mininoteTitleOf mirrors titleFor via the metadata cache (no file read): frontmatter title, else
  // basename — the title we upsert the page with, and therefore what mininote slugifies for links.
  private mininoteTitleOf(file: TFile): string {
    const t: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.title;
    return (typeof t === "string" && t.trim()) ? t.trim() : file.basename;
  }

  // tagsFor extracts a note's tags via Obsidian's metadata cache — inline #tags AND YAML frontmatter
  // `tags` (string or list) — stripped of the leading '#'. Empty when the note has none.
  private tagsFor(file: TFile): string[] {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return [];
    const out = new Set<string>();
    for (const t of cache.tags ?? []) { const n = t.tag.replace(/^#/, "").trim(); if (n) out.add(n); }
    const fm = cache.frontmatter?.tags as unknown;
    if (typeof fm === "string") for (const n of fm.split(/[,\s]+/)) { const s = n.replace(/^#/, "").trim(); if (s) out.add(s); }
    else if (Array.isArray(fm)) for (const n of fm) if (typeof n === "string") { const s = n.replace(/^#/, "").trim(); if (s) out.add(s); }
    return [...out];
  }

  // ---- shares sidebar (SharesHost) -----------------------------------------

  shares() { return this.settings.shares; }
  shareUrlFor(rec: ShareRecord) { return shareUrl(this.settings.base, rec.token, this.settings.handle, this.settings.appDomain); }
  openLink(url: string) { this.openExternal(url); }
  // folderNotes lists the markdown notes inside a shared folder (a folder share publishes the whole
  // subtree under one link) — the vault is the source of truth for what's in it.
  folderNotes(folderPath: string): string[] {
    const f = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(f instanceof TFolder)) return [];
    const out: string[] = [];
    const walk = (dir: TFolder) => {
      for (const child of dir.children) {
        if (child instanceof TFolder) walk(child);
        else if (child instanceof TFile && child.extension === "md") out.push(child.path);
      }
    };
    walk(f);
    return out.sort((a, b) => a.localeCompare(b));
  }

  // folderChildren returns a folder's IMMEDIATE children (subfolders + markdown notes), so the sidebar
  // can render the shared folder as a real tree with nested expanders instead of a flat list.
  folderChildren(folderPath: string): { folders: string[]; notes: string[] } {
    const f = this.app.vault.getAbstractFileByPath(folderPath);
    const folders: string[] = [];
    const notes: string[] = [];
    if (f instanceof TFolder) {
      for (const c of f.children) {
        if (c instanceof TFolder) folders.push(c.path);
        else if (c instanceof TFile && c.extension === "md") notes.push(c.path);
      }
    }
    folders.sort((a, b) => a.localeCompare(b));
    notes.sort((a, b) => a.localeCompare(b));
    return { folders, notes };
  }
  shareActive() {
    const f = this.app.workspace.getActiveFile();
    if (f && f.extension === "md") void this.openShareModal(f);
    else notify("mininote: open a markdown note first");
  }

  openNote(path: string) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) { notify("mininote: that note is no longer in the vault"); return; }
    // Clicking in the sidebar makes IT the active leaf, so getLeaf(false) would open into the sidebar.
    // Target the most recent MAIN-area leaf instead (fall back to a fresh tab).
    const leaf = this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf(true);
    void leaf.openFile(f);
  }

  manageByPath(path: string) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) void this.openShareModal(f);
    else if (f instanceof TFolder) this.shareFolder(f);
    else notify("mininote: that item is no longer in the vault — use its Stop action to clean up");
  }

  async revokeByPath(path: string) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) { await this.unshare(f); return; }
    if (f instanceof TFolder) { await this.unshareFolder(f); return; }
    // Item deleted from the vault but the record lingered — revoke by record so the list can clear it.
    const rec = this.settings.shares[path];
    if (!rec) return;
    try { await this.mn.shareRevoke(rec.pageId); } catch { /* best effort */ }
    delete this.settings.shares[path];
    await this.saveSettings();
    this.updateStatus();
  }

  // removeByPath fully deletes the mininote page (share + copy) for a row. Distinct from revokeByPath,
  // which only stops sharing and keeps the private mirror.
  async removeByPath(path: string) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) { await this.removeFromMininote(f); return; }
    // Folder, or a record whose vault file is gone: revoke + delete the tracked page, clear the row.
    const rec = this.settings.shares[path];
    if (!rec) return;
    try {
      if (rec.token) await this.mn.shareRevoke(rec.pageId);
      await this.mn.deletePage(rec.pageId);
    } catch { /* best effort */ }
    delete this.settings.shares[path];
    await this.saveSettings();
    this.updateStatus();
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(SHARES_VIEW)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: SHARES_VIEW, active: true });
    }
    if (leaf) void workspace.revealLeaf(leaf);
  }

  private refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(SHARES_VIEW)) {
      const v = leaf.view;
      if (v instanceof SharesView) v.render();
    }
  }

  // ---- misc ----------------------------------------------------------------

  private updateStatus() {
    this.refreshViews(); // keep the sidebar list in step with every state change that pokes the status
    const el = this.statusEl;
    if (!el) return;
    el.empty();
    if (!this.isConnected()) {
      el.show();
      el.setText("mininote: connect");
      el.setAttribute("aria-label", "Connect this vault to mininote");
      return;
    }
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") { el.hide(); return; }
    el.show();
    const rec = this.settings.shares[file.path];
    if (rec) {
      const when = rec.lastSyncedAt ? " · synced " + relTime(rec.lastSyncedAt) : "";
      el.setText("mininote: shared" + when);
      el.setAttribute("aria-label", "Shared to mininote — click to manage" + (rec.lastSyncedAt ? ` (last synced ${new Date(rec.lastSyncedAt).toLocaleString()})` : ""));
    } else if (this.isSyncedPath(file.path)) {
      el.setText("mininote: shared"); // shared via a folder — no per-note sync time
      el.setAttribute("aria-label", "Shared to mininote via its folder");
    } else {
      el.setText("mininote: share");
      el.setAttribute("aria-label", "Share this note to mininote");
    }
  }

  private openExternal(url: string) {
    try {
      const req = (window as unknown as { require?: (m: string) => { shell?: { openExternal(u: string): void } } }).require;
      const shell = req?.("electron")?.shell;
      if (shell?.openExternal) { shell.openExternal(url); return; }
    } catch { /* fall through */ }
    window.open(url, "_blank");
  }

  // linkActions builds the standard Copy link / Open buttons for an action toast, so a fresh share
  // link is usable straight from the toast instead of reopening a modal.
  private linkActions(url: string): ToastAction[] {
    return [
      { label: "Copy link", icon: "copy", onClick: () => { void navigator.clipboard.writeText(url).catch(() => {}); notify("mininote: link copied"); } },
      { label: "Open", icon: "external-link", onClick: () => this.openExternal(url) },
    ];
  }

  onunload() { for (const t of this.editTimers.values()) window.clearTimeout(t); this.editTimers.clear(); this.clearPending(); clearToasts(); clearHovers(); }

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<MininoteSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
    // Production builds bake the connection defaults and hide the dev-only Server URL / Client ID
    // fields — so a persisted base/clientId (e.g. localhost, left over from dev-testing in this vault)
    // must NOT override them, or the plugin keeps pointing at the wrong instance with no way to fix it
    // in the UI. Dev builds keep the persisted values so the dev fields still work.
    if (!__MN_DEV__) {
      this.settings.base = __MN_BASE__;
      this.settings.clientId = __MN_CLIENT__;
    }
  }
  async saveSettings() { await this.saveData(this.settings); }
  isConnected() { return !!this.settings.tokens; }
}

// titleFor prefers a YAML frontmatter `title:` then the filename (no extension).
function titleFor(file: TFile, raw: string): string {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    const t = m[1].match(/^title:\s*(.+)$/m);
    if (t) return t[1].trim().replace(/^["']|["']$/g, "");
  }
  return file.basename;
}

const errMsg = (e: unknown): string => (e as { message?: string })?.message ?? "unknown";

// mnSlug mirrors mininote's slugify (frontend lib/links.ts): lowercase, non-alphanumerics → hyphen,
// trim hyphens. Link segments MUST use this so they match slugify(node.title) in the resolver.
const mnSlug = (s: string): string => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

class MininoteSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: MininotePlugin) { super(app, plugin); }

  // Declarative settings (Obsidian 1.13+): the same settings expressed as data so they're searchable
  // and future-proof. display() below still renders for < 1.13. Dotted keys (defaultOptions.allowFork)
  // are resolved by the getControlValue/setControlValue overrides.
  getSettingDefinitions(): SettingDefinitionItem[] {
    const p = this.plugin;
    const defs: SettingDefinitionItem[] = [];

    defs.push({
      name: "Status",
      render: (setting) => {
        setting.setName("Status").setDesc(
          p.isConnected() ? (p.settings.handle ? `Connected as ${p.settings.handle}.` : "Connected to mininote.") : "Not connected.",
        );
        setting.addButton((b) => b.setButtonText(p.isConnected() ? "Reconnect" : "Connect").setCta().onClick(() => void p.connect()));
        if (p.isConnected()) setting.addButton((b) => { b.setButtonText("Disconnect").onClick(() => void p.disconnect()); b.buttonEl.addClass("mod-warning"); });
      },
    });

    if (__MN_DEV__) {
      defs.push({ name: "Server URL", desc: "Your mininote instance. Local dev: http://localhost:5173", control: { type: "text", key: "base" } });
      defs.push({ name: "Client ID", desc: "The OAuth client id registered in mininote (Settings -> apps).", control: { type: "text", key: "clientId" } });
    }

    defs.push({ name: "Mirror folder", desc: "Vault paths are published under this folder in mininote so they don't collide with native pages.", control: { type: "text", key: "mirrorRoot" } });

    defs.push({
      type: "group",
      heading: "One-way sync",
      items: [
        { name: "Sync moves", desc: "Move or rename a shared note -> move its mininote page to match (the link is preserved).", control: { type: "toggle", key: "syncMoves" } },
        { name: "Sync deletes", desc: "Delete a shared note -> revoke its share and delete the mininote page. Off = revoke only.", control: { type: "toggle", key: "syncDeletes" } },
        { name: "Sync edits", desc: "Edit a shared note -> push the change to its live share (debounced).", control: { type: "toggle", key: "syncEdits" } },
        { name: "Sync tags", desc: "Push a note's tags (inline + frontmatter). Additive — dropping a tag in Obsidian doesn't remove it.", control: { type: "toggle", key: "syncTags" } },
        { name: "Show sync notifications", desc: "Toast on each background sync. Off = quiet (status bar + sidebar still update). Errors always notify.", control: { type: "toggle", key: "syncNotices" } },
      ],
    });

    defs.push({
      type: "group",
      heading: "New share defaults",
      items: [
        { name: "Allow forking", desc: "Let visitors copy a page into their own mininote.", control: { type: "toggle", key: "defaultOptions.allowFork" } },
        { name: "Allow raw source", desc: "Expose the markdown source + tree manifest at /raw/.", control: { type: "toggle", key: "defaultOptions.allowRaw" } },
        { name: "Allow downloads", desc: "Let anyone download the note (md, zip, epub).", control: { type: "toggle", key: "defaultOptions.allowExport" } },
        { name: "Allow annotations", desc: "Let logged-in visitors annotate the shared page.", control: { type: "toggle", key: "defaultOptions.allowAnnotations" } },
        { name: "Reading width", desc: "How wide the column renders on mininote.", control: { type: "dropdown", key: "defaultPage.width", options: { "": "Normal", wide: "Wide" } } },
        { name: "Unlisted", desc: "Keep new shares out of smart-folder / automatic exposure. Direct links still work.", control: { type: "toggle", key: "defaultPage.unlisted" } },
      ],
    });

    return defs;
  }

  // Resolve control keys against plugin.settings, incl. dotted keys for the nested default objects,
  // and normalize the path-ish text fields on write.
  getControlValue(key: string): unknown {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    if (key.includes(".")) {
      const [a, b] = key.split(".");
      return (s[a] as Record<string, unknown> | undefined)?.[b];
    }
    return s[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (typeof value === "string") {
      if (key === "mirrorRoot") value = value.trim().replace(/^\/|\/$/g, "");
      else if (key === "base") value = value.trim().replace(/\/$/, "");
      else if (key === "clientId") value = value.trim();
    }
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    if (key.includes(".")) {
      const [a, b] = key.split(".");
      (s[a] as Record<string, unknown>)[b] = value;
    } else {
      s[key] = value;
    }
    await this.plugin.saveSettings();
  }

}
