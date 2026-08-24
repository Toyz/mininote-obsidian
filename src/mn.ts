import { Api } from "./api";

// Typed wrapper over the mininote RPC surface the plugin touches: pages (upsert/update/delete) and
// shares (create + the individual toggles). Wire method names are lowercase-first.

export interface Page { id: string; slug?: string; title?: string; path?: string; parent_id?: string | null; kind?: string }

// SharedListing is one row from Share.mine — the caller's shared pages (used to rebuild the local
// share map after a fresh connect on a machine the plugin has no record on). `path` is the node's
// derived slash-address, resolved server-side so the whole list comes back in one call.
export interface SharedListing { page_id: string; token: string; allow_fork?: boolean; title?: string; kind?: string; path?: string; updated_at?: string }
export interface ShareState {
  shared?: boolean;
  token?: string;
  allow_fork?: boolean;
  allow_raw?: boolean;
  allow_annotations?: boolean;
  protected?: boolean;
}
export interface ShareOptions {
  allowFork: boolean;
  allowRaw: boolean;         // raw markdown source + tree manifest (/raw/)
  allowExport: boolean;      // public downloads (md/zip/epub) — maps to export_formats
  allowAnnotations: boolean;
  password: string;          // "" = no password
}

// EXPORT_FORMATS is the full set offered when downloads are enabled (server validates the subset).
export const EXPORT_FORMATS = "md,zip,epub";

export interface UserInfo { subject: string; handle: string; app_domain?: string }

export class Mn {
  constructor(private api: Api) {}

  // userInfo returns the caller's minimal profile (handle + subject) + the app domain, so the client
  // can build BRANDED share URLs (<handle>.<app_domain>/s/<token>). Needs the `identity` scope.
  userInfo() { return this.api.rpc<UserInfo>("OAuth", "userInfo", {}); }

  upsert(path: string, title: string, body: string) {
    return this.api.rpc<Page>("Page", "upsert", { path, title, body });
  }
  // sharesMine lists the caller's shared pages (page_id + token + kind + derived path) in one call,
  // for rebuilding the local map after a fresh connect.
  sharesMine() { return this.api.rpc<{ shares?: SharedListing[] }>("Share", "mine", {}); }
  // sharesFromPath is Mine scoped to a folder: pass the mirror root (server normalizes the casing) and
  // get back only the shares under it, each path RELATIVE to that root — one call, no client filtering.
  sharesFromPath(path: string) { return this.api.rpc<{ shares?: SharedListing[] }>("Share", "fromPath", { path }); }
  // ensureFolder upserts a folder node at a slash-path (trailing slash => the leaf is a folder).
  ensureFolder(path: string) {
    return this.api.rpc<Page>("Page", "upsert", { path: path.replace(/\/*$/, "/") });
  }
  updatePage(id: string, patch: { title?: string; parent_id?: string | null }) {
    return this.api.rpc<Page>("Page", "update", { id, ...patch });
  }
  // applyPageConfig sets the page-config fields the plugin manages (width / unlisted / comments).
  // Page.update REPLACES config wholesale, so we read-modify-write: fetch the current config and set
  // only our keys, leaving everything else (dashboard, board, SEO, …) intact.
  async applyPageConfig(id: string, s: { width: "" | "wide"; unlisted: boolean }): Promise<void> {
    const page = await this.api.rpc<{ config?: Record<string, unknown> }>("Page", "get", { id });
    const cfg: Record<string, unknown> = { ...(page.config ?? {}) };
    if (s.width) cfg.width = s.width; else delete cfg.width;
    if (s.unlisted) cfg.unlisted = true; else delete cfg.unlisted;
    await this.api.rpc("Page", "update", { id, config: cfg });
  }
  deletePage(id: string) {
    return this.api.rpc("Page", "delete", { id });
  }

  shareCreate(pageId: string, o: ShareOptions) {
    return this.api.rpc<ShareState>("Share", "create", {
      page_id: pageId,
      allow_fork: o.allowFork,
      allow_raw: o.allowRaw,
      allow_annotations: o.allowAnnotations,
      password: o.password,
    });
  }
  shareSetForkable(pageId: string, allow: boolean) { return this.api.rpc<ShareState>("Share", "setForkable", { page_id: pageId, allow }); }
  shareSetRaw(pageId: string, allow: boolean) { return this.api.rpc<ShareState>("Share", "setRaw", { page_id: pageId, allow }); }
  shareSetExport(pageId: string, formats: string) { return this.api.rpc<ShareState>("Share", "setExport", { page_id: pageId, formats }); }
  shareSetAnnotations(pageId: string, allow: boolean) { return this.api.rpc<ShareState>("Share", "setAnnotations", { page_id: pageId, allow }); }
  shareSetPassword(pageId: string, password: string) { return this.api.rpc<ShareState>("Share", "setPassword", { page_id: pageId, password }); }
  shareStatus(pageId: string) { return this.api.rpc<ShareState>("Share", "status", { page_id: pageId }); }
  shareRevoke(pageId: string) { return this.api.rpc("Share", "revoke", { page_id: pageId }); }

  // ---- tags ----------------------------------------------------------------
  tagCatalog() { return this.api.rpc<{ tags?: Tag[]; ops?: TagOp[] }>("Tag", "list", {}); }
  tagCreate(name: string) { return this.api.rpc<Tag>("Tag", "create", { name }); }
  tagSetNodeTags(nodeId: string, tagIds: string[], op: "add" | "remove") {
    return this.api.rpc("Tag", "setNodeTags", { node_id: nodeId, tag_ids: tagIds, op });
  }

  // syncTags makes the mininote node's OWN tags match the note's tags exactly: it adds new ones
  // (creating the tag in the space vocabulary if missing) and removes ones the note dropped. It only
  // touches tags explicitly set ON this node — inherited/cascaded folder tags are left alone.
  async syncTags(pageId: string, names: string[]): Promise<void> {
    const cat = await this.tagCatalog();
    const byName = new Map<string, string>();
    for (const t of cat.tags ?? []) byName.set(t.name.toLowerCase(), t.id);
    // The node's own explicit "add" ops = the tags we manage for it.
    const current = new Set((cat.ops ?? []).filter((o) => o.node_id === pageId && o.op === "add").map((o) => o.tag_id));

    const wanted = new Set<string>();
    for (const name of new Set(names.map((n) => n.trim()).filter(Boolean))) {
      let id = byName.get(name.toLowerCase());
      if (!id) { id = (await this.tagCreate(name)).id; byName.set(name.toLowerCase(), id); }
      wanted.add(id);
    }
    const toAdd = [...wanted].filter((id) => !current.has(id));
    const toRemove = [...current].filter((id) => !wanted.has(id));
    if (toAdd.length) await this.tagSetNodeTags(pageId, toAdd, "add");
    if (toRemove.length) await this.tagSetNodeTags(pageId, toRemove, "remove");
  }
}

export interface Tag { id: string; name: string; color?: string }
export interface TagOp { node_id: string; tag_id: string; op: string }
