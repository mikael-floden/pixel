import { MAX_CHAT_LEN } from "@nangijala/shared";
import { applyUiZoom } from "./uiscale";

/** How long a log line stays before fading out. */
const CHAT_LINE_TTL_MS = 20_000;

/**
 * Minimal DOM chat: a bottom-left message log + an input box that opens on Enter.
 * Movement is gated by `open` in the world scene while typing.
 */
export class ChatUI {
  open = false;
  private input: HTMLInputElement;
  private log: HTMLDivElement;

  constructor(
    private onSend: (text: string) => void,
    private onClose: () => void,
  ) {
    injectStyles();
    this.log = document.createElement("div");
    this.log.className = "ml-chatlog";
    this.input = document.createElement("input");
    this.input.className = "ml-chatinput";
    this.input.maxLength = MAX_CHAT_LEN;
    this.input.placeholder = "say something…";
    this.input.style.display = "none";
    document.body.append(this.log, this.input);
    applyUiZoom(this.log); // "Desktop site" must not shrink the HUD
    applyUiZoom(this.input);

    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const text = this.input.value.trim();
        if (text) this.onSend(text);
        this.close();
      } else if (e.key === "Escape") {
        this.close();
      }
    });
  }

  openInput() {
    if (this.open) return;
    this.open = true;
    this.input.value = "";
    this.input.style.display = "block";
    this.input.focus();
  }

  private close() {
    this.open = false;
    this.input.value = "";
    this.input.style.display = "none";
    this.input.blur();
    this.onClose();
  }

  addLog(name: string, text: string) {
    const line = document.createElement("div");
    line.className = "ml-chatline";
    const who = document.createElement("span");
    who.className = "ml-chatwho";
    who.textContent = `${name}: `;
    line.append(who, document.createTextNode(text));
    this.log.appendChild(line);
    while (this.log.childElementCount > 8) this.log.removeChild(this.log.firstChild!);
    // chat/event lines are transient (maintainer): fade after 20s, then drop.
    window.setTimeout(() => {
      line.classList.add("ml-chatfade");
      line.addEventListener("transitionend", () => line.remove(), { once: true });
      // transitions don't run in backgrounded tabs — make sure it still leaves
      window.setTimeout(() => line.remove(), 3000);
    }, CHAT_LINE_TTL_MS);
  }
}

let injected = false;
function injectStyles() {
  if (injected) return;
  injected = true;
  const css = `
  /* px (not vw) sizes: these roots may carry a compensating CSS zoom
     (uiscale.ts) and viewport units would double-count under it. The bottom
     anchors sit ABOVE the HUD dock (--hud-h; slight double-count under a
     desktop-site zoom is acceptable) — the dock is real UI now. */
  .ml-chatlog{position:fixed;left:96px;bottom:calc(var(--hud-h, 0px) / var(--ml-uizoom, 1) + 46px);z-index:5;max-width:620px;
    font-family:system-ui,sans-serif;font-size:26px;color:#e8e8f0;text-shadow:0 1px 2px #000;pointer-events:none}
  .ml-chatline{margin:2px 0;line-height:1.3;transition:opacity 1.6s ease}
  .ml-chatline.ml-chatfade{opacity:0}
  .ml-chatwho{color:#ffd678;font-weight:600}
  .ml-chatinput{position:fixed;left:96px;bottom:calc(var(--hud-h, 0px) / var(--ml-uizoom, 1) + 12px);z-index:6;width:520px;
    padding:9px 12px;border-radius:8px;border:1px solid #2c2c31;background:#0a0a0cee;color:#fff;font-size:15px}`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}
