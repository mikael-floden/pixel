/** THE CAMERA RECTANGLE AS THIS FRAME WILL RENDER IT.
 *
 * Phaser recomputes `cam.worldView` only inside the camera's own preRender,
 * which runs in the RENDER step — after every scene update(). So in update(),
 * once updateChaseCam has moved scrollX/Y, `worldView` is still LAST frame's
 * rectangle. Anything placed in screen space from it is drawn one frame of
 * camera motion behind the sprites: the night pass's uCam window — every
 * torch pool, sun shadow and fog band — trailed a running scenery block by a
 * strip of lit ground and snapped tight at rest (maintainer's phone,
 * 2026-09-06). This mirrors Camera.preRender (Phaser 3.90) from the LIVE
 * scroll instead: floor when roundPixels (`pixelArt: true` sets it), bounds
 * clamp, view = size/zoom rounded, origin = mid − view/2 rounded. Follow and
 * deadzone are not mirrored — this game moves its camera with centerOn.
 * Padded cull boxes can keep reading `worldView`; pixel-exact overlays can't. */
export interface CamLike {
  scrollX: number;
  scrollY: number;
  width: number;
  height: number;
  zoomX: number;
  zoomY: number;
  roundPixels: boolean;
  useBounds: boolean;
  clampX(x: number): number;
  clampY(y: number): number;
}

export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function renderedWorldView(cam: CamLike, out: ViewRect = { x: 0, y: 0, width: 0, height: 0 }): ViewRect {
  let sx = cam.scrollX;
  let sy = cam.scrollY;
  if (cam.roundPixels) {
    sx = Math.floor(sx);
    sy = Math.floor(sy);
  }
  if (cam.useBounds) {
    sx = cam.clampX(sx);
    sy = cam.clampY(sy);
  }
  const midX = sx + cam.width * 0.5;
  const midY = sy + cam.height * 0.5;
  const dw = Math.floor(cam.width / cam.zoomX + 0.5);
  const dh = Math.floor(cam.height / cam.zoomY + 0.5);
  out.x = Math.floor(midX - dw / 2 + 0.5);
  out.y = Math.floor(midY - dh / 2 + 0.5);
  out.width = dw;
  out.height = dh;
  return out;
}
