// THE MAP TAB'S LAYER ROW — small chips above the minimap, one per thing the
// map can draw over it (maintainer 2026-09-10: "at the top of the Map tab ...
// small buttons that can be pressed to draw different things on the map. In
// the future this will be features like quests, dungeons, party members").
//
// It starts with the TECHNICAL layer, `zones`, so a boundary bug can be told
// apart from any other bug by looking: the rectangle each zone room owns, the
// band inside it where the neighbouring room mirrors you and the hand-off
// happens, and which zone you are standing in.
//
// INJECTED FROM OUTSIDE, because games-ui owns hud.ts (UI_AGENT.md) and this
// is the games agent's data. Same pattern the ambient agent's settings button
// uses (ambient/runtime/hudbutton.ts): find the page in the DOM, add to it,
// and re-add when the HudBar has thrown everything away — it rebuilds itself
// on a rejoin. `ensureMapLayers()` is idempotent and is polled from the scene.
//
// ADDING A LAYER is one entry in LAYERS: an id, a label, and a draw function
// handed the projection and an SVG to fill. Nothing else changes — the chip
// row, the persistence and the redraw are generic.
import { minimapCellPct, type MinimapFeed, type MinimapMeta, loadMinimapMeta } from "./maps";

const ROW_CLS = "ml-maplayers";
const SVG_CLS = "ml-maplayer-svg";
const MARK_CLS = "ml-maplayer-marks";
const KEY = "ml-map-layers"; // which layers are on, comma separated

/** What a layer gets: the live feed, the world→image projection (already in
 *  PERCENT of the image box, the same arithmetic the "you are here" dot uses)
 *  and the <svg> to draw into, whose viewBox is 0 0 100 100. */
export interface LayerCtx {
  feed: MinimapFeed;
  /** Cell (col,row) on the ground plane → [x%, y%]. */
  at: (col: number, row: number) => [number, number];
  svg: SVGSVGElement;
  el: (name: string, attrs: Record<string, string | number>) => SVGElement;
  /** A TEXT MARK, as HTML rather than <text>. The svg is stretched to the
   *  image box (`preserveAspectRatio="none"`) so its percent coordinates are
   *  exactly the dot's arithmetic — but that same stretch would scale glyphs
   *  anisotropically, and the zone numbers came out as unreadable smears. HTML
   *  positioned in percent is crisp at any box shape. */
  label: (col: number, row: number, text: string, strong?: boolean) => void;
}

interface Layer {
  id: string;
  label: string;
  /** A short line for the row's caption when the layer is on. */
  note?: string;
  draw: (ctx: LayerCtx) => void;
}

interface ZonesFeed {
  cols: number;
  rows: number;
  here: number;
  band: number;
  rects: { id: number; x0: number; y0: number; x1: number; y1: number }[];
}

type Ml = {
  minimap?: () => MinimapFeed | null;
  zones?: () => ZonesFeed | null;
};

const ml = (): Ml | undefined => (window as unknown as { __ml?: Ml }).__ml;

/** A world-space rectangle as an SVG path in image percent. Four projected
 *  corners, not a <rect>: the map is ISOMETRIC, so a rectangle of the world is
 *  a parallelogram on the image and an axis-aligned box would be a lie. */
function quad(ctx: LayerCtx, x0: number, y0: number, x1: number, y1: number): string {
  const p = [ctx.at(x0, y0), ctx.at(x1, y0), ctx.at(x1, y1), ctx.at(x0, y1)];
  return `M${p.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join("L")}Z`;
}

const LAYERS: Layer[] = [
  {
    id: "zones",
    label: "zones",
    note: "blue: one room per rectangle. red: the hand-off band",
    draw: (ctx) => {
      const z = ml()?.zones?.();
      if (!z) return;
      for (const r of z.rects) {
        const mine = r.id === z.here;
        ctx.svg.appendChild(
          ctx.el("path", {
            d: quad(ctx, r.x0, r.y0, r.x1, r.y1),
            // The spawn overlay's blue, the same as the in-world border.
            fill: mine ? "rgba(143,214,255,0.13)" : "none",
            stroke: mine ? "rgba(143,214,255,0.95)" : "rgba(255,255,255,0.5)",
            "stroke-width": mine ? 0.55 : 0.3,
            "vector-effect": "non-scaling-stroke",
          }),
        );
        // THE BAND, on my own zone only: drawing it on all sixteen would be a
        // hatch, and the question it answers ("am I near a border?") is about
        // where I am. Inset by `band` cells on every side. A RED LINE OVER A
        // RED FILL, the same pair the in-world overlay uses (settings "zone
        // borders", itself the spawn overlay's recipe hue-shifted), so the two
        // views read as one legend: blue rectangle = the room, red inside =
        // the core, between them = the hand-off band.
        if (mine && z.band > 0 && r.x1 - r.x0 > z.band * 2 && r.y1 - r.y0 > z.band * 2) {
          ctx.svg.appendChild(
            ctx.el("path", {
              d: quad(ctx, r.x0 + z.band, r.y0 + z.band, r.x1 - z.band, r.y1 - z.band),
              fill: "rgba(255,90,74,0.12)",
              stroke: "rgba(255,143,128,0.9)",
              "stroke-width": 0.4,
              "vector-effect": "non-scaling-stroke",
            }),
          );
        }
        // The id, at the rectangle's centre — the number the server logs and
        // `__ml.zone()` reports, so a report can name the room.
        ctx.label((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, String(r.id), mine);
      }
    },
  },
];

/* -- state ------------------------------------------------------------------ */

function readOn(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    return new Set(raw.split(",").filter((id) => LAYERS.some((l) => l.id === id)));
  } catch {
    return new Set(); // private mode / storage disabled
  }
}

function writeOn(on: Set<string>) {
  try {
    localStorage.setItem(KEY, [...on].join(","));
  } catch {}
}

const on = readOn();
let row: HTMLElement | null = null;
let svg: SVGSVGElement | null = null;
let marks: HTMLElement | null = null;
let caption: HTMLElement | null = null;
let sig = ""; // what the overlay was last drawn for
let metaFor = ""; // which world `meta` belongs to
let meta: MinimapMeta | null = null;

const svgEl = (name: string, attrs: Record<string, string | number>): SVGElement => {
  const e = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

function styleOnce() {
  if (document.getElementById("ml-maplayers-css")) return;
  const st = document.createElement("style");
  st.id = "ml-maplayers-css";
  // Chips ride the shared button recipe (.ml-plate-btn is a pure-CSS class the
  // HUD keeps for exactly this kind of injection), only smaller.
  st.textContent = `
  .${ROW_CLS}{display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:center;
    width:100%;padding:6px 8px 0;box-sizing:border-box}
  .${ROW_CLS} .ml-plate-btn{min-height:30px;padding:4px 10px;font-size:12px;border-radius:8px}
  .${ROW_CLS}-note{width:100%;text-align:center;font:500 11px/1.3 var(--sans);
    color:var(--ink-soft,#8b8b8b);padding:2px 8px 0;box-sizing:border-box;min-height:14px}
  /* CLIPPED TO THE IMAGE BOX, both of them. A zone rectangle covers water and
     the render is CROPPED to the island, so the outer zones project OUTSIDE
     the image — with overflow visible their lines and their numbers escaped
     the frame and floated over the game view (measured: zones 0 and 3 landed
     in the middle of the world). The frame is exactly the displayed image
     (fitMap), so clipping here is clipping to the map. */
  .${SVG_CLS}{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:hidden}
  .${MARK_CLS}{position:absolute;inset:0;pointer-events:none;overflow:hidden}
  .${MARK_CLS} b{position:absolute;transform:translate(-50%,-50%);white-space:nowrap;
    font:600 10px/1 var(--sans);color:rgba(255,255,255,0.62);
    text-shadow:0 1px 2px rgba(0,0,0,0.85)}
  .${MARK_CLS} b.on{font-weight:800;color:rgba(170,222,255,0.98)}`;
  document.head.appendChild(st);
}

function build(page: HTMLElement, frame: HTMLElement) {
  styleOnce();
  row = document.createElement("div");
  row.className = ROW_CLS;
  for (const l of LAYERS) {
    const b = document.createElement("button");
    b.className = "ml-plate-btn";
    b.type = "button";
    const t = document.createElement("span");
    t.textContent = l.label;
    b.appendChild(t);
    const paint = () => b.classList.toggle("on", on.has(l.id));
    b.addEventListener("click", () => {
      if (on.has(l.id)) on.delete(l.id);
      else on.add(l.id);
      writeOn(on);
      paint();
      sig = ""; // redraw now, not on the next move
      syncCaption();
    });
    paint();
    row.appendChild(b);
  }
  caption = document.createElement("div");
  caption.className = `${ROW_CLS}-note`;
  row.appendChild(caption);
  // ABOVE the map, which is what "at the top of the Map tab" means; the page's
  // first child is the .ml-map wrapper.
  page.insertBefore(row, page.firstChild);
  svg = svgEl("svg", { viewBox: "0 0 100 100", preserveAspectRatio: "none" }) as SVGSVGElement;
  svg.setAttribute("class", SVG_CLS);
  frame.appendChild(svg);
  marks = document.createElement("div");
  marks.className = MARK_CLS;
  frame.appendChild(marks);
  syncCaption();
}

function syncCaption() {
  if (!caption) return;
  const notes = LAYERS.filter((l) => on.has(l.id) && l.note).map((l) => l.note!);
  caption.textContent = notes.join(" · ");
}

/** Idempotent: keep one live chip row + overlay on the Map page, and redraw the
 *  active layers when anything they read has changed. Cheap enough to poll. */
export function ensureMapLayers() {
  const page = document.querySelector<HTMLElement>('.ml-page[data-page="map"]');
  const frame = page?.querySelector<HTMLElement>(".ml-map-frame");
  if (!page || !frame) return; // HUD not built yet — try again next poll
  if (!row?.isConnected || !svg?.isConnected || !marks?.isConnected || svg.parentElement !== frame) {
    row?.remove();
    svg?.remove();
    marks?.remove();
    build(page, frame);
  }
  if (!svg) return;
  // Only while the page is actually on screen: the row is in the DOM either
  // way, but projecting sixteen rectangles for a hidden page is waste.
  if (!page.offsetParent) return;
  const feed = ml()?.minimap?.();
  if (!feed || !feed.w || !feed.h) return;
  if (feed.world !== metaFor) {
    metaFor = feed.world;
    meta = null;
    const forWorld = feed.world;
    void loadMinimapMeta(forWorld).then((doc) => {
      if (metaFor === forWorld) {
        meta = doc;
        sig = "";
      }
    });
  }
  const z = on.has("zones") ? ml()?.zones?.() : null;
  const next = `${feed.world}|${[...on].join(",")}|${z ? `${z.here}:${z.cols}x${z.rows}` : ""}|${meta ? 1 : 0}`;
  if (next === sig) return;
  sig = next;
  svg.textContent = "";
  if (marks) marks.textContent = "";
  if (!on.size) return;
  const at = (col: number, row2: number) => minimapCellPct(feed, meta, col, row2, 0);
  const ctx: LayerCtx = {
    feed,
    at,
    svg,
    el: svgEl,
    label: (col, row2, text, strong) => {
      if (!marks) return;
      // CLAMPED INTO THE BOX. The render is cropped to the island, so an outer
      // zone's CENTRE can be out over open water and off the image; clipping
      // its number away loses the one thing that names the room. Each mark
      // belongs to one rectangle, so a number resting against the rim is
      // still unambiguous.
      const [px, py] = at(col, row2);
      const x = Math.max(3, Math.min(97, px));
      const y = Math.max(3, Math.min(97, py));
      const b = document.createElement("b");
      if (strong) b.className = "on";
      b.style.left = `${x.toFixed(3)}%`;
      b.style.top = `${y.toFixed(3)}%`;
      b.textContent = text;
      marks.appendChild(b);
    },
  };
  for (const l of LAYERS) if (on.has(l.id)) l.draw(ctx);
}

/** QA/probe: which layers are on; with an argument, set one. */
export function mapLayers(id?: string, want?: boolean): string[] {
  if (id && LAYERS.some((l) => l.id === id)) {
    const to = want === undefined ? !on.has(id) : want;
    if (to) on.add(id);
    else on.delete(id);
    writeOn(on);
    sig = "";
    ensureMapLayers();
    const b = row?.querySelectorAll<HTMLElement>(".ml-plate-btn")[LAYERS.findIndex((l) => l.id === id)];
    b?.classList.toggle("on", to);
    syncCaption();
  }
  return [...on];
}
