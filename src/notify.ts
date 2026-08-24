import { setIcon } from "obsidian";

// Self-owned toasts. We deliberately DON'T use Obsidian's `new Notice`: its element (and the theme's
// styling of it) wraps our card in stock chrome we can't reliably strip. Rendering our own element
// into a container we control means zero chrome to fight — the card IS the whole toast.

// The Mini glyph is registered as an Obsidian icon in the plugin's onload (addIcon), so we render it
// with setIcon rather than assigning raw SVG to innerHTML.
const MINI_ICON = "mininote-mini";

let lastMsg = "";
let lastAt = 0;
const THROTTLE_MS = 1500;

// The glyph carries the brand, so drop a redundant leading "mininote:" and capitalize the first letter
// (call sites wrote lowercase continuations of that prefix, which read as fragments once it's gone).
const clean = (msg: string): string => {
  const s = msg.replace(/^mininote:\s*/i, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// The stack container, created lazily on <body> and reused. isConnected guards a stale ref after a
// workspace teardown.
let stack: HTMLElement | null = null;
function stackEl(): HTMLElement {
  if (stack && stack.isConnected) return stack;
  stack = document.body.createDiv({ cls: "mn-toasts" });
  return stack;
}

// A button rendered inside an action toast. `icon` is an optional lucide id (e.g. "copy",
// "external-link"). onClick fires, then the toast dismisses itself.
export interface ToastAction {
  label: string;
  icon?: string;
  onClick: () => void;
}

function render(msg: string, kind: "info" | "err", timeout: number, actions?: ToastAction[]): void {
  const el = stackEl().createDiv({ cls: `mn-toast mn-toast-${kind}` });
  const top = el.createDiv({ cls: "mn-toast-top" });
  setIcon(top.createDiv({ cls: "mn-toast-icon" }), MINI_ICON);
  top.createDiv({ cls: "mn-toast-msg", text: clean(msg) });

  let timer = 0;
  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    window.clearTimeout(timer);
    el.removeClass("mn-toast-in"); // fade/slide out, then detach
    window.setTimeout(() => el.remove(), 180);
  };

  if (actions?.length) {
    const bar = el.createDiv({ cls: "mn-toast-actbar" });
    for (const a of actions) {
      const btn = bar.createEl("button", { cls: "mn-toast-btn" });
      if (a.icon) setIcon(btn.createSpan({ cls: "mn-toast-btn-icon" }), a.icon);
      btn.createSpan({ text: a.label });
      btn.onclick = (e) => { e.stopPropagation(); a.onClick(); dismiss(); };
    }
  } else {
    el.addClass("mn-toast-clickable"); // a plain toast dismisses on click
    el.onclick = dismiss;
  }

  window.requestAnimationFrame(() => el.addClass("mn-toast-in")); // enter transition
  timer = window.setTimeout(dismiss, timeout);
}

export function notify(msg: string, timeout = 4000): void {
  const now = Date.now();
  if (msg === lastMsg && now - lastAt < THROTTLE_MS) return; // swallow the immediate duplicate
  lastMsg = msg;
  lastAt = now;
  render(msg, "info", timeout);
}

// notifyErr is for failures: a longer timeout, and never throttled so an error is always seen.
export function notifyErr(msg: string): void {
  lastMsg = "";
  render(msg, "err", 8000);
}

// notifyAction is a toast that carries inline buttons, so a result (a fresh share link) is actionable
// right there — no reopening a modal. It stays up longer and isn't throttled.
export function notifyAction(msg: string, actions: ToastAction[], timeout = 12000): void {
  lastMsg = "";
  render(msg, "info", timeout, actions);
}

// clearToasts detaches the stack container — called on plugin unload so a reload doesn't orphan it.
export function clearToasts(): void {
  stack?.remove();
  stack = null;
}
