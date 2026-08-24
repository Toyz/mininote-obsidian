import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import { notify, notifyErr } from "./notify";
import type { ShareOptions } from "./mn";
import type { PageSettings } from "./state";
import { renderShareOptions, renderPageSettings, renderLinkCard, modalSection } from "./share-modal";

export interface FolderPublishResult { ok: number; fail: number; total: number; url: string }

export interface FolderShareCtx {
  folderPath: string;
  count: number;
  existingUrl: string | null;
  initial: ShareOptions;
  initialPage: PageSettings;
  publishAll: (opts: ShareOptions, page: PageSettings, onProgress: (done: number) => void) => Promise<FolderPublishResult>;
  unshare: () => Promise<void>;
  openUrl: (url: string) => void;
}

// FolderShareModal mirrors every note under a folder into mininote, then shares the FOLDER node
// itself — one public link for the whole subtree (not N separate note shares).
export class FolderShareModal extends Modal {
  private opts: ShareOptions;
  private page: PageSettings;
  private busy = false;

  constructor(app: App, private ctx: FolderShareCtx) { super(app); this.opts = { ...ctx.initial }; this.page = { ...ctx.initialPage }; }

  onOpen() {
    const { contentEl, titleEl } = this;
    contentEl.empty();
    contentEl.addClass("mn-share-modal");
    titleEl.setText(this.ctx.existingUrl ? "Update folder share" : "Share folder to mininote");

    const head = contentEl.createDiv({ cls: "mn-head" });
    head.createDiv({ cls: "mn-head-title", text: this.ctx.folderPath || "vault root" });
    head.createDiv({ cls: "mn-head-dest mn-muted", text: `${this.ctx.count} note${this.ctx.count === 1 ? "" : "s"} → one public folder link. Your vault stays the source of truth.` });
    head.createDiv({ cls: "mn-head-dest mn-muted", text: "Local images aren't published (only remote image URLs); links between these notes are kept." });

    if (this.ctx.existingUrl) {
      const cur = contentEl.createDiv({ cls: "mn-current" });
      cur.createSpan({ cls: "mn-muted mn-current-label", text: "Currently shared" });
      renderLinkCard(cur, this.ctx.existingUrl, this.ctx.openUrl);
    }

    renderShareOptions(modalSection(contentEl, "Sharing", "Who can do what with the public link."), this.opts);
    renderPageSettings(modalSection(contentEl, "Page", "Applies to every note in the folder."), this.page);

    const bar = new Setting(contentEl);
    bar.settingEl.addClass("mn-buttons");
    if (this.ctx.existingUrl) {
      bar.addButton((b) => b.setButtonText("Stop sharing").setDestructive().onClick(async () => {
        if (this.busy) return;
        this.busy = true;
        try { await this.ctx.unshare(); notify("mininote: stopped sharing folder"); this.close(); }
        catch (e) { this.busy = false; notifyErr("mininote: " + ((e as { message?: string })?.message ?? "failed")); }
      }));
    }
    bar.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
    bar.addButton((b) => b.setButtonText(this.ctx.existingUrl ? `Update ${this.ctx.count}` : `Publish ${this.ctx.count}`).setCta().onClick(async () => {
      if (this.busy || this.ctx.count === 0) return;
      this.busy = true;
      contentEl.addClass("mn-busy");
      const note = new Notice(`mininote: publishing 0/${this.ctx.count}…`, 0);
      try {
        const res = await this.ctx.publishAll(this.opts, this.page, (done) => note.setMessage(`mininote: publishing ${done}/${this.ctx.count}…`));
        note.hide();
        this.showResult(res);
      } catch (e) {
        note.hide();
        contentEl.removeClass("mn-busy");
        this.busy = false;
        notifyErr("mininote: " + ((e as { message?: string })?.message ?? "failed"));
      }
    }));
  }

  private showResult(res: FolderPublishResult) {
    const { contentEl, titleEl } = this;
    contentEl.removeClass("mn-busy");
    contentEl.empty();
    titleEl.setText("Folder published");

    const hero = contentEl.createDiv({ cls: "mn-hero" });
    const check = hero.createDiv({ cls: "mn-check" });
    setIcon(check, "check");
    const t = hero.createDiv({ cls: "mn-hero-text" });
    t.createDiv({ cls: "mn-hero-title", text: `${res.ok}/${res.total} notes` });
    t.createDiv({ cls: "mn-hero-sub mn-muted", text: res.fail ? `${res.fail} failed — the rest are live.` : "All live under one folder link." });

    renderLinkCard(contentEl, res.url, this.ctx.openUrl);

    const bar = new Setting(contentEl);
    bar.settingEl.addClass("mn-buttons");
    bar.addButton((b) => b.setButtonText("Open").onClick(() => this.ctx.openUrl(res.url)));
    bar.addButton((b) => b.setButtonText("Done").setCta().onClick(() => this.close()));
  }

  onClose() { this.contentEl.empty(); }
}
