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
