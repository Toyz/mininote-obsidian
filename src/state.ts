import type { ShareOptions } from "./mn";

// PageSettings are mininote page-config fields the plugin lets the user control per shared note. Stored
// on the record (the plugin is the writer) and re-applied on every publish/resync. Width "" = normal.
export interface PageSettings {
  width: "" | "wide";
  unlisted: boolean;
}

export const DEFAULT_PAGE_SETTINGS: PageSettings = { width: "", unlisted: false };

// Per-vault-file record of what the plugin published, so it can re-share to the same page, revoke it,
// and keep mininote in sync when the vault file is moved or deleted. Keyed by vault path.
export interface ShareRecord {
  pageId: string;
  token: string;
  mininotePath: string; // slash-path the page lives at in mininote (for move detection)
  options: ShareOptions;
  pageSettings?: PageSettings; // page-config the plugin manages (width / unlisted / comments); re-applied on resync
  lastSyncedAt?: number; // epoch ms of the last successful push (publish or edit-sync)
  updatedAt?: number;    // epoch ms of the page's last edit on mininote (from the server, survives across machines)
}

export type ShareMap = Record<string, ShareRecord>;

export const DEFAULT_OPTIONS: ShareOptions = {
  allowFork: false,
  allowRaw: false,
  allowExport: false,
  allowAnnotations: false,
  password: "",
};

// relTime renders an epoch-ms as a short relative label ("just now", "2m ago", …).
export function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  return new Date(ts).toLocaleDateString();
}
