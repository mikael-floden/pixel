import Phaser from "phaser";
import { surfaceFor } from "@nangijala/shared";
import { World, MAP_GEOMETRY, tileKey, tileUrl, canvasSize } from "../maps";
import { NightLights, EmissionMap, GlowStamp, ShaderLight, buildGlowStamps } from "../nightlight";

/**
 * Emission demo world (reach it with [0] in game, or /#emission): every
 * variant of every GLOWING tile category (tiles/emission.json) on a numbered
 * station, at night, with the full emission pipeline running — self floor,
 * glow pools and per-pixel halos. Stations sit in rows of 20, four cells
 * apart, so you can glide along a row and inspect tile by tile; report any
 * odd one by the number floating above it.
 *
 * Standable categories stand on a 2-level column so their SIDE FACES are
 * exposed — a tile whose sources point up/sw/se shows exactly those glows
 * (top halo / left face / right face). Solid object tiles (spires…) sit on
 * flat ground as in the game.
 */

const NIGHT: [number, number, number] = [0.075, 0.09, 0.14];
const PER_ROW = 20;
const SPACING = 4; // cells between stations along a row
const ROW_PITCH = 7; // cells between station rows (keeps labels unambiguous)
const MARGIN = 6;
const STATION_LEVEL = 2;

interface Station {
  n: number;
  cat: string;
  v: number;
  col: number;
  row: number;
  solid: boolean;
}

export class EmissionDemoScene extends Phaser.Scene {
  private emission: EmissionMap = {};
  private stations: Station[] = [];
  private world!: World;
  private iso = { ox: 0, oy: 0 };
  private maxLevel = STATION_LEVEL;
  private night?: NightLights;
  private stamps: GlowStamp[] = [];
  private pools: ShaderLight[] = [];
  private lastStamp = { x: NaN, y: NaN, zoom: NaN };
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;

  constructor() {
    super("emission-demo");
  }

  init() {
    this.emission = (this.registry.get("emission") as EmissionMap | undefined) ?? {};
    // Stations: every variant of every emissive category, sorted for stable
    // numbering (report "tile 37" and it means the same tile next run).
    const cats = Object.entries(this.emission)
      .filter(([, e]) => e)
      .sort(([a], [b]) => a.localeCompare(b));
    let n = 1;
    for (const [cat, entry] of cats) {
      const s = surfaceFor(cat);
      const solid = !s.standable && !s.swimmable;
      // ALL variants — including ones the analyzer found no sources in, so a
      // missed glowing tile is visible in the lineup (dark = report it).
      const srcKeys = Object.keys(entry!.sources ?? {}).map(Number);
      const count = entry!.variants ?? (srcKeys.length ? Math.max(...srcKeys) + 1 : 0);
      const variants = Array.from({ length: count }, (_, k) => k);
      for (const v of variants) {
        const i = n - 1;
        this.stations.push({
          n,
          cat,
          v,
          col: MARGIN + (i % PER_ROW) * SPACING,
          row: MARGIN + Math.floor(i / PER_ROW) * ROW_PITCH,
          solid,
        });
        n++;
      }
    }
  }

  preload() {
    const seen = new Set<string>();
    for (const st of this.stations) {
      const key = tileKey(st.cat, st.v);
      if (!seen.has(key)) {
        seen.add(key);
        this.load.image(key, tileUrl(st.cat, st.v));
      }
    }
    for (let v = 0; v < 3; v++) this.load.image(tileKey("meadow", v), tileUrl("meadow", v));
  }

  create() {
    // Synthetic world: dark meadow, one glowing tile per station.
    const cols = MARGIN * 2 + (PER_ROW - 1) * SPACING + 1;
    const rowsN = MARGIN * 2 + (Math.ceil(this.stations.length / PER_ROW) - 1) * ROW_PITCH + 1;
    const rows = Array.from({ length: rowsN }, (_, r) =>
      Array.from({ length: cols }, (_, c) => ({ t: "meadow", v: (c * 7 + r * 13) % 3, l: 0 })),
    );
    for (const st of this.stations) rows[st.row][st.col] = { t: st.cat, v: st.v, l: st.solid ? 0 : STATION_LEVEL };
    this.world = { width: cols, height: rowsN, rows, pois: [] };
    const cs = canvasSize(this.world);
    this.iso = { ox: cs.ox, oy: cs.oy };
    this.maxLevel = cs.maxLevel;

    // Draw the whole world as plain images (it is small), painter order.
    const { dx, dy, lh } = MAP_GEOMETRY;
    for (let r = 0; r < rowsN; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = rows[r][c];
        const bx = this.iso.ox + (c - r) * dx;
        const by = this.iso.oy + (c + r) * dy;
        const key = tileKey(cell.t, cell.v);
        if (!this.textures.exists(key)) continue;
        // Bottom-anchor tall (64x128) art — same rule as the game world.
        const h0 = (this.textures.get(key).getSourceImage() as { height?: number })?.height ?? 64;
        const aOff = h0 > 64 ? h0 - 55 : 0; // base_y anchoring, see WorldScene.artYOff
        for (let k = 0; k <= cell.l; k++) {
          this.add.image(bx, by - k * lh - aOff, key).setOrigin(0, 0).setDepth(by + dy);
        }
      }
    }

    // Station numbers — ABOVE the darkness overlay so they stay readable.
    for (const st of this.stations) {
      const bx = this.iso.ox + (st.col - st.row) * dx + dx;
      const key = tileKey(st.cat, st.v);
      const h1 = this.textures.exists(key)
        ? ((this.textures.get(key).getSourceImage() as { height?: number })?.height ?? 64)
        : 64;
      const aOff = h1 > 64 ? h1 - 55 : 0;
      const topY = this.iso.oy + (st.col + st.row) * dy - (st.solid ? 0 : STATION_LEVEL) * lh - aOff;
      this.add
        .text(bx, topY - 26, String(st.n), {
          fontFamily: "monospace",
          fontSize: "16px",
          color: "#ffffff",
          stroke: "#000000",
          strokeThickness: 3,
        })
        .setOrigin(0.5, 1)
        .setDepth(900_100);
      this.add
        .text(bx, topY - 24, `${st.cat} ${String(st.v).padStart(2, "0")}`, {
          fontFamily: "monospace",
          fontSize: "9px",
          color: "#9aa3c8",
          stroke: "#000000",
          strokeThickness: 2,
        })
        .setOrigin(0.5, 0)
        .setDepth(900_100);
    }

    // Night lighting with the full emission pipeline (no torches, no fire).
    if (this.game.renderer.type === Phaser.WEBGL) {
      try {
        this.night = new NightLights(this, this.world, this.iso, this.maxLevel, this.emission);
        this.night.create();
        this.night.setActive(true);
      } catch (err) {
        console.warn("[nangijala] demo: shader night unavailable:", err);
      }
    }

    // Camera: start at station 1, WASD/arrows glide, drag pan, wheel zoom.
    const cam = this.cameras.main;
    cam.setZoom(2);
    const s0 = this.stations[0];
    if (s0) cam.centerOn(this.iso.ox + (s0.col - s0.row) * dx + dx, this.iso.oy + (s0.col + s0.row) * dy);
    this.keys = this.input.keyboard!.addKeys("W,A,S,D,UP,DOWN,LEFT,RIGHT,SHIFT") as Record<
      string,
      Phaser.Input.Keyboard.Key
    >;
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!p.isDown) return;
      cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
      cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
    });
    this.input.on("wheel", (_p: unknown, _o: unknown, _dx: number, dyw: number) => {
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dyw > 0 ? 0.9 : 1.1), 1, 4));
    });
    const leave = () => {
      location.hash = "";
      location.reload();
    };
    this.input.keyboard!.on("keydown-ZERO", leave);
    this.input.keyboard!.on("keydown-ESC", leave);

    this.add
      .text(
        10,
        10,
        "EMISSION DEMO — every glowing tile, numbered. WASD/drag to glide, wheel zoom, [0]/Esc to leave.\nRaised tiles show face glow (sw/se sources), flat objects glow as drawn. Report odd tiles by number.",
        { fontFamily: "monospace", fontSize: "12px", color: "#cfd6ff", stroke: "#000", strokeThickness: 3 },
      )
      .setScrollFactor(0)
      .setDepth(1e9);

    // Headless probe hooks (mirrors the game's __ml where it makes sense).
    (window as unknown as { __ml: unknown }).__ml = {
      demo: true,
      nightShader: () => !!this.night && this.night.active,
      stations: () => this.stations,
      lookStation: (n: number) => {
        const st = this.stations.find((s) => s.n === n);
        if (!st) return null;
        cam.centerOn(this.iso.ox + (st.col - st.row) * dx + dx, this.iso.oy + (st.col + st.row) * dy);
        return st;
      },
      cellScreen: (col: number, row: number) => {
        const cell = this.world.rows[row]?.[col];
        if (!cell) return null;
        const wx = this.iso.ox + (col - row) * dx;
        const wy = this.iso.oy + (col + row) * dy - cell.l * lh;
        return {
          x: (wx - cam.worldView.x) * cam.zoom,
          y: (wy - cam.worldView.y) * cam.zoom,
          zoom: cam.zoom,
          level: cell.l,
          t: cell.t,
          v: cell.v,
        };
      },
      glowFlip: (v?: number) => {
        if (this.night && v !== undefined) this.night.glowFlip = v;
        return { flip: this.night?.glowFlip, stamps: this.stamps.length };
      },
      nightCal: (flip: number, span: number, test: number) => {
        if (!this.night) return null;
        this.night.fieldFlip = flip;
        this.night.spanScale = span;
        this.night.testPattern = test;
        return { flip, span, test };
      },
    };
  }

  update() {
    if (!this.night) return;
    const cam = this.cameras.main;
    const speed = (this.keys.SHIFT?.isDown ? 520 : 260) / cam.zoom / 60;
    if (this.keys.A?.isDown || this.keys.LEFT?.isDown) cam.scrollX -= speed * 16;
    if (this.keys.D?.isDown || this.keys.RIGHT?.isDown) cam.scrollX += speed * 16;
    if (this.keys.W?.isDown || this.keys.UP?.isDown) cam.scrollY -= speed * 16;
    if (this.keys.S?.isDown || this.keys.DOWN?.isDown) cam.scrollY += speed * 16;

    const ccx = cam.worldView.centerX;
    const ccy = cam.worldView.centerY;
    if (
      Number.isNaN(this.lastStamp.x) ||
      Math.abs(ccx - this.lastStamp.x) > 96 ||
      Math.abs(ccy - this.lastStamp.y) > 96 ||
      cam.zoom !== this.lastStamp.zoom
    ) {
      this.lastStamp = { x: ccx, y: ccy, zoom: cam.zoom };
      const pad = 300;
      this.stamps = buildGlowStamps(
        this.world,
        this.emission,
        this.iso,
        {
          x0: cam.worldView.x - pad,
          y0: cam.worldView.y - pad,
          x1: cam.worldView.right + pad,
          y1: cam.worldView.bottom + pad,
        },
        this.maxLevel,
        undefined,
        (t, v) => {
          const k = tileKey(t, v);
          if (!this.textures.exists(k)) return 0;
          const h2 = (this.textures.get(k).getSourceImage() as { height?: number })?.height ?? 64;
          return h2 > 64 ? h2 - 55 : 0;
        },
      );
      // Glow pools (layer 2, same convention as the game: negative radius =
      // shadow-free): one pool per glowing station, nearest 8 win the slots.
      const { dx: dx2, dy: dy2 } = MAP_GEOMETRY;
      const cCol = ((ccx - this.iso.ox) / dx2 + (ccy - this.iso.oy) / dy2) / 2;
      const cRow = ((ccy - this.iso.oy) / dy2 - (ccx - this.iso.ox) / dx2) / 2;
      this.pools = this.stations
        .filter((st) => (this.emission[st.cat]?.sources?.[String(st.v)]?.length ?? 0) > 0)
        .sort(
          (a, b) =>
            (a.col - cCol) ** 2 + (a.row - cRow) ** 2 - ((b.col - cCol) ** 2 + (b.row - cRow) ** 2),
        )
        .slice(0, 8)
        .map((st) => {
          const e = this.emission[st.cat]!;
          return {
            col: st.col + 0.5,
            row: st.row + 0.5,
            z: (st.solid ? 0 : STATION_LEVEL) + 0.6,
            radius: -e.radius,
            color: [e.color[0] * e.strength, e.color[1] * e.strength, e.color[2] * e.strength] as [
              number,
              number,
              number,
            ],
            flicker: e.anim === "flicker" ? 0.6 : 0,
          };
        });
    }
    this.night.update(cam, this.pools, NIGHT, this.stamps);
  }
}
