import { App, Modal, Setting, setIcon } from "obsidian";
import { notify, notifyErr } from "./notify";
import type { ShareOptions } from "./mn";
import type { PublishResult } from "./publish";
import type { ShareRecord, PageSettings } from "./state";

export interface ShareModalCtx {
  fileName: string;
  mininotePath: string;
  warn: string | null; // preflight notice (e.g. local images won't publish)
  existing: ShareRecord | null;
  existingUrl: string | null;
  initial: ShareOptions;
  initialPage: PageSettings;
  publish: (opts: ShareOptions, page: PageSettings) => Promise<PublishResult>;
  unshare: () => Promise<void>;
  openUrl: (url: string) => void;
}

// ShareModal is a native Obsidian Modal (renders inside the user's theme) that collects share options
// and drives publish / update / stop-sharing. Uses Obsidian's own Setting rows + Toggle/Text so it
// matches the rest of the app; styles.css only adds a little layout.
export class ShareModal extends Modal {
  private opts: ShareOptions;
  private page: PageSettings;
  private busy = false;

  constructor(app: App, private ctx: ShareModalCtx) {
    super(app);
    this.opts = { ...ctx.initial };
    this.page = { ...ctx.initialPage };
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    contentEl.empty();
    contentEl.addClass("mn-share-modal");
    titleEl.setText(this.ctx.existing ? "Update mininote share" : "Share to mininote");

    const name = this.ctx.fileName.replace(/\.md$/i, "").split("/").pop() || this.ctx.fileName;
    const head = contentEl.createDiv({ cls: "mn-head" });
    head.createDiv({ cls: "mn-head-title", text: name });
    const dest = head.createDiv({ cls: "mn-head-dest mn-muted" });
    dest.appendText("Publishes to ");
    dest.createEl("code", { text: this.ctx.mininotePath });

    if (this.ctx.warn) {
      const w = contentEl.createDiv({ cls: "mn-warn" });
      setIcon(w.createSpan({ cls: "mn-warn-icon" }), "image-off");
      w.createSpan({ text: this.ctx.warn });
    }

    if (this.ctx.existing && this.ctx.existingUrl) {
      const cur = contentEl.createDiv({ cls: "mn-current" });
      cur.createSpan({ cls: "mn-muted mn-current-label", text: "Currently shared" });
      this.linkCard(cur, this.ctx.existingUrl);
    }

    this.renderOptions(contentEl);
    this.renderButtons(contentEl);
  }

  private renderOptions(root: HTMLElement) {
    renderShareOptions(modalSection(root, "Sharing", "Who can do what with the public link."), this.opts);
    renderPageSettings(modalSection(root, "Page", "How the page reads on mininote."), this.page);
  }

  private renderButtons(root: HTMLElement) {
    const bar = new Setting(root);
    bar.settingEl.addClass("mn-buttons");

    if (this.ctx.existing) {
      bar.addButton((b) => b.setButtonText("Stop sharing").setDestructive().onClick(async () => {
        if (this.busy) return;
        this.setBusy(true);
        try { await this.ctx.unshare(); notify("mininote: stopped sharing"); this.close(); }
        catch (e) { notifyErr("mininote: " + msg(e)); this.setBusy(false); }
      }));
    }

    bar.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
    bar.addButton((b) => b.setButtonText(this.ctx.existing ? "Update share" : "Publish").setCta().onClick(async () => {
      if (this.busy) return;
      this.setBusy(true);
      try {
        const res = await this.ctx.publish(this.opts, this.page);
        this.showResult(res);
      } catch (e) { notifyErr("mininote: " + msg(e)); this.setBusy(false); }
    }));
  }

  private showResult(res: PublishResult) {
    const { contentEl, titleEl } = this;
    this.setBusy(false); // clear the publish-time busy lock, else pointer-events:none kills these buttons
    contentEl.empty();
    titleEl.setText("");

    const hero = contentEl.createDiv({ cls: "mn-hero" });
    const check = hero.createDiv({ cls: "mn-check" });
    setIcon(check, "check");
    const heroText = hero.createDiv({ cls: "mn-hero-text" });
    heroText.createEl("div", { cls: "mn-hero-title", text: "Published" });
    heroText.createEl("div", { cls: "mn-hero-sub mn-muted", text: "Your note is live. Share the link." });

    this.linkCard(contentEl, res.url); // prominent link card with inline copy

    const bar = new Setting(contentEl);
    bar.settingEl.addClass("mn-buttons");
    bar.addButton((b) => b.setButtonText("Open").onClick(() => this.ctx.openUrl(res.url)));
    bar.addButton((b) => b.setButtonText("Done").setCta().onClick(() => this.close()));
  }

  private linkCard(parent: HTMLElement, url: string): HTMLElement {
    return renderLinkCard(parent, url, this.ctx.openUrl);
  }

  private setBusy(v: boolean) {
    this.busy = v;
    this.contentEl.toggleClass("mn-busy", v);
  }

  onClose() { this.contentEl.empty(); }
}

const msg = (e: unknown): string => (e as { message?: string })?.message ?? "failed";

// renderLinkCard draws a URL row with click-to-open + an inline copy button (icon flips to a check).
// Shared by the note-result and folder-result screens.
export function renderLinkCard(parent: HTMLElement, url: string, openUrl: (u: string) => void): HTMLElement {
  const card = parent.createDiv({ cls: "mn-linkcard" });
  const link = card.createEl("a", { cls: "mn-linkcard-url", text: url, href: url });
  link.onclick = (e) => { e.preventDefault(); openUrl(url); };
  const copyBtn = card.createEl("button", { cls: "mn-icon-btn", attr: { "aria-label": "Copy link" } });
  setIcon(copyBtn, "copy");
  copyBtn.onclick = async () => {
    await navigator.clipboard.writeText(url).catch(() => {});
    setIcon(copyBtn, "check");
    notify("mininote: link copied");
    window.setTimeout(() => setIcon(copyBtn, "copy"), 1200);
  };
  return card;
}

// modalSection creates a titled card block (heading + subtitle + a rounded container of rows), so the
// share modal reads as clean grouped sections instead of one flat list. Returns the inner container.
export function modalSection(root: HTMLElement, title: string, desc?: string): HTMLElement {
  const head = root.createDiv({ cls: "mn-section-head" });
  head.createDiv({ cls: "mn-section-title", text: title });
  if (desc) head.createDiv({ cls: "mn-section-desc mn-muted", text: desc });
  return root.createDiv({ cls: "mn-card" });
}

// renderShareOptions draws the share-option rows (fork / raw / downloads / annotations / password),
// mutating the passed opts object. Shared by the per-note + per-folder modals AND the settings-tab
// defaults editor. onChange (optional) fires after each edit so a caller can persist immediately.
export function renderShareOptions(root: HTMLElement, opts: ShareOptions, onChange?: () => void): void {
  const changed = () => onChange?.();
  new Setting(root).setName("Allow forking").setDesc("Let visitors copy this page into their own mininote.")
    .addToggle((t) => t.setValue(opts.allowFork).onChange((v) => { opts.allowFork = v; changed(); }));
  new Setting(root).setName("Allow raw source").setDesc("Expose the markdown source + tree manifest at /raw/.")
    .addToggle((t) => t.setValue(opts.allowRaw).onChange((v) => { opts.allowRaw = v; changed(); }));
  new Setting(root).setName("Allow downloads").setDesc("Let anyone download the note (md, zip, epub). Off = only you can export it.")
    .addToggle((t) => t.setValue(opts.allowExport).onChange((v) => { opts.allowExport = v; changed(); }));
  new Setting(root).setName("Allow annotations").setDesc("Let logged-in visitors annotate the shared page.")
    .addToggle((t) => t.setValue(opts.allowAnnotations).onChange((v) => { opts.allowAnnotations = v; changed(); }));
  let pwField: HTMLElement | null = null;
  new Setting(root).setName("Password protect").setDesc("Require a password to view the share.")
    .addToggle((t) => t.setValue(!!opts.password).onChange((v) => { if (!v) opts.password = ""; if (pwField) pwField.style.display = v ? "" : "none"; changed(); }));
  const pwRow = new Setting(root).setName("Password")
    .addText((tx) => { tx.setPlaceholder("password").setValue(opts.password); tx.inputEl.type = "password"; tx.onChange((v) => { opts.password = v; changed(); }); });
  pwField = pwRow.settingEl;
  pwField.style.display = opts.password ? "" : "none";
}

// renderPageSettings draws the mininote page-config controls the plugin manages: reading width (as two
// clickable mock thumbnails — a cheap hint of the column, no live render) + unlisted / comments toggles.
export function renderPageSettings(root: HTMLElement, page: PageSettings, onChange?: () => void): void {
  const changed = () => onChange?.();
  new Setting(root).setName("Reading width").setDesc("How wide the column renders on mininote.");
  const widths = root.createDiv({ cls: "mn-ps-widths" });
  const draw = () => {
    widths.empty();
    const card = (val: "" | "wide", label: string, sub: string) => {
      const c = widths.createDiv({ cls: "mn-ps-width" + (page.width === val ? " is-sel" : "") });
      const mock = c.createDiv({ cls: "mn-ps-mock" });
      const col = mock.createDiv({ cls: "mn-ps-col mn-ps-col-" + (val || "normal") });
      for (let i = 0; i < 4; i++) col.createDiv({ cls: "mn-ps-line" }); // stacked "text" lines read as a column
      c.createDiv({ cls: "mn-ps-wlabel", text: label });
      c.createDiv({ cls: "mn-ps-wsub mn-muted", text: sub });
      c.onclick = () => { page.width = val; draw(); changed(); };
    };
    card("", "Normal", "Focused reading column");
    card("wide", "Wide", "Full-bleed, for tables & wide media");
  };
  draw();

  new Setting(root).setName("Unlisted").setDesc("Keep out of smart-folder / automatic exposure. Direct links still work.")
    .addToggle((t) => t.setValue(page.unlisted).onChange((v) => { page.unlisted = v; changed(); }));
}
