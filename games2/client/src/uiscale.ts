/**
 * Neutralize the browser's "Desktop site" toggle for the DOM UI.
 *
 * With desktop-site ON, mobile Chrome ignores the viewport meta and lays the
 * page out on a ~980px virtual viewport, then shrinks it to the screen — so
 * every DOM overlay (select screen, loading logo, chat, roster) rendered
 * tiny. The game must look the SAME regardless of that toggle (the camera
 * zoom handles the canvas side — see WorldScene), so the UI compensates:
 * scale overlays by how much wider the layout viewport is than the device.
 *
 * Overlay CSS must avoid vw/vh units (they resolve against the REAL viewport
 * and would double-count under zoom) — use px and % inside zoomed roots.
 */
// EXPERIMENT (maintainer 2026-07-17): try the HUD/UI overlays at x1 zoom —
// NO compensating "Desktop site" scale — instead of the usual ~x2.49 on his
// phone. Every overlay (select, loading, chat, roster, badge, banner, the
// select ring) reads uiZoom() through this one chokepoint, so flipping this
// flag back to false (or reverting the commit) is the full rollback.
const UI_ZOOM_X1 = true;

export function uiZoom(): number {
  if (UI_ZOOM_X1) return 1;
  const sw = window.screen?.width || window.innerWidth;
  return Math.max(1, Math.min(4, window.innerWidth / sw));
}

/** Apply the compensating CSS zoom to an overlay root (no-op at ~1). */
export function applyUiZoom(el: HTMLElement) {
  const z = uiZoom();
  if (z > 1.05) (el.style as unknown as { zoom: string }).zoom = z.toFixed(2);
  // Expose the factor so zoomed overlays can un-double-count viewport-unit
  // vars in their anchors: dvh resolves against the REAL viewport and the
  // zoom then scales it again (e.g. the chat log's --hud-h bottom anchor
  // landed at the TOP of the game view in desktop-site mode).
  document.documentElement.style.setProperty("--ml-uizoom", z > 1.05 ? z.toFixed(2) : "1");
}
