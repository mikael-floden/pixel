import Phaser from "phaser";
import { CELL_WU, pointInArea, type AmbientZone } from "@nangijala/shared";
import type { ZoneField } from "./zonefield";

/* THE AMBIENT ZONES, IN THE WORLD — Settings/dev "ambient zones", off by
 * default (maintainer 2026-09-20: "add a menu button under settings/dev where
 * I can see the ambient zone boundaries ... I want the same when debugging the
 * ambient zones" as the zone button).
 *
 * THE RECIPE IS THE ZONE BORDERS' — his approved one, not a new invention
 * (2026-09-10: "I want you to not invent something new here"): a 2 px line
 * sampled per cell so it climbs the terrain, inward TICKS every two cells so
 * the side you are on is said in screen space with nothing painted over the
 * ground, and no tint. Two things this overlay adds because these zones are
 * not a grid: a LABEL at each zone with its name and the set that is ON in it
 * right now (the thing you are checking at a boundary), and colour by KIND,
 * so the marsh's line and the moor's line beside it are two lines. The zones
 * holding MY cell take the zone borders' inner red, so inside/outside is the
 * same signal it is there.
 *
 * ON TOP OF EVERYTHING (900_002.5, beside the zone borders at 900_002.4): a
 * boundary is a question about the world, and the terrain between me and it
 * must not eat it — the lesson that overlay paid for.
 *
 * REDRAWN, NOT STEPPED: once per toggle, per re-rolled table (the labels
 * change), and whenever the camera has moved more than a third of a view
 * since the last draw; culled to the view plus a margin so a 96-zone world
 * is a handful of polygons per draw. */

const DEPTH = 900_002.5;
const LINE_W = 2;
const LINE_A = 0.85;
const MY_LINE = 0xff8f80; // the zone borders' inner red — "my" zone
const TICK_CELLS = 0.45;
const TICK_EVERY = 2;
const MARGIN_PX = 160;
const REDRAW_MOVE = 0.34; // of the view's width/height
const KIND_COLOUR: Record<string, number> = {
  sea: 0x6fb8ff, islet: 0x8fd6ff, shore: 0xf2e394, sands: 0xf2e394, dunes: 0xe8c96a,
  lake: 0x7fd3ff, tarn: 0x9bd9ff, marsh: 0x8fe0a0, forest: 0x62c46a, meadow: 0xa8e26b,
  heath: 0xc9c56b, moor: 0xb59d6b, massif: 0xc7b8a8, summit: 0xffffff, cave: 0xd39bff,
  lava: 0xff8a5b, slime: 0xa6ff7a, town: 0xffc36b, world: 0x999999,
};
const STORE = "ml-ambient-zones";

export class ZoneLines {
  on = false;
  private gfx: Phaser.GameObjects.Graphics | null = null;
  private labels: Phaser.GameObjects.Text[] = [];
  private drawnAt: { x: number; y: number; w: number; h: number; version: number; my: string } | null = null;
  private dirty = true;

  /** A DEBUG OVERLAY DOES NOT SURVIVE A RELOAD. It used to be remembered per
   *  device, and remembered is how it ruins a session: the maintainer ran with
   *  it on, reinstalled the app and cleared his cache, and it came back — site
   *  data outlives both — so his whole world was under green and salmon
   *  zigzags and zone labels, on top of terrain that was still streaming
   *  (2026-09-21: "THEY LOOK LIKE A GAME FROM 30 YEARS AGO"). It starts OFF on
   *  every load now and the switch still works for as long as you are looking
   *  at it; the stored key is cleared on the way past so a device that has one
   *  from before is freed by the next load. */
  constructor(private readonly scene: Phaser.Scene, private readonly field: ZoneField) {
    this.on = false;
    try { localStorage.removeItem(STORE); } catch {}
  }

  set(on?: boolean): boolean {
    if (on !== undefined && on !== this.on) {
      this.on = on;
      this.dirty = true;
      // Deliberately NOT remembered — see the constructor.
      if (!on) this.clear();
    }
    return this.on;
  }

  /** Every frame, cheap: redraw only when something that changes the picture did. */
  step(view: Phaser.Geom.Rectangle, _zoom: number) {
    if (!this.on) return;
    const version = this.field.tableVersion;
    const my = this.myKey();
    const d = this.drawnAt;
    const moved = !d || Math.abs(view.x - d.x) > view.width * REDRAW_MOVE || Math.abs(view.y - d.y) > view.height * REDRAW_MOVE
      || Math.abs(view.width - d.w) > 1 || Math.abs(view.height - d.h) > 1;
    if (!this.dirty && d && d.version === version && d.my === my && !moved) return;
    this.draw(view);
    this.drawnAt = { x: view.x, y: view.y, w: view.width, h: view.height, version, my };
    this.dirty = false;
  }

  dispose() {
    this.clear();
    this.gfx?.destroy();
    this.gfx = null;
  }

  private clear() {
    this.gfx?.clear();
    for (const t of this.labels) t.destroy();
    this.labels = [];
    this.drawnAt = null;
  }

  private probes() {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const project = ml?.projectCell as undefined | ((c: number, r: number, l: number) => { x: number; y: number });
    const levelAt = ml?.levelAt as undefined | ((wx: number, wy: number) => number);
    const info = ml?.ambientZonesInfo as undefined | (() => { cell: { col: number; row: number; lvl: number } });
    return { project, levelAt, info };
  }

  private myKey(): string {
    try {
      const c = this.probes().info?.().cell;
      return c ? `${c.col},${c.row},${c.lvl}` : "";
    } catch { return ""; }
  }

  private draw(view: Phaser.Geom.Rectangle) {
    const doc = this.field.zones;
    const { project, levelAt } = this.probes();
    if (!this.gfx) this.gfx = this.scene.add.graphics().setDepth(DEPTH);
    this.clear();
    if (!doc || !project) return;
    const g = this.gfx;
    const lvlAt = (c: number, r: number) => (levelAt ? levelAt(c * CELL_WU, r * CELL_WU) : 0);
    const at = (c: number, r: number) => project(c, r, lvlAt(c, r));
    const x0 = view.x - MARGIN_PX, y0 = view.y - MARGIN_PX, x1 = view.right + MARGIN_PX, y1 = view.bottom + MARGIN_PX;
    const my = this.myCell();
    for (const z of doc.zones) {
      if (z.kind === "world") continue; // the whole canvas: no boundary to see
      // cull by the projected bounding box of the polygon's corners
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const [c, r] of z.area) {
        const p = at(c, r);
        if (p.x < bx0) bx0 = p.x; if (p.x > bx1) bx1 = p.x; if (p.y < by0) by0 = p.y; if (p.y > by1) by1 = p.y;
      }
      if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue;
      const mine = my !== null && this.holds(z, my.col, my.row, my.lvl);
      const colour = mine ? MY_LINE : KIND_COLOUR[z.kind] ?? hashColour(z.kind);
      const n = z.area.length;
      /* TWO PASSES PER ZONE: a dark, wider stroke under the coloured one, so
       * a meadow's yellow-green reads on grass and a summit's white on snow
       * — the label's own stroke, applied to the line. Measured on the first
       * picture: a 2 px yellow-green line over grass all but vanished. */
      const segs: [number, number, number, number][] = [];
      const ticks: [number, number, number, number][] = [];
      let visible: { x: number; y: number } | null = null; // a visible point ON the line, for the label
      for (let i = 0; i < n; i++) {
        const [ac, ar] = z.area[i];
        const [bc, br] = z.area[(i + 1) % n];
        // axis-aligned edges: walk it a cell at a time so it follows the ground
        const vertical = ac === bc;
        const from = vertical ? ar : ac, to = vertical ? br : bc;
        const step = to >= from ? 1 : -1;
        // the inward normal, in cell space: the side of the edge the polygon is on
        const mc = (ac + bc) / 2, mr = (ar + br) / 2;
        const nx = vertical ? (pointInArea(z.area, mc + 0.5, mr) ? 1 : -1) : 0;
        const ny = vertical ? 0 : (pointInArea(z.area, mc, mr + 0.5) ? 1 : -1);
        let prev = vertical ? at(ac, from) : at(from, ar);
        for (let t = from + step; step > 0 ? t <= to : t >= to; t += step) {
          const c = vertical ? ac : t, r = vertical ? t : ar;
          const p = at(c, r);
          segs.push([prev.x, prev.y, p.x, p.y]);
          if (p.x >= view.x && p.x <= view.right && p.y >= view.y && p.y <= view.bottom) visible = visible ?? p;
          if (t % TICK_EVERY === 0 && t !== to) {
            // a tick hangs off a point OF the line and points inward in screen space
            const q = project(c + nx, r + ny, lvlAt(c, r));
            ticks.push([p.x, p.y, p.x + (q.x - p.x) * TICK_CELLS, p.y + (q.y - p.y) * TICK_CELLS]);
          }
          prev = p;
        }
      }
      g.lineStyle(LINE_W + 2, 0x000000, 0.55);
      for (const [x0s, y0s, x1s, y1s] of segs) g.lineBetween(x0s, y0s, x1s, y1s);
      for (const [x0s, y0s, x1s, y1s] of ticks) g.lineBetween(x0s, y0s, x1s, y1s);
      g.lineStyle(LINE_W, colour, LINE_A);
      for (const [x0s, y0s, x1s, y1s] of segs) g.lineBetween(x0s, y0s, x1s, y1s);
      for (const [x0s, y0s, x1s, y1s] of ticks) g.lineBetween(x0s, y0s, x1s, y1s);
      // THE LABEL: the name, and what is ON here right now
      let cc = 0, cr = 0;
      for (const [c, r] of z.area) { cc += c; cr += r; }
      cc /= n; cr /= n;
      const centroid = at(cc, cr);
      const onScreen = centroid.x >= view.x && centroid.x <= view.right && centroid.y >= view.y && centroid.y <= view.bottom;
      // A ZONE BIGGER THAN THE SCREEN has its centroid far away; the label
      // then sits on the first visible point of its line, where the eye is.
      const lp = onScreen ? centroid : visible;
      if (lp) {
        const set = this.field.setOf(z.id);
        const txt = this.scene.add.text(lp.x, lp.y, `${z.name}\n${set ? set.split(",").join(" · ") : "—"}`, {
          fontFamily: "monospace", fontSize: "11px", color: `#${colour.toString(16).padStart(6, "0")}`,
          align: "center", stroke: "#000000", strokeThickness: 3,
        }).setOrigin(onScreen ? 0.5 : 0, onScreen ? 0.5 : 1.1).setDepth(DEPTH).setAlpha(0.95);
        this.labels.push(txt);
      }
    }
  }

  private myCell(): { col: number; row: number; lvl: number } | null {
    try { return this.probes().info?.().cell ?? null; } catch { return null; }
  }

  private holds(z: AmbientZone, col: number, row: number, lvl: number): boolean {
    if (z.elev && (lvl < z.elev[0] || lvl > z.elev[1])) return false;
    return pointInArea(z.area, col + 0.5, row + 0.5);
  }
}

/** A stable colour for a kind the table does not name. */
function hashColour(kind: string): number {
  let h = 0;
  for (let i = 0; i < kind.length; i++) h = (h * 31 + kind.charCodeAt(i)) >>> 0;
  const hue = (h % 360) / 360;
  const c = Phaser.Display.Color.HSLToColor(hue, 0.6, 0.7);
  return c.color;
}
