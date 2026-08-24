// A lightweight RICH hover-card. Obsidian's setTooltip is plain-text only, so this covers previews
// that want structure — a title, mono URL, badges. Attach to a trigger element with a builder that
// fills the card; it shows after a short delay, follows the trigger, and stays open while the pointer
// is over EITHER the trigger or the card (so the content is reachable/selectable).

export interface HoverHandle {
  destroy(): void;
}

let host: HTMLElement | null = null;
function hostEl(): HTMLElement {
  if (host && host.isConnected) return host;
  host = document.body.createDiv({ cls: "mn-hovers" });
  return host;
}

// clearHovers detaches the container (plugin unload).
export function clearHovers(): void {
  host?.remove();
  host = null;
}

export function attachHoverCard(trigger: HTMLElement, build: (card: HTMLElement) => void, opts?: { delay?: number }): HoverHandle {
  const delay = opts?.delay ?? 350;
  let card: HTMLElement | null = null;
  let showTimer = 0;
  let hideTimer = 0;

  const place = (el: HTMLElement) => {
    const r = trigger.getBoundingClientRect();
    const gap = 11; // room for the pointer arrow to bridge card → row
    el.style.visibility = "hidden";
    el.style.left = "0px";
    el.style.top = "0px";
    el.addClass("mn-hover-in"); // measure at full size
    const cw = el.offsetWidth;
    const ch = el.offsetHeight;
    el.removeClass("mn-hover-in");
    // Sidebar sits at the right edge — prefer opening to the LEFT; flip right only if there's no room.
    el.removeClass("mn-hover-left");
    el.removeClass("mn-hover-right");
    let left = r.left - gap - cw;
    let side: "left" | "right" = "left";
    if (left < gap) { side = "right"; left = Math.min(r.right + gap, window.innerWidth - cw - gap); }
    el.addClass(side === "left" ? "mn-hover-left" : "mn-hover-right");
    // Vertically center the card on the row, clamped into the viewport; the arrow then points at the
    // row's middle wherever the card lands.
    let top = r.top + r.height / 2 - ch / 2;
    top = Math.max(gap, Math.min(top, window.innerHeight - ch - gap));
    const arrowY = Math.max(14, Math.min(r.top + r.height / 2 - top, ch - 14));
    el.style.setProperty("--mn-arrow", `${arrowY}px`);
    el.style.left = `${Math.max(gap, left)}px`;
    el.style.top = `${top}px`;
    el.style.visibility = "";
  };

  // Any mousedown outside the card dismisses it — a right-click (opening the row's context menu) or a
  // click elsewhere gives no mouseleave on the trigger, so the card would otherwise stay stuck open.
  const onDocDown = (e: MouseEvent) => {
    if (card && !card.contains(e.target as Node)) close();
  };
  const open = () => {
    if (card) return;
    card = hostEl().createDiv({ cls: "mn-hover" });
    build(card);
    place(card);
    card.addEventListener("mouseenter", () => window.clearTimeout(hideTimer));
    card.addEventListener("mouseleave", scheduleHide);
    document.addEventListener("mousedown", onDocDown, true);
    requestAnimationFrame(() => card?.addClass("mn-hover-in"));
  };
  const close = () => {
    if (!card) return;
    document.removeEventListener("mousedown", onDocDown, true);
    const c = card;
    card = null;
    c.removeClass("mn-hover-in");
    window.setTimeout(() => c.remove(), 140);
  };
  const scheduleHide = () => {
    window.clearTimeout(showTimer);
    hideTimer = window.setTimeout(close, 120);
  };
  const scheduleShow = () => {
    window.clearTimeout(hideTimer);
    showTimer = window.setTimeout(open, delay);
  };

  const cancelShow = () => window.clearTimeout(showTimer); // a click/right-click mid-delay shouldn't pop a card
  trigger.addEventListener("mouseenter", scheduleShow);
  trigger.addEventListener("mouseleave", scheduleHide);
  trigger.addEventListener("mousedown", cancelShow);
  return {
    destroy() {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      trigger.removeEventListener("mouseenter", scheduleShow);
      trigger.removeEventListener("mouseleave", scheduleHide);
      trigger.removeEventListener("mousedown", cancelShow);
      document.removeEventListener("mousedown", onDocDown, true);
      close();
    },
  };
}
