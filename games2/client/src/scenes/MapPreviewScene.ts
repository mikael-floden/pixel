import Phaser from "phaser";
import { World, canvasSize, mapImageUrls, minimapDotPct } from "../maps";

/**
 * World overview reached at `#map`. The world is far too large to composite
 * tile-by-tile in the browser (512x512 cells is a ~33,000px canvas), so this
 * shows the maps agent's own pre-rendered map image. Drag to pan, wheel to zoom.
 *
 * WHICH image and WHERE a cell lands on it are both `maps.ts`'s call, not this
 * scene's: the two map renderers write two names in two trees and project on
 * two different origins (`mapImageUrls` / `minimapDotPct`). This file used to
 * hardcode `maps2/worlds/ring_test/minimap.webp` — a fixed world, a fixed tree
 * and a fixed filename — under whichever world main.ts had actually loaded.
 */
const MINIMAP_KEY = "world-minimap";

export class MapPreviewScene extends Phaser.Scene {
  private world!: World;
  private worldName!: string;

  constructor() {
    super("map-preview");
  }

  init() {
    this.world = this.registry.get("world") as World;
    this.worldName = (this.registry.get("worldName") as string) || "";
  }

  preload() {
    // THE REAL NAME ONLY — no extension fallback here (repo law: a stale path
    // must 404 loudly rather than be masked). `create` guards on
    // textures.exists, so a miss shows the hint text instead of a broken page.
    this.load.image(MINIMAP_KEY, mapImageUrls({ world: this.worldName, iso: this.world?.iso })[0]);
  }

  create() {
    if (!this.textures.exists(MINIMAP_KEY)) {
      this.add.text(20, 20, `No map image for "${this.worldName}".`, {
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

    // Mark the points of interest THROUGH THE RENDERER'S OWN PROJECTION. A
    // cell/width scale is a top-down chart's rule and these images are ISO
    // renders: it put every marker on a diagonal smear across the diamond.
    const maxL = canvasSize(this.world).maxLevel;
    const at = (x: number, y: number): [number, number] => {
      const level = this.world.rows[Math.floor(y)]?.[Math.floor(x)]?.l ?? 0;
      const [px, py] = minimapDotPct({
        world: this.worldName,
        w: this.world.width,
        h: this.world.height,
        maxL,
        col: x,
        row: y,
        level,
        iso: this.world.iso,
      });
      return [(px / 100) * w, (py / 100) * h];
    };
    for (const poi of this.world.pois ?? []) {
      const [px, py] = at(poi.x, poi.y);
      this.add.circle(px, py, 4, 0xffd678).setStrokeStyle(1, 0x000000);
      this.add
        .text(px + 6, py - 6, poi.label, {
          fontFamily: "monospace",
          fontSize: "11px",
          color: "#ffe9b0",
          backgroundColor: "#000a",
        })
        .setPadding(3, 2, 3, 2);
    }

    const info = `World map · ${this.worldName} · ${this.world.width}×${this.world.height} cells · ${this.world.pois?.length ?? 0} places`;
    this.add
      .text(10, 10, info, { fontFamily: "monospace", fontSize: "13px", color: "#dfe3f5", backgroundColor: "#000a" })
      .setScrollFactor(0)
      .setPadding(6, 4, 6, 4);

    // Debug hook for headless verification: the image, and where the world's
    // SPAWN cell lands on it (the projection this scene actually drew with).
    const spawn = this.world.spawn ? at(this.world.spawn[0], this.world.spawn[1]) : null;
    (window as any).__mlmap = {
      w,
      h,
      world: this.worldName,
      maps3: !!this.world.iso,
      pois: this.world.pois?.length ?? 0,
      spawn: spawn ? { x: spawn[0], y: spawn[1] } : null,
    };
  }
}
