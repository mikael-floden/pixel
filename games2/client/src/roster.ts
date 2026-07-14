import { applyUiZoom } from "./uiscale";

/** A small top-right panel listing who's online, with a live count. */
export class RosterUI {
  private el: HTMLDivElement;

  constructor() {
    injectStyles();
    this.el = document.createElement("div");
    this.el.className = "ml-roster";
    document.body.appendChild(this.el);
    applyUiZoom(this.el); // "Desktop site" must not shrink the HUD
  }

  refresh(players: { name: string; me: boolean }[]) {
    const sorted = [...players].sort((a, b) => a.name.localeCompare(b.name));
    const rows = sorted
      .map((p) => `<div class="ml-roster-row${p.me ? " me" : ""}">${escapeHtml(p.name)}</div>`)
      .join("");
    this.el.innerHTML = `<div class="ml-roster-head">Online · ${players.length}</div>${rows}`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

let injected = false;
function injectStyles() {
  if (injected) return;
  injected = true;
  const css = `
  .ml-roster{position:fixed;top:12px;right:12px;z-index:5;min-width:120px;max-height:320px;overflow:auto;
    padding:8px 10px;border-radius:8px;background:#12121ccc;color:#dfe3f5;
    font-family:system-ui,sans-serif;font-size:13px;pointer-events:none}
  .ml-roster-head{font-weight:600;color:#9fb4ff;margin-bottom:4px;border-bottom:1px solid #ffffff22;padding-bottom:3px}
  .ml-roster-row{padding:1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ml-roster-row.me{color:#ffd678}`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}
