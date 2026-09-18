/**
 * THE CAMERA'S ZOOM, and why it must be a WHOLE NUMBER.
 *
 * The canvas backing store is RS x the CSS size (main.ts), so the camera zoom
 * is in BACKING pixels per world pixel. The isometric projection steps by
 * DX=32, DY=14 and a storey pitch of 15 world pixels, and every one of those
 * has to land on a whole backing pixel — otherwise a row's destination falls on
 * a half pixel, `pixelArt: true` (which turns Phaser's roundPixels on) snaps
 * neighbouring rows in OPPOSITE directions, and the seam between them opens by
 * one pixel on some rows and not others.
 *
 * That is the artefact the maintainer reported (2026-08-29): "when I stand at
 * some locations I can see a border around some tiles... the smallest camera
 * zoom can make the border disappear". A phone reports a fractional
 * devicePixelRatio - 2.625 and 2.75 are both common on Android - and the old
 * form, `round(w / (520 * rs)) * rs`, multiplied an integer by that fraction:
 * at rs 2.75 the vertical step is 14 * 2.75 = 38.5 backing pixels. Half a
 * pixel, every other row, drifting in phase as the camera moves - which is
 * exactly why a step made it come and go.
 *
 * Rounding the PRODUCT keeps the intended framing (it moves the scale by less
 * than half a device pixel per world pixel) and makes every projection step
 * whole. RS=1 is unchanged, so desktop and the gates are byte-identical.
 *
 * The speed zoom-OUT still breathes through fractional values while you run;
 * that is deliberate and pre-dates this (main.ts:300), and motion hides it.
 * What must be exact is the zoom the camera RESTS at, which is this.
 */
export function cameraZoom(backingWidth: number, rs: number): number {
  const base = Math.max(1, Math.round(backingWidth / (520 * rs)));
  return Math.max(1, Math.round(base * rs));
}

/** ...AND THE EASE HAS TO ARRIVE, because "motion hides it" stops being true
 *  the moment the player stands still.
 *
 *  An exponential ease never reaches its target: the speed zoom eased back in
 *  on tau 0.85 s and only snapped inside 0.0015, so after a run ended the zoom
 *  spent 5.5 s fractional, and the last ~2.8 s of that moved by less than
 *  0.05 zoom per second — far too slow to read as zooming, but still enough to
 *  re-quantise the ground under nearest-neighbour sampling every frame. The
 *  scenery sprite sat still while the floor swam under it (maintainer
 *  2026-09-18: "a shimmering bug that happens when the player stops and the
 *  camera slowly zooms in. The scenery is fixed at one location and the floor
 *  shimmer under it").
 *
 *  So the tail gets a MINIMUM CLOSING RATE and then lands exactly. Measured
 *  over a 12 s stop at base 3, counting frames where a ground texel inside the
 *  visible half-width jumps a backing pixel while the zoom is moving under
 *  0.05/s (the definition of "shimmers without reading as a zoom"):
 *
 *      today (snap 0.0015)        170 crawl frames, lands at 5.50 s
 *      + min closing 0.05/s         0 crawl frames, lands at 2.68 s
 *      + min closing 0.1/s          0 crawl frames, lands at 2.13 s   <- HIS EASE INTACT
 *      + min closing 0.2/s          0 crawl frames, lands at 1.62 s
 *
 *  0.1/s is the rate that costs nothing anywhere else: the ease's own speed is
 *  |remaining| / tau, which only falls below 0.1/s inside the last 0.085 zoom
 *  — 9% of the 0.96 range — so the first 91% is exactly the curve he tuned
 *  (peak rate 1.12/s before, 1.12/s after; CAM_ZOOM_TAU_IN 0.85 unchanged, and
 *  it was 0.85 for a reason: "no pumping"). A coarser rate would flatten the
 *  ease; snapping harder instead would pop, because 0.085 zoom displaces a
 *  world pixel at the screen edge by 35 backing pixels.
 *
 *  Applied in BOTH directions, so a held run speed settles on its (fractional)
 *  target instead of creeping at it forever — a static fractional zoom has the
 *  seam above, but a static one does not crawl, and the body is moving anyway.
 */
export const CAM_ZOOM_LAND_RATE = 0.1; // zoom units per second, the tail's floor

/** One frame of the zoom ease: the exponential step, then the floor, then the
 *  exact landing. `dt` in seconds, `tau` the ease's own time constant. */
export function zoomStep(cur: number, target: number, dt: number, tau: number): number {
  const eased = cur + (target - cur) * (1 - Math.exp(-dt / tau));
  const left = target - eased;
  const floor = CAM_ZOOM_LAND_RATE * dt;
  if (Math.abs(left) <= floor) return target;
  // Only where the ease has gone slower than the floor — never a speed-up of
  // the part of the curve he tuned.
  const moved = Math.abs(eased - cur);
  if (moved >= floor) return eased;
  return cur + Math.sign(target - cur) * floor;
}
