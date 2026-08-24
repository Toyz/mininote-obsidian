// Image handling for the PUBLISHED copy. Core rule: mininote never hosts image bytes. Only remote
// http(s) image URLs pass through (they hotlink, and mininote's own external-image gate handles them
// on the reader side). Everything local — Obsidian `![[embed.png]]` wikilinks, relative `![](img.png)`
// paths, and even `data:` URIs (which would bake bytes into the page body) — becomes an honest
// placeholder. The vault file is NEVER modified; only the copy we publish is transformed.

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|apng|ico)$/i;

export interface ImageScan { local: string[]; remote: string[] }

// isRemote: only true web URLs count. data:/app:/relative/absolute-vault paths are all "local" —
// none of them are a hotlink we can safely pass through without hosting bytes.
const isRemote = (u: string): boolean => /^(https?:)?\/\//i.test(u.trim());
const basename = (p: string): string => p.split(/[\\/]/).pop() || p;
const imgPlaceholder = (name: string): string => `*[image: ${name || "image"} — not published]*`;

// scanImages classifies every image embed without changing anything (for the share preflight count).
export function scanImages(body: string): ImageScan {
  const local: string[] = [];
  const remote: string[] = [];
  for (const m of body.matchAll(/!\[\[([^\]]+?)\]\]/g)) {
    const target = m[1].split("|")[0].trim(); // strip |alt / |size
    if (IMG_EXT.test(target)) local.push(basename(target)); // wikilink embeds are always vault-local
  }
  for (const m of body.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    const url = m[2].trim().split(/\s+/)[0]; // drop optional "title"
    if (isRemote(url)) remote.push(url);
    else local.push(url.startsWith("data:") ? "embedded image" : basename(url) || url);
  }
  return { local, remote };
}

// rewriteImages returns the body with LOCAL image embeds swapped for a placeholder and remote images
// kept as-is. Wikilink embeds that aren't images (note transclusions) are left untouched.
export function rewriteImages(body: string): string {
  let out = body.replace(/!\[\[([^\]]+?)\]\]/g, (m, inner: string) => {
    const target = inner.split("|")[0].trim();
    return IMG_EXT.test(target) ? imgPlaceholder(basename(target)) : m;
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt: string, url: string) => {
    const u = url.trim().split(/\s+/)[0];
    if (isRemote(u)) return m;
    return imgPlaceholder(alt.trim() || (u.startsWith("data:") ? "embedded image" : basename(u)));
  });
  return out;
}
