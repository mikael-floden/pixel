/**
 * Normalize the DOM overlay layer to the DESIGN WIDTH (980px).
 *
 * Every overlay px size in this codebase (chat 26px, version badge 24px,
 * plate bars 120px, 1:1 icon bakes …) was tuned on the maintainer's phone,
 * which browses with "Desktop site" ON: mobile Chrome lays the page out on a
 * 980px-wide virtual viewport and shrinks it onto the physical screen. 980
 * is therefore the reference width all those sizes assume.
 *
 * A client with a normal (device-width) viewport lays the page out at
 * ~390-500px — so the same absolute px rendered 2-2.5x bigger relative to
 * the screen (maintainer 2026-07-22: "why is the chat text, git hash and
 * menu icons so big on some screens?"). The world and the vine frame were
 * immune (camera zoom targets ~520 world-px; frame scale = W/768) — only
 * the DOM overlays lacked a compensator after the x1-zoom experiment
 * (2026-07-17) removed the old screen.width-based one. This design-width
 * normalization supersedes BOTH: the old formula's job (desktop-site
 * neutralization) falls out for free, since desktop-site IS the 980 layout.
 *
 * uiZoom() returns k = min(1, innerWidth / DESIGN_W); applyUiZoom puts it on
 * each overlay root as a CSS zoom:
 *  - maintainer's desktop-site phone: innerWidth 980 → k = 1 → BYTE-IDENTICAL
 *    to the approved look (no zoom property is even set);
 *  - device-width phone (~393): k ≈ 0.40 → overlays shrink to the same
 *    PROPORTION of the screen the maintainer sees;
 *  - desktop: clamped at 1 — a large monitor keeps today's look.
 *
 * Anchor rules inside a zoomed root:
 *  - plain px scale with k, so they TRACK THE FRAME (frame scale is also
 *    ∝ innerWidth on portrait viewports) — design-space anchors (badge
 *    bottom, banner/toast top) are plain px on purpose;
 *  - REAL-px vars (--hud-h) and viewport units get double-counted by the
 *    zoom — divide by var(--ml-uizoom) to un-count them (chat.ts' bottom
 *    anchor), and keep vw/vh out of overlay CSS entirely.
 *
 * The HUD (hud.ts) is NOT zoomed — its geometry is glued to the frame in
 * real layout px; its pieces scale themselves (tab width formula, --ml-fs,
 * min(px, vw) fonts, stepped icon zoom).
 */
const DESIGN_W = 980;

export function uiZoom(): number {
  return Math.min(1, window.innerWidth / DESIGN_W);
}

/** Apply the design-width zoom to an overlay root (no-op at ~1). */
export function applyUiZoom(el: HTMLElement) {
  const z = uiZoom();
  if (z < 0.98) (el.style as unknown as { zoom: string }).zoom = z.toFixed(3);
  // Publish the factor so zoomed overlays can un-double-count REAL-px vars
  // in their anchors (--hud-h resolves against the real viewport and the
  // zoom would scale it again — see .ml-chatlog's bottom).
  document.documentElement.style.setProperty("--ml-uizoom", z < 0.98 ? z.toFixed(3) : "1");
}
