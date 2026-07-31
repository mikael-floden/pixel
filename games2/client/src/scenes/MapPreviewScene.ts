import Phaser from "phaser";
import { World } from "../maps";

/**
 * World overview reached at `#map`. The bigworld is far too large to composite
 * tile-by-tile in the browser (512×448 cells ≈ 30k px), so this shows the maps
 * agent's pre-rendered minimap (maps2 world minimap.png). Drag to pan, wheel to
 * zoom.
 */
const MINIMAP_KEY = "world-minimap";

export class MapPreviewScene extends Phaser.Scene {
  private world!: World;

  constructor() {
    super("map-preview");
  }

  init() {
    this.world = this.registry.get("world") as World;
  }

  preload() {
    // maps2 may ship the minimap as PNG or lossless WebP (the art domains are
    // migrating). Queue the png stem and, only if it 404s, the webp one — the
    // same pattern the campfire strip uses in WorldScene. `create` already
    // guards on textures.exists, so a total miss just shows the hint text.
    const stem = "/assets/maps2/worlds/ring_test/minimap";
    this.load.image(MINIMAP_KEY, `${stem}.png`);
    this.load.once("loaderror", (f: Phaser.Loader.File) => {
      if (f.key !== MINIMAP_KEY) return;
      this.load.image(MINIMAP_KEY, `${stem}.webp`);
    });
  }

  create() {
    if (!this.textures.exists(MINIMAP_KEY)) {
      this.add.text(20, 20, "No minimap available (maps2/worlds/<name>/minimap.{png,webp}).", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#eef",
      });
      return;
    }
    const img = this.add.image(0, 0, MINIMAP_KEY).setOrigin(0, 0);
    const w = img.width;
    const h = img.height;

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
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dyw > 0 ? 0.9 : 1.1), 0.05, 8));
    });

    // Mark the points of interest on the minimap (scaled cell → pixel).
    const sx = w / this.world.width;
    const sy = h / this.world.height;
    for (const poi of this.world.pois ?? []) {
      this.add.circle(poi.x * sx, poi.y * sy, 4, 0xffd678).setStrokeStyle(1, 0x000000);
      this.add
        .text(poi.x * sx + 6, poi.y * sy - 6, poi.label, {
          fontFamily: "monospace",
          fontSize: "11px",
          color: "#ffe9b0",
          backgroundColor: "#000a",
        })
        .setPadding(3, 2, 3, 2);
    }

    const info = `World map · ${this.world.width}×${this.world.height} cells · ${this.world.pois?.length ?? 0} places`;
    this.add
      .text(10, 10, info, { fontFamily: "monospace", fontSize: "13px", color: "#dfe3f5", backgroundColor: "#000a" })
      .setScrollFactor(0)
      .setPadding(6, 4, 6, 4);

    // Debug hook for headless verification.
    (window as any).__mlmap = { w, h, pois: this.world.pois?.length ?? 0 };
  }
}
