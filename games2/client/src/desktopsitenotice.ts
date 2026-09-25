/** THE "DESKTOP SITE" NOTICE (desktopsite.ts): once per launch while the page
 *  is squeezed, sized in vw so it reads at a phone's size INSIDE the squeezed
 *  layout it is warning about. Turning the mode off is the fix — the UI is
 *  plain responsive CSS by law and is not compensated. */
import { desktopSqueeze, liveEnv } from "./desktopsite";

const DISMISS_KEY = "ml-desktopsite-ok";
let notice: HTMLElement | null = null;

export function mountDesktopSiteNotice(): void {
  if (notice || typeof document === "undefined") return;
  const k = desktopSqueeze();
  if (k <= 1) return;
  try {
    if (sessionStorage.getItem(DISMISS_KEY)) return;
  } catch {
    /* storage blocked: show it */
  }
  const env = liveEnv();
  const box = document.createElement("div");
  box.className = "ml-dsite";
  box.setAttribute("role", "alert");
  box.innerHTML = `
    <div class="ml-dsite-t">Turn off “Desktop site”</div>
    <div class="ml-dsite-p">Your browser is showing Nangijala as a desktop page, so the whole game is drawn at half size.
      Open the browser menu <b>⋮</b> and untick <b>Desktop site</b> (Samsung Internet: <b>Desktop version</b>).</div>
    <div class="ml-dsite-p">Playing from the installed app? Open <b>nangijala.online</b> in the browser, turn it off there, then reopen the app.</div>
    <div class="ml-dsite-s">Page ${env?.innerWidth ?? "?"} px wide on a ${env ? Math.round(env.innerWidth / k) : "?"} px screen</div>
    <button type="button" class="ml-dsite-ok">OK</button>`;
  const style = document.createElement("style");
  style.textContent = `
    .ml-dsite { position: fixed; z-index: 90; left: 4vw; right: 4vw; top: calc(var(--ml-safe-top, 0px) + 4vw);
      box-sizing: border-box; padding: 4.4vw 5vw; border-radius: 3vw; border: 0.3vw solid var(--border-strong, #4a4640);
      background: var(--surface, #1f1e1c); color: var(--ink, #e8e6e1); font-family: var(--sans, system-ui, sans-serif);
      box-shadow: 0 1.5vw 6vw rgba(0, 0, 0, 0.45); text-align: left; }
    .ml-dsite-t { font-size: 4.6vw; font-weight: 700; margin-bottom: 2.2vw; }
    .ml-dsite-p { font-size: 3.6vw; line-height: 1.4; margin-bottom: 2vw; }
    .ml-dsite-s { font-size: 2.8vw; color: var(--muted, #a8a49c); margin: 2.6vw 0 3.2vw; }
    .ml-dsite-ok { display: block; width: 100%; padding: 3vw 0; border-radius: 2.4vw; border: 0;
      font: 700 4vw var(--sans, system-ui, sans-serif); background: var(--accent, #d97757); color: #fff; }`;
  box.appendChild(style);
  box.querySelector<HTMLButtonElement>(".ml-dsite-ok")!.onclick = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* the session keeps it anyway */
    }
    box.remove();
  };
  document.body.appendChild(box);
  notice = box;
}
