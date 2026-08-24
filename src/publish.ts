import { Mn, EXPORT_FORMATS, type ShareOptions } from "./mn";

// One-way publish: upsert the note at its vault path (mirrored under a root folder so it can't
// collide with native mininote pages), create a public share, and apply the chosen options.
// Idempotent: re-publishing the same path updates the same page and returns the same share token.

export interface PublishInput {
  base: string;
  mirrorRoot: string;
  vaultPath: string; // vault-relative, forward slashes, e.g. "Projects/Foo/note.md"
  title: string;
  body: string;      // ALREADY the published body (frontmatter stripped, images/links rewritten)
  handle: string;    // owner handle (from userInfo) → brands the share URL
  appDomain: string; // apex public homes live under (from userInfo); "" → apex /s/ fallback
}

export interface PublishResult { pageId: string; token: string; url: string }

// mirrorNote copies a note UP to mininote (upsert at its mirror path) WITHOUT sharing it — a private
// one-way copy that lives in the owner's workspace with no public link. Returns the page id.
export async function mirrorNote(mn: Mn, input: PublishInput): Promise<string> {
  const path = pagePath(input.mirrorRoot, input.vaultPath);
  const page = await mn.upsert(path, input.title, input.body);
  if (!page?.id) throw new Error("upsert returned no page id");
  return page.id;
}

// publishNote mirrors the note AND shares it publicly (upsert + create/enforce the share).
export async function publishNote(mn: Mn, input: PublishInput, opts: ShareOptions): Promise<PublishResult> {
  const pageId = await mirrorNote(mn, input);
  const { token, url } = await shareNode(mn, pageId, opts, input.base, input.handle, input.appDomain);
  return { pageId, token, url };
}

// shareNode publishes an EXISTING mininote node (page or folder) and enforces the exact options.
// Sharing a FOLDER node publishes its whole subtree under one link — that's how a folder is shared.
export async function shareNode(mn: Mn, pageId: string, opts: ShareOptions, base: string, handle: string, appDomain: string): Promise<{ token: string; url: string }> {
  const share = await mn.shareCreate(pageId, opts);
  if (!share?.token) throw new Error("publish returned no share token");
  // shareCreate only turns options ON; enforce the exact chosen state so a re-share can also turn one
  // OFF. All are idempotent setters (setPassword "" removes protection).
  await mn.shareSetForkable(pageId, opts.allowFork);
  await mn.shareSetRaw(pageId, opts.allowRaw);
  await mn.shareSetExport(pageId, opts.allowExport ? EXPORT_FORMATS : "");
  await mn.shareSetAnnotations(pageId, opts.allowAnnotations);
  await mn.shareSetPassword(pageId, opts.password);
  return { token: share.token, url: shareUrl(base, share.token, handle, appDomain) };
}

// shareUrl builds a share link, branded on the owner's subdomain (<handle>.<appDomain>) when the
// server has an apex configured — the server's canonical (301) host — else the apex /s/ path. Mirrors
// the web UI's lib/publicUrl. Scheme + port come from `base` so dev and prod both come out right.
export function shareUrl(base: string, token: string, handle = "", appDomain = ""): string {
  const o = subdomainOrigin(base, handle, appDomain);
  return o ? `${o}/s/${token}` : `${base.replace(/\/$/, "")}/s/${token}`;
}

function subdomainOrigin(base: string, handle: string, appDomain: string): string {
  if (!appDomain || !handle) return "";
  const label = handle.toLowerCase().replace(/_/g, "-"); // '_' invalid in a DNS label; server maps '-' back
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return "";
  try {
    const u = new URL(base);
    const port = u.port ? ":" + u.port : "";
    return `${u.protocol}//${label}.${appDomain}${port}`;
  } catch { return ""; }
}

// pagePath turns a vault path into the mininote slash-path: drop the .md extension and prefix the
// mirror root. The last segment becomes the page; earlier segments are auto-created folders.
export function pagePath(mirrorRoot: string, vaultPath: string): string {
  const noExt = vaultPath.replace(/\.md$/i, "");
  const root = mirrorRoot.replace(/^\/|\/$/g, "");
  return (root ? root + "/" : "") + noExt;
}

// parentPath returns the mirror folder that should hold a note (everything above the leaf), or "" for
// the mirror root. Used to move a page when its vault file is moved between folders.
export function parentPath(mirrorRoot: string, vaultPath: string): string {
  const full = pagePath(mirrorRoot, vaultPath);
  const cut = full.lastIndexOf("/");
  return cut < 0 ? "" : full.slice(0, cut);
}

// stripFrontmatter removes a leading YAML block from the PUBLISHED copy only (the vault file is never
// touched). The title was already read from it; leaving it in would render as stray text.
export function stripFrontmatter(body: string): string {
  return body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}
