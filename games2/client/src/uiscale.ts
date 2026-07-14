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
export function uiZoom(): number {
  const sw = window.screen?.width || window.innerWidth;
  return Math.max(1, Math.min(4, window.innerWidth / sw));
}

/** Apply the compensating CSS zoom to an overlay root (no-op at ~1). */
export function applyUiZoom(el: HTMLElement) {
  const z = uiZoom();
  if (z > 1.05) (el.style as unknown as { zoom: string }).zoom = z.toFixed(2);
}
