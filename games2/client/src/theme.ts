/**
 * Shared wiki-style theme — the game's HALF of the "wiki and game are one
 * unit" contract (maintainer 2026-07-30: the whole UI/HUD is rebuilt in the
 * wiki's Claude-artifact look; "changing to dark theme will affect both the
 * wiki and the in-game HUD").
 *
 * TOKENS: wiki/site/wiki.css's palette blocks (serif display headings, coral
 * #d97757 accent, quiet 1px borders, 8-14px radii), with the LIGHT ground
 * retuned to beige (maintainer 2026-09-12: "the light css is a bit too
 * light/white … make it a little more beige … I just don't want this super
 * white"). Kept the SAME custom-property names (--bg, --surface, --ink, ...)
 * so game CSS reads exactly like wiki CSS, and the DARK blocks are the
 * wiki's verbatim. The two files are deliberately twins — the wiki agent has
 * the new light values on their board to adopt.
 *
 * THE BEIGE, in CIELAB so the ramp is even and the reason survives a hex
 * edit: one hue for every neutral (h 86°, a warm paper yellow — 78° reads
 * salmon beside the coral accent and 92° goes dusty olive), L* stepping
 * 98.2 surface / 95.0 ground / 91.7 pressed / 87.2 border / 79.7 strong
 * border, with chroma RISING as it darkens (3.6 → 8.3) the way real paper
 * does. HIS PICK from six rendered candidates was the SOFTER one — same hue,
 * chroma × 0.72, a step lighter — over the fuller paper beige: "a little
 * bit more beige than white", not a parchment. Nothing is pure white any
 * more; the cards are the lightest step, not #fff, so they still lift off
 * the ground by 3.2 L*.
 * CONTRAST HELD, measured, because the ground moved down: ink 14.2:1 on the
 * ground, muted 4.52:1 — and `--good` / `--accent-ink` are a hair darker
 * than the wiki's purely to stay above 4.5:1 on the beige.
 *
 * DARK THEME is the wiki's contract exactly:
 * - localStorage["wiki-theme"] = "light" | "dark" (unset → OS preference
 *   via the prefers-color-scheme blocks, same as wiki.css);
 * - applied as <html data-theme="...">.
 * SYNC, both directions, no edits inside wiki/ (another agent's domain):
 * - wiki drawer (same-origin iframe) toggles → its localStorage write fires
 *   a `storage` event in THIS window → we re-apply;
 * - game toggles → we write the key + set our root + dispatch "ml-theme" so
 *   wikipanel.ts can mirror data-theme straight onto the live iframe's
 *   documentElement (same-origin, so that's allowed; the iframe only reads
 *   localStorage at load).
 */

export const THEME_KEY = "wiki-theme";
export type Theme = "light" | "dark";

/** The theme in force right now (explicit choice, else OS preference). */
export function currentTheme(): Theme {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(theme: string | null) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  window.dispatchEvent(new CustomEvent("ml-theme", { detail: currentTheme() }));
}

/** Flip light↔dark, persist, and broadcast (game root + "ml-theme" event —
 * wikipanel mirrors it onto a live wiki iframe). */
export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {}
  apply(next);
  return next;
}

let mounted = false;
/** Inject the shared tokens + base element styles, apply the saved theme,
 * and follow the wiki drawer's toggle via storage events. Idempotent. */
export function mountTheme() {
  if (mounted) return;
  mounted = true;
  try {
    apply(localStorage.getItem(THEME_KEY));
  } catch {}
  // the wiki iframe (or another same-origin tab) toggled — follow it
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_KEY) apply(e.newValue);
  });
  const s = document.createElement("style");
  s.id = "ml-theme";
  s.textContent = CSS_TOKENS;
  document.head.appendChild(s);
}

/* Palette + font tokens: wiki/site/wiki.css verbatim (light block, media
 * fallback, and the two data-theme override blocks), plus the game's few
 * shared derived tokens at the bottom. */
const CSS_TOKENS = `
:root {
  --bg: #f6f0e6;
  --surface: #fdf9f3;
  --surface-2: #eee6da;
  --ink: #23211d;
  --muted: #736d63;
  --border: #e1dacd;
  --border-strong: #cdc5b6;
  --accent: #d97757;
  --accent-soft: #fbded4;
  --accent-ink: #b15005;
  --good: #497849;
  --good-soft: #deecde;
  --bad: #b3453a;
  --bad-soft: #f8dedb;
  --star: #d9a13b;
  --checker-a: #f1ebe1;
  --checker-b: #e4ddd1;
  --shadow: 0 1px 2px rgba(40, 35, 25, 0.06), 0 4px 16px rgba(40, 35, 25, 0.05);
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, ui-serif, serif;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #262624; --surface: #30302e; --surface-2: #3a3937; --ink: #f0eee7;
    --muted: #a6a195; --border: #43423e; --border-strong: #55534d;
    --accent: #d97757; --accent-soft: #4a352d; --accent-ink: #e6a27f;
    --good: #8fbc8f; --good-soft: #32402f; --bad: #e08d80; --bad-soft: #4a2f2b;
    --star: #e0b25e; --checker-a: #3a3937; --checker-b: #2f2e2c;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 4px 16px rgba(0, 0, 0, 0.25);
  }
}
:root[data-theme="light"] {
  --bg: #f6f0e6; --surface: #fdf9f3; --surface-2: #eee6da; --ink: #23211d;
  --muted: #736d63; --border: #e1dacd; --border-strong: #cdc5b6;
  --accent: #d97757; --accent-soft: #fbded4; --accent-ink: #b15005;
  --good: #497849; --good-soft: #deecde; --bad: #b3453a; --bad-soft: #f8dedb;
  --star: #d9a13b; --checker-a: #f1ebe1; --checker-b: #e4ddd1;
  --shadow: 0 1px 2px rgba(40, 35, 25, 0.06), 0 4px 16px rgba(40, 35, 25, 0.05);
}
:root[data-theme="dark"] {
  --bg: #262624; --surface: #30302e; --surface-2: #3a3937; --ink: #f0eee7;
  --muted: #a6a195; --border: #43423e; --border-strong: #55534d;
  --accent: #d97757; --accent-soft: #4a352d; --accent-ink: #e6a27f;
  --good: #8fbc8f; --good-soft: #32402f; --bad: #e08d80; --bad-soft: #4a2f2b;
  --star: #e0b25e; --checker-a: #3a3937; --checker-b: #2f2e2c;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 4px 16px rgba(0, 0, 0, 0.25);
}

/* ---- shared game controls (wiki.css component recipes, game class names;
        every rebuilt surface uses these instead of the retired UI kit) ---- */
.ui-btn {
  font: 600 14px/1.2 var(--sans); cursor: pointer;
  background: var(--surface); color: var(--ink);
  border: 1px solid var(--border); border-radius: 9px;
  padding: 8px 14px;
  -webkit-tap-highlight-color: transparent; touch-action: manipulation;
  user-select: none; -webkit-user-select: none;
}
.ui-btn:hover { background: var(--surface-2); }
.ui-btn:active, .ui-btn.press { background: var(--surface-2); border-color: var(--border-strong); transform: translateY(1px); }
.ui-btn.on, .ui-btn.sel { background: var(--accent-soft); border-color: var(--accent); font-weight: 700; }
.ui-btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.ui-btn.primary:hover { filter: brightness(1.06); background: var(--accent); }
.ui-btn:disabled { opacity: 0.55; cursor: default; }
.ui-input {
  background: var(--surface); color: var(--ink);
  border: 1px solid var(--border); border-radius: 9px;
  padding: 8px 12px; font: 14px/1.3 var(--sans); outline: none;
}
.ui-input:focus { border-color: var(--accent); }
.ui-input::placeholder { color: var(--muted); }
.ui-panel {
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  box-shadow: var(--shadow);
}
.ui-title {
  font-family: var(--serif); font-weight: 600; color: var(--ink);
}
.ui-label {
  color: var(--muted); font: 600 12px/1.2 var(--sans);
  letter-spacing: 0.08em; text-transform: uppercase;
}
`;
