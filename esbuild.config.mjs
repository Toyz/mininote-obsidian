import esbuild from "esbuild";
import process from "node:process";

const production = process.argv[2] === "production";

// Connection defaults baked into the bundle. Dev builds point at the local stack; production ships
// the hosted instance + first-party client id (both public — the client id appears in every
// authorize URL). CI can override either via env without editing this file.
const DEV_BASE = "http://localhost:5173";
const DEV_CLIENT = "oc_0efd7815d40be01fc627c8ca12d4da94"; // local "Obsidian (test)" client
const PROD_BASE = "https://mininote.ink";
const PROD_CLIENT = "oc_bccf080a4700adccf5ad6b19d3669ecb";

const base = process.env.MININOTE_BASE ?? (production ? PROD_BASE : DEV_BASE);
const client = process.env.MININOTE_CLIENT ?? (production ? PROD_CLIENT : DEV_CLIENT);

// Obsidian loads a single CommonJS main.js. Bundle everything except the APIs Obsidian
// provides at runtime (the `obsidian` module + electron + node built-ins).
const external = ["obsidian", "electron", "@codemirror/*", "@lezer/*", "node:*"];

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2020",
  platform: "browser",
  external,
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  logLevel: "info",
  minify: production,
  // __MN_DEV__ is true in dev builds (npm run dev) and false in production (npm run build); the plugin
  // uses it to hide the dev-only Server URL / Client ID fields. __MN_BASE__ / __MN_CLIENT__ bake the
  // connection defaults resolved above straight into the bundle.
  define: {
    __MN_DEV__: JSON.stringify(!production),
    __MN_BASE__: JSON.stringify(base),
    __MN_CLIENT__: JSON.stringify(client),
  },
});

// `once` = a single dev build then exit (no watch) — safe for manual plugin reloads, since there's
// no rebuild window that could leave main.js half-written. Production is always a one-shot.
const once = process.argv.includes("once");
if (production || once) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
  console.log("[mininote] esbuild watching…");
}
