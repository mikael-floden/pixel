import { MAX_CHAT_LEN } from "@nangijala/shared";

/** How long a log line stays before fading out. */
const CHAT_LINE_TTL_MS = 20_000;

/**
 * Minimal DOM chat: a bottom-left message log + an input box that opens on
 * Enter. Movement is gated by `open` in the world scene while typing.
 *
 * WIKI-STYLE (maintainer 2026-07-30): lines render as translucent theme
 * chips (the shared tokens from theme.ts) so they read over any world art in
 * both light and dark mode; the input is a plain wiki input. No zoom
 * compensation — plain responsive CSS, like the wiki.
 */
export class ChatUI {
  open = false;
  /** Mirror of EVERY log line (system events AND player chat — the same stream
   * shown in the bottom-left log) to the persistent Chat page (hud.ts keeps the
   * last 1000). Set by WorldScene once the HUD exists; null before then. */
  onLog: ((name: string, text: string) => void) | null = null;
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
    // Mirror to the Chat page's history BEFORE the transient line so the two
    // stay in the same order even if a listener throws.
    this.onLog?.(name, text);
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
  /* Bottom-left, floating just above the HUD (--hud-h is real px, set by
     hud.ts applyLayout). Lines are translucent theme chips so they stay
     readable over any world art in either theme. */
  .ml-chatlog{position:fixed;left:10px;bottom:calc(var(--hud-h, 38.2dvh) + 40px);z-index:5;
    max-width:min(78vw,460px);display:flex;flex-direction:column;align-items:flex-start;gap:3px;
    font:13px/1.4 var(--sans);color:var(--ink);pointer-events:none}
  .ml-chatline{padding:3px 9px;border-radius:9px;max-width:100%;overflow-wrap:anywhere;
    background:color-mix(in srgb, var(--bg) 78%, transparent);
    border:1px solid color-mix(in srgb, var(--border) 55%, transparent);
    backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);
    transition:opacity 1.6s ease}
  .ml-chatline.ml-chatfade{opacity:0}
  .ml-chatwho{color:var(--accent-ink);font-weight:600}
  .ml-chatinput{position:fixed;left:10px;bottom:calc(var(--hud-h, 38.2dvh) + 10px);z-index:6;
    width:min(78vw,380px);background:var(--surface);color:var(--ink);
    border:1px solid var(--border);border-radius:10px;padding:8px 11px;
    font:14px/1.3 var(--sans);outline:none;box-shadow:var(--shadow)}
  .ml-chatinput:focus{border-color:var(--accent)}
  .ml-chatinput::placeholder{color:var(--muted)}`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}
