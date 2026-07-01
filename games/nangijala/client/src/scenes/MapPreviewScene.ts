import Phaser from "phaser";
import {
  World,
  MAP_GEOMETRY,
  tileKey,
  tileUrl,
  distinctTiles,
  drawOrder,
  canvasSize,
} from "../maps";

/**
 * Renders the maps agent's isometric world with elevation, as a foundation for
 * the eventual in-game tile world. Reached at `#map` so it doesn't disturb the
 * live game. Drag to pan, wheel to zoom.
 */
export class MapPreviewScene extends Phaser.Scene {
  private world!: World;

  constructor() {
    super("map-preview");
  }

  init() {
    this.world = this.registry.get("world") as World;
  }

  preload() {
    for (const { t, v } of distinctTiles(this.world)) {
      this.load.image(tileKey(t, v), tileUrl(t, v));
    }
  }

  create() {
    const { dx, dy, lh } = MAP_GEOMETRY;
    const { w, h, ox, oy } = canvasSize(this.world);

    const rt = this.add.renderTexture(0, 0, w, h).setOrigin(0, 0);
    rt.fill(0x181c28, 1);

    // Batch all stamps into one GPU pass (per-draw readback stalls otherwise).
    let drawn = 0;
    let missing = 0;
    rt.beginDraw();
    for (const { x, y, cell } of drawOrder(this.world)) {
      const key = tileKey(cell.t, cell.v);
      if (!this.textures.exists(key)) {
        missing++;
        continue;
      }
      const baseX = ox + (x - y) * dx;
      const baseY = oy + (x + y) * dy;
      // Stack ground..level so side faces build a solid raised block.
      for (let lvl = 0; lvl <= cell.l; lvl++) {
        rt.batchDraw(key, baseX, baseY - lvl * lh);
      }
      drawn++;
    }
    rt.endDraw();

    // Fit the whole world in view, then allow drag-pan + wheel-zoom.
    const cam = this.cameras.main;
    cam.setBounds(0, 0, w, h);
    const fit = Math.min(this.scale.width / w, this.scale.height / h) * 0.98;
    cam.setZoom(fit);
    cam.centerOn(w / 2, h / 2);

    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!p.isDown) return;
      cam.scrollX -= p.velocity.x / cam.zoom;
      cam.scrollY -= p.velocity.y / cam.zoom;
    });
    this.input.on("wheel", (_p: unknown, _o: unknown, _dx: number, dyw: number) => {
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dyw > 0 ? 0.9 : 1.1), 0.1, 6));
    });

    const info =
      `Map preview · ${this.world.width}×${this.world.height} · iter ${this.world.iteration ?? "?"}` +
      ` · ${drawn} cells drawn${missing ? ` · ${missing} missing tiles` : ""}`;
    this.add
      .text(10, 10, info, { fontFamily: "monospace", fontSize: "13px", color: "#dfe3f5", backgroundColor: "#000a" })
      .setScrollFactor(0)
      .setPadding(6, 4, 6, 4);

    // Debug hook for headless verification.
    (window as any).__mlmap = { drawn, missing, w, h };
  }
}
