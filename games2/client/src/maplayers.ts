// THE MAP TAB'S LAYERS — things the map can draw over the minimap (maintainer
// 2026-09-10: "at the top of the Map tab ... small buttons that can be pressed
// to draw different things on the map. In the future this will be features
// like quests, dungeons, party members").
//
// ONE "layers" BUTTON AND A MULTI-SELECT DIALOG, not a chip per layer
// (maintainer 2026-09-18, with the ambient-zone layers coming — one per
// effect: "There will be so many pills so I think a multi-select dropdown or
// modal/dialog is better to select what ambient-effect zones to display. Just
// make the UX good!"). The button names the count of layers on; the dialog
// lists every offered layer in two groups — MAP (zones, dungeons) and AMBIENT
// ZONES (one row per effect maps2 has placed) — with all/none per group, and
// the map behind it redraws as you tick, so you see what you are choosing.
// A layer that has nothing behind it (`has`) is hidden, and a group with no
// rows is hidden with it.
//
// It started with the TECHNICAL layer, `zones`, so a boundary bug can be told
// apart from any other bug by looking: the rectangle each zone room owns, the
// band inside it where the neighbouring room mirrors you and the hand-off
// happens, and which zone you are standing in. `dungeons` is the first PLAYER
// layer: maps2's named caves, pinned from its own places.json.
//
// A CHIP IS OFFERED ONLY WHEN THERE IS SOMETHING BEHIND IT (`Layer.has`) — a
// world with no dungeons shows no dungeons button.
//
// INJECTED FROM OUTSIDE, because games-ui owns hud.ts (UI_AGENT.md); the
// zones/dungeons DATA is the games agent's, the chooser and the ambient-zones
// layer are games-ui's (2026-09-18). The pattern: find the page in the DOM,
// add to it, and re-add when the HudBar has thrown everything away — it rebuilds
// itself on a rejoin. `ensureMapLayers()` is idempotent and is polled from
// the scene.
//
// ADDING A LAYER is one entry in LAYERS: an id, a label, a group and a draw
// function handed the projection and an SVG to fill. Nothing else changes —
// the dialog, the persistence and the redraw are generic. The AMBIENT-ZONE
// layers are not entries at all: they are derived from maps2's
// ambient_zones.json (schema pixel-maps2/ambient-zones@1, proposed to maps2
// 2026-09-18: zones[{id, effect, pct, rects:[[x0,y0,x1,y1]…]}], world cells,
// x1/y1 exclusive like the zone rooms) — one layer per effect, drawn as
// parallelograms whose fill deepens with pct. Missing file = no group.
//
// NO EXPLAINING TEXT IN THE MAP VIEW (maintainer 2026-09-14: "I don't like the
// explaining text in the map view when toggling a pill/layer. Should be no
// explaining text at all"). A caption under the chips used to name each live
// layer's marks; it is gone, with the per-layer `note` that fed it. What a
// colour means belongs in the wiki or in a comment, not over the map he is
// trying to read.
import {
  minimapCellPct,
  type MinimapFeed,
  type MinimapMeta,
  type PlaceMark,
  loadMinimapMeta,
  loadPlaceMarks,
  worldFileUrl,
} from "./maps";
import { gameUrl } from "./staging";

const ROW_CLS = "ml-maplayers";
const OPEN_CLS = "ml-maplayer-open";
const PILL_CLS = "ml-maplayer-pill";
const SW_CLS = "ml-maplayer-sw";
const DLG_CLS = "ml-layers";
const SVG_CLS = "ml-maplayer-svg";
const MARK_CLS = "ml-maplayer-marks";
const PULSE_CLS = "ml-maplayer-pulse";
const KEY = "ml-map-layers"; // which layers are on, comma separated

/** What a layer gets: the live feed, the world→image projection (already in
 *  PERCENT of the image box, the same arithmetic the "you are here" dot uses)
 *  and the <svg> to draw into, whose viewBox is 0 0 100 100. */
export interface LayerCtx {
  feed: MinimapFeed;
  /** Cell (col,row) on the ground plane → [x%, y%]. */
  at: (col: number, row: number) => [number, number];
  /** Where this layer draws: its OWN <g> inside the overlay (data-layer=id),
   *  so one layer's marks can be found — and pulsed — without touching the
   *  others'. A layer only ever appends to it. */
  svg: SVGElement;
  el: (name: string, attrs: Record<string, string | number>) => SVGElement;
  /** A TEXT MARK, as HTML rather than <text>. The svg is stretched to the
   *  image box (`preserveAspectRatio="none"`) so its percent coordinates are
   *  exactly the dot's arithmetic — but that same stretch would scale glyphs
   *  anisotropically, and the zone numbers came out as unreadable smears. HTML
   *  positioned in percent is crisp at any box shape. */
  label: (col: number, row: number, text: string, strong?: boolean) => void;
  /** A PLACE PIN: a diamond at the cell — `text` names it in the DOM only,
   *  never on the map. HTML for the
   *  same reason `label` is — the svg is stretched to the image box, so a
   *  circle drawn in it comes out an ellipse and a square comes out a
   *  rectangle. The SHAPE is what separates a pin from the "you are here"
   *  dot (round, accent, 12px); colour alone would not.
   *  PROJECTED AT THE CELL'S OWN SURFACE LEVEL, not the ground plane: a door
   *  is a place you stand on, so it is placed the way the player is placed. */
  pin: (col: number, row: number, text: string) => void;
}

type LayerGroup = "map" | "ambient";
const GROUP_LABEL: Record<LayerGroup, string> = { map: "Map", ambient: "Ambient zones" };

/** What the map paints a layer in — the legend pill's whole content.
 *  `area` is a wash over ground, `pin` is a mark at a point; the SHAPE is
 *  what the swatch copies, because two layers can share a hue but never a
 *  shape, and shape survives a colour-blind eye and a 2-inch map (the same
 *  reason the place pin is a diamond and "you are here" is a disc). */
interface LayerMark {
  color: string;
  shape: "area" | "pin";
}

interface Layer {
  id: string;
  label: string;
  group: LayerGroup;
  /** THE ONE PLACE A LAYER'S COLOUR IS WRITTEN. `draw` reads it too (or the
   *  same constant), so the pill cannot drift from the map: a legend that
   *  names a colour the map does not paint is worse than no legend. */
  mark: () => LayerMark;
  /** Offer the chip only when there is something behind it. A world with no
   *  dungeons must not show a dungeons button that draws nothing — the same
   *  graceful-degradation rule the ambient checklist follows (no rows, no
   *  section). Absent = always offered. */
  has?: () => boolean;
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
  /** world.json's level[y][x] at a WORLD-unit point (cell x 32) */
  levelAt?: (x: number, y: number) => number;
};

const ml = (): Ml | undefined => (window as unknown as { __ml?: Ml }).__ml;

/** A world-space rectangle as an SVG path in image percent. Four projected
 *  corners, not a <rect>: the map is ISOMETRIC, so a rectangle of the world is
 *  a parallelogram on the image and an axis-aligned box would be a lie. */
function quad(ctx: LayerCtx, x0: number, y0: number, x1: number, y1: number): string {
  const p = [ctx.at(x0, y0), ctx.at(x1, y0), ctx.at(x1, y1), ctx.at(x0, y1)];
  return `M${p.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join("L")}Z`;
}

/* The two fixed layers' colours, written ONCE and read by both the draw and
   the legend. ZONE_LINE is the spawn overlay's blue — the same as the in-world
   border, so the map and the world read as one legend. PIN_FILL is the place
   pin's amber; the CSS below interpolates it rather than repeating it. */
const ZONE_LINE = "rgba(143,214,255,0.95)";
const PIN_FILL = "rgba(255,196,92,0.96)";

/** A world-space POLYGON as an SVG path in image percent — maps2's ambient
 *  areas are outlines, not boxes, so every point is projected. */
function poly(ctx: LayerCtx, pts: [number, number][]): string {
  return `M${pts.map(([cx, cy]) => { const [x, y] = ctx.at(cx, cy); return `${x.toFixed(3)},${y.toFixed(3)}`; }).join("L")}Z`;
}

const LAYERS: Layer[] = [
  {
    id: "zones",
    label: "zones",
    group: "map",
    // ITS OWN IDENTITY, not a palette slot: this layer is one blue wherever it
    // is drawn, in the world overlay as well (the palette above is measured
    // against it, so nothing else can be mistaken for it).
    mark: () => ({ color: ZONE_LINE, shape: "area" }),
    draw: (ctx) => {
      const z = ml()?.zones?.();
      if (!z) return;
      for (const r of z.rects) {
        const mine = r.id === z.here;
        ctx.svg.appendChild(
          ctx.el("path", {
            d: quad(ctx, r.x0, r.y0, r.x1, r.y1),
            // The spawn overlay's blue, the same as the in-world border —
            // ZONE_LINE, which the legend pill wears too.
            fill: mine ? "rgba(143,214,255,0.13)" : "none",
            stroke: mine ? ZONE_LINE : "rgba(255,255,255,0.5)",
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
  {
    // THE DUNGEONS LAYER (maintainer 2026-09-11, relaying the maps agent: the
    // map should "display/show all dungeons" once the caves being dug are
    // done). It reads maps2's OWN published names — places.json, schema
    // pixel-maps2/places@2, one place per named region with a kind — so the
    // map never guesses where a cave is or what it is called: a dungeon
    // appears here the moment maps2 ships it, and nothing on this side is
    // touched when the terrain moves.
    // Only `kind: "cave"`. Houses and summits are in the same file and are one
    // more entry each when he asks for them. The NAME is never drawn — see
    // `pin` — so this layer answers "where are they", not "which is which".
    id: "dungeons",
    label: "dungeons",
    group: "map",
    mark: () => ({ color: PIN_FILL, shape: "pin" }),
    has: () => caves().length > 0,
    draw: (ctx) => {
      for (const c of caves()) ctx.pin(c.at[0], c.at[1], c.name);
    },
  },
];

/* -- ambient zones (maps2's OWN ambient.json) -------------------------------- */

// THE FILE IS `ambient.json`, SCHEMA `pixel-maps3/ambient@1`, AND IT IS
// MAPS2'S, NOT A SHAPE WE ASKED FOR. The first version of this reader was
// written against `ambient_zones.json` — a schema proposed to maps2 on
// 2026-09-18 and never adopted — so it fetched a name nothing publishes, got a
// 404, and the Ambient zones group was silently absent in production while
// every gate passed against a fixture of the proposed shape (maintainer
// 2026-09-19: "THIS IS A CRITICAL BUG! I AM ON YOUR NEW VERSION AND IT DOESN'T
// COME UP!"). THE LESSON, and it is the repo's own rule in a new place: a
// consumer reads the producer's PUBLISHED file, and a fixture is a copy of
// that file — never of a proposal. The gate now asserts the real name and
// schema, so a reader pointed at a file nothing ships fails here.
//
// The real shape, per zone: an id, a NAME and a KIND (sea, marsh, town, cave,
// … and one `world` zone covering everything), the `area` as a CLOSED POLYGON
// of world cells — not rectangles; the coastlines run to 830 points — the
// `cells` it covers, and `effects` as a MAP of effect name -> percent. So one
// zone carries many effects, which is why a layer per effect is derived across
// all of them rather than read off one field.
interface AmbientZone {
  id: string;
  name: string;
  kind: string;
  /** Closed polygon, world cells. */
  area: [number, number][];
  /** Cells covered — the draw order, biggest first, so a small zone stays
   *  visible on top of the province it sits in. */
  cells: number;
  /** effect name -> how often it is active here, 0–100. */
  effects: Record<string, number>;
}

/** maps2's ambient zones for a world, or [] when the file is missing or
 *  malformed (a bad entry is dropped, never thrown — no zones, no group). */
async function loadAmbientZones(world: string): Promise<AmbientZone[]> {
  try {
    const res = await fetch(gameUrl(worldFileUrl(world, "ambient.json")));
    if (!res.ok) return [];
    const doc = (await res.json()) as { zones?: unknown };
    if (!Array.isArray(doc.zones)) return [];
    const out: AmbientZone[] = [];
    for (const z of doc.zones as Record<string, unknown>[]) {
      if (!z || typeof z !== "object") continue;
      const area = (Array.isArray(z.area) ? z.area : [])
        .filter((p): p is number[] => Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number")
        .map((p) => [p[0], p[1]] as [number, number]);
      if (area.length < 3) continue; // not an area
      const effects: Record<string, number> = {};
      const raw = z.effects as Record<string, unknown> | undefined;
      if (raw && typeof raw === "object")
        for (const [k, v] of Object.entries(raw))
          if (typeof v === "number") effects[k] = Math.max(0, Math.min(100, v));
      if (!Object.keys(effects).length) continue; // a zone with no effects draws nothing
      out.push({
        id: typeof z.id === "string" ? z.id : `zone-${out.length}`,
        name: typeof z.name === "string" ? z.name : "",
        kind: typeof z.kind === "string" ? z.kind : "",
        area,
        cells: typeof z.cells === "number" ? z.cells : area.length,
        effects,
      });
    }
    // biggest first: the world zone and the provinces lie UNDER the meadows
    // and towns inside them, which is the only order that reads.
    return out.sort((a, b) => b.cells - a.cells);
  } catch {
    return [];
  }
}

/** AT MOST TEN LAYERS AT ONCE (maintainer 2026-09-19: "You can also add a max
 *  10 layers limit so you don't need to come up with too many different
 *  colors"). It is a PALETTE limit stated as a feature limit, and it is the
 *  right way round: ten washes over one small map is already the most anyone
 *  can read, and it retires a generated colour wheel for ten colours chosen by
 *  hand. */
const MAX_ON = 10;

/** THE TEN. Okabe–Ito's colour-blind-safe set (minus its yellow, which sat too
 *  near the dungeons amber) plus four picked to maximise the smallest gap.
 *  MEASURED: no two are closer than 67 in RGB, and that holds against the two
 *  FIXED marks as well — the zones blue and the dungeons amber — so nothing on
 *  this map can be confused with anything else on it. (The generated wheel
 *  this replaces managed 45 at best, and its first version put `ants` and
 *  `thunder` on the identical pixel value across maps2's 32 effects.) */
const PALETTE = [
  "#E69F00", // orange
  "#56B4E9", // sky
  "#009E73", // green
  "#0072B2", // blue
  "#D55E00", // vermillion
  "#CC79A7", // orchid
  "#6806E0", // violet
  "#5DE006", // lime
  "#E00668", // magenta
  "#70EB7C", // mint
];

/** Which colour each ON layer holds. A layer takes the lowest FREE slot when
 *  it is switched on and gives it back when it is switched off, so the other
 *  layers keep their colours while you add and remove — assigning by position
 *  in the list instead would re-colour the whole legend every time one is
 *  turned off, which is the one thing a legend must not do. */
const held = new Map<string, string>();

function takeColor(id: string): string {
  const existing = held.get(id);
  if (existing) return existing;
  const used = new Set(held.values());
  const free = PALETTE.find((c) => !used.has(c)) ?? PALETTE[held.size % PALETTE.length];
  held.set(id, free);
  return free;
}
const dropColor = (id: string) => held.delete(id);
/** The colour this layer is drawn and labelled in, or "" while it is off —
 *  a colour is only meaningful once something is wearing it. */
const heldColor = (id: string): string => held.get(id) ?? "";

let ambientFor = ""; // which world `ambientZones` belongs to
let ambientZones: AmbientZone[] = [];
let ambientLayerCache: { key: string; layers: Layer[] } = { key: "", layers: [] };

/** One layer per effect maps2 has placed, in first-seen order. Derived (and
 *  memoised) from the loaded zones, so the dialog and the redraw see new
 *  effects the moment the file lands. */
function ambientLayers(): Layer[] {
  // ALPHABETICAL, not first-seen: there are 32 of them and the question is
  // always "where is snow?", which is a lookup, not a tour.
  const effects = [...new Set(ambientZones.flatMap((z) => Object.keys(z.effects)))].sort();
  const key = effects.join(",");
  if (key === ambientLayerCache.key) return ambientLayerCache.layers;
  const layers = effects.map<Layer>((effect) => ({
    id: `ambient:${effect}`,
    label: effect,
    group: "ambient",
    // The pill wears the colour at full strength; the map varies only the
    // ALPHA with pct, so the two are the same colour by construction. An
    // effect that is OFF holds no colour — see `held`.
    mark: () => ({ color: heldColor(`ambient:${effect}`), shape: "area" }),
    has: () => ambientZones.some((z) => effect in z.effects),
    draw: (ctx) => {
      const color = heldColor(`ambient:${effect}`) || PALETTE[0];
      // `ambientZones` is sorted biggest-first, so a small place draws over
      // a large one rather than under it.
      for (const z of ambientZones) {
        const pct = z.effects[effect];
        if (pct === undefined) continue;
        // A DOOR IS NOT DRAWN. maps2's zones (2026-09-19) leave a "door" of
        // half a percent open on nearly every place — snow on the meadow,
        // once in two hundred windows — so painting every share put a faint
        // snow wash over the whole sea and most of the island, and "where is
        // snow?" had no answer. The map answers where an effect LIVES: the
        // place's signature (a wash) and its supports (a tint).
        if (pct < 1) continue;
        // The fill DEEPENS with how often the effect is active here: a
        // signature at 90 reads as a wash, a support at 10 as a tint — the
        // share is on the map without a number over it (no text over the
        // map, the law above).
        const alpha = 0.1 + 0.35 * (pct / 100);
        ctx.svg.appendChild(
          ctx.el("path", {
            d: poly(ctx, z.area),
            fill: color,
            "fill-opacity": alpha.toFixed(3),
            stroke: color,
            "stroke-opacity": 0.9,
            "stroke-width": 0.35,
            "vector-effect": "non-scaling-stroke",
          }),
        );
      }
    },
  }));
  ambientLayerCache = { key, layers };
  return layers;
}

/** Every layer that exists right now: the fixed ones, then the ambient ones. */
const allLayers = (): Layer[] => [...LAYERS, ...ambientLayers()];

/* -- state ------------------------------------------------------------------ */

function readOn(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    // Ids are kept even when their layer is not loaded YET (the ambient ones
    // arrive with the world's file); an id nothing answers to simply draws
    // nothing and is not offered.
    return new Set(raw ? raw.split(",").filter(Boolean) : []);
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
let sig = ""; // what the overlay was last drawn for
let metaFor = ""; // which world `meta` belongs to
let meta: MinimapMeta | null = null;
let placesFor = ""; // which world `places` belongs to
let places: PlaceMark[] = [];
let openBtn: HTMLButtonElement | null = null;
let dialog: HTMLElement | null = null;

/** The named caves of the loaded world, in the order maps2 published them. */
const caves = (): PlaceMark[] => places.filter((p) => p.kind === "cave");

/** The legend swatch: the layer's own colour in the layer's own shape. */
function swatch(m: LayerMark): HTMLElement {
  const sw = document.createElement("span");
  sw.className = m.shape === "pin" ? `${SW_CLS} pin` : SW_CLS;
  sw.style.background = m.color;
  sw.setAttribute("aria-hidden", "true");
  return sw;
}

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
  .${ROW_CLS}{display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:flex-start;
    width:100%;padding:6px 8px 0;box-sizing:border-box}
  /* THE CHOOSER IS A GLYPH IN THE CORNER (maintainer 2026-09-19: "The 'layers
     X' button can just be a small ⧉ icon at the bottom right corner in order
     to save space"). The count went with the words and is no loss: the pills
     beside it ARE the count, and they say which. A margin-left:auto on the
     LAST item of a wrapping row puts it at the right end of whatever line it
     lands on — so the pills fill from the top-left and the button ends the
     flow in the bottom-right corner, which is what he asked for. */
  .${ROW_CLS} .${OPEN_CLS}{margin-left:auto;min-height:30px;width:30px;padding:0;
    font-size:15px;line-height:1;border-radius:8px;flex:none}
  /* THE LEGEND PILLS — one per layer that is ON, and only those (maintainer
     2026-09-19: "Once something has been selected here I still think we
     should have a pill for it so the user can see what color correspond to
     what layer … so we don't have to [show] every ambient effect as a pill
     for all users all the time"). Lighter than the button that opens the
     chooser: the button is the control, these are the KEY to the picture.
     Each is also its own off switch, which is the gesture the pills had
     before the dialog existed. */
  .${ROW_CLS} .${PILL_CLS}{display:inline-flex;align-items:center;gap:6px;
    min-height:26px;padding:3px 9px 3px 7px;border-radius:999px;
    background:var(--surface-2);border:1px solid var(--border);color:var(--muted);
    font:600 11px/1.2 var(--sans);cursor:pointer;-webkit-tap-highlight-color:transparent}
  .${ROW_CLS} .${PILL_CLS}:active{transform:translateY(1px)}
  /* THE SWATCH IS THE POINT: the colour AND the shape the map draws, so the
     pill answers "what is that wash?" and "what is that diamond?" alike. */
  .${SW_CLS}{width:11px;height:11px;flex:none;border-radius:3px;
    box-shadow:0 0 0 1px rgba(0,0,0,.45)}
  .${SW_CLS}.pin{width:9px;height:9px;border-radius:2px;transform:rotate(45deg)}
  /* THE CHOOSER: the drop-quantity dialog's recipe (hud.ts .ml-qty) — a
     blurred backdrop over everything and a wiki card, centred; the card
     scrolls when the ambient list outgrows a phone. Rows are the Settings
     checklist's own recipe (.ml-plate-btn + .ml-amb-check), so ticking a
     layer here looks exactly like ticking an effect there. */
  .${DLG_CLS}-back{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.5);
    backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
  /* A HEIGHT THAT LOOKS GOOD, NOT THE TALLEST THE SCREEN ALLOWS (maintainer
     2026-09-19: "the dialog should not be able to grow that insanely tall.
     The user can scroll. Use a height that looks good instead"): the card
     stops at 560px or two thirds of the screen, whichever is less, and the
     LIST scrolls inside it under a fixed title and above a fixed Done — the
     way out never scrolls away. */
  .${DLG_CLS}{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
    width:min(400px,calc(100vw - 32px));max-height:min(560px,calc(100dvh - 96px));
    box-sizing:border-box;display:flex;flex-direction:column;padding:0;overflow:hidden;
    background:var(--bg);color:var(--ink);border:1px solid var(--border);border-radius:14px;
    box-shadow:var(--shadow);font:14px/1.45 var(--sans)}
  .${DLG_CLS} *{box-sizing:border-box}
  .${DLG_CLS}-title{display:flex;align-items:baseline;justify-content:space-between;gap:12px;
    padding:14px 16px 10px;border-bottom:1px solid var(--border);flex:none}
  .${DLG_CLS}-title b{font:700 16px/1.2 var(--sans);letter-spacing:.01em}
  .${DLG_CLS}-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;
    display:flex;flex-direction:column;gap:8px;padding:10px 16px 12px;
    box-shadow:inset 0 -14px 12px -12px rgba(0,0,0,.22)}
  .${DLG_CLS}-foot{flex:none;padding:10px 16px 14px;border-top:1px solid var(--border)}
  /* TWO COLUMNS: thirty-odd effects at one per line was a list you scrolled
     through; two abreast is a table you scan (maintainer 2026-09-19: "Maybe
     ambient zones can be displayed in two columns?"). Names are short, so
     each cell keeps the whole row recipe — box, swatch, name. */
  .${DLG_CLS}-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  /* SECTIONS LIKE SETTINGS' (maintainer 2026-09-19: "You can have sections in
     the dialog similar to the sections under settings"): the rule above the
     heading is the whole recipe — .ml-amb-title in hud.ts is border-top +
     12px + uppercase muted small-caps, and this is that, minus the rule on
     the FIRST section, where a line under the card's own edge is noise. */
  .${DLG_CLS}-h{display:flex;align-items:center;gap:6px;
    border-top:1px solid var(--border);margin-top:6px;padding-top:12px;
    color:var(--muted);font:600 12px/1.2 var(--sans);letter-spacing:.08em;text-transform:uppercase}
  .${DLG_CLS}-body .${DLG_CLS}-h:first-child{border-top:none;margin-top:0;padding-top:2px}
  .${DLG_CLS}-h .ml-plate-btn{min-height:26px;padding:2px 9px;font-size:11px;border-radius:7px;
    text-transform:none;letter-spacing:0;font-weight:600}
  .${DLG_CLS}-h .ml-plate-btn:first-of-type{margin-left:auto}
  .${DLG_CLS} .ml-layer-row{justify-content:flex-start;gap:9px;text-align:left;white-space:nowrap;
    min-height:40px;padding:6px 10px;min-width:0}
  .${DLG_CLS} .ml-layer-row>span:last-child{overflow:hidden;text-overflow:ellipsis;min-width:0}
  /* the same swatch as the pill, so you can pick by colour in here and then
     read that colour off the map without a second legend to learn */
  .${DLG_CLS} .${SW_CLS}{margin-left:2px}
  .${DLG_CLS}-done{margin:0;width:100%}
  /* the cap, in the title's right-hand slot — quiet until it bites, then it
     is the line that explains why the next tap does nothing */
  .${DLG_CLS}-cap{color:var(--muted);font:600 11px/1.3 var(--sans);text-align:right}
  .${DLG_CLS}-cap.full{color:var(--accent-ink)}
  /* THE PULSE: four beats of the layer's own marks (and its pill), then
     exactly as before. Opacity, so a wash blinks and a pin blinks alike. */
  @keyframes ml-maplayer-pulse{0%,100%{opacity:1}50%{opacity:.12}}
  @keyframes ml-maplayer-ring{0%,100%{box-shadow:0 0 0 0 transparent}50%{box-shadow:0 0 0 3px var(--accent)}}
  .${PULSE_CLS}{animation:ml-maplayer-pulse .55s ease-in-out 4}
  .${PILL_CLS}.${PULSE_CLS}{animation:ml-maplayer-ring .55s ease-in-out 4}
  @media (prefers-reduced-motion: reduce){
    .${PULSE_CLS}{animation:ml-maplayer-pulse 1.6s ease-in-out 1}
    .${PILL_CLS}.${PULSE_CLS}{animation:ml-maplayer-ring 1.6s ease-in-out 1}}
  /* a row that cannot be turned on while the cap is reached */
  .${DLG_CLS} .ml-layer-row.blocked{opacity:.45;cursor:default}
  /* a layer that is OFF holds no colour yet — an outline, not a wrong colour */
  .${SW_CLS}.empty{background:transparent;box-shadow:none;
    border:1px dashed var(--border-strong)}
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
  .${MARK_CLS} b.on{font-weight:800;color:rgba(170,222,255,0.98)}
  /* A PLACE PIN: a diamond, because the "you are here" dot is a round accent
     disc and shape is the only difference that survives a colour-blind eye
     and a 2-inch map. Zero-size anchor so the inherited translate(-50%,-50%)
     is a no-op and the children position off the exact cell. */
  .${MARK_CLS} b.pin{width:0;height:0}
  .${MARK_CLS} b.pin s{position:absolute;left:-5px;top:-5px;width:10px;height:10px;
    box-sizing:border-box;transform:rotate(45deg);background:${PIN_FILL};
    border:1.5px solid rgba(0,0,0,0.8);box-shadow:0 0 0 1px rgba(255,255,255,0.35)}
  .${MARK_CLS} b.pin s{text-decoration:none}`;
  document.head.appendChild(st);
}

/** How many layers may still be switched on. */
const roomLeft = (): number => Math.max(0, MAX_ON - offered().filter((l) => on.has(l.id)).length);

/**
 * Flip one layer and redraw now, not on the next move. Returns whether the
 * layer ENDED UP on — a request to switch on the eleventh is refused (MAX_ON),
 * and the caller repaints from the answer rather than from what it asked for.
 */
function setLayer(id: string, want: boolean): boolean {
  if (want) {
    if (!on.has(id) && roomLeft() <= 0) return false;
    on.add(id);
    // Only the AMBIENT layers draw from the palette — zones and dungeons carry
    // their own identities, so they must not burn a slot they never wear.
    if (id.startsWith("ambient:")) takeColor(id);
  } else {
    on.delete(id);
    dropColor(id);
  }
  writeOn(on);
  sig = "";
  syncButton();
  return on.has(id);
}

/** One layer's mark, by id — the dialog reads it for the fixed layers, whose
 *  colour is their own rather than the palette's. */
const markOf = (id: string): LayerMark | undefined => allLayers().find((l) => l.id === id)?.mark();

/** The layers the dialog offers: every layer whose `has` says there is
 *  something behind it, in group order. */
const offered = (): Layer[] => allLayers().filter((l) => (l.has ? l.has() : true));

function closeDialog() {
  dialog?.remove();
  dialog = null;
}

/** THE CHOOSER. Rebuilt on every open from what exists right now, so an
 *  ambient file that landed since the last open is simply there. Ticks apply
 *  immediately (the map behind the backdrop redraws); the backdrop, Escape
 *  and Done close it. */
function openDialog() {
  closeDialog();
  const back = document.createElement("div");
  back.className = `${DLG_CLS}-back`;
  const card = document.createElement("div");
  card.className = DLG_CLS;
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Map layers");
  const rows: { id: string; btn: HTMLButtonElement; box: HTMLElement; sw: HTMLElement }[] = [];
  const cap = document.createElement("div");
  cap.className = `${DLG_CLS}-cap`;
  const title = document.createElement("div");
  title.className = `${DLG_CLS}-title`;
  const tb = document.createElement("b");
  tb.textContent = "Map layers";
  title.append(tb, cap);
  card.appendChild(title);
  const body = document.createElement("div");
  body.className = `${DLG_CLS}-body`;
  card.appendChild(body);
  const paint = () => {
    const left = roomLeft();
    for (const r of rows) {
      const isOn = on.has(r.id);
      r.btn.classList.toggle("on", isOn);
      r.box.classList.toggle("on", isOn);
      // AT THE CAP, what you cannot turn on SAYS SO rather than ignoring the
      // tap — a row that swallows a press reads as a broken row.
      const blocked = !isOn && left <= 0;
      r.btn.classList.toggle("blocked", blocked);
      r.btn.disabled = blocked;
      // the swatch is the colour it actually holds; empty while it is off
      const c = r.id.startsWith("ambient:") ? heldColor(r.id) : markOf(r.id)?.color ?? "";
      r.sw.style.background = c || "transparent";
      r.sw.classList.toggle("empty", !c);
    }
    cap.textContent = left > 0 ? `${MAX_ON - left} of ${MAX_ON}` : `${MAX_ON} of ${MAX_ON} — turn one off to add another`;
    cap.classList.toggle("full", left <= 0);
  };
  const groups: LayerGroup[] = ["map", "ambient"];
  for (const g of groups) {
    const layers = offered().filter((l) => l.group === g);
    if (!layers.length) continue;
    const h = document.createElement("div");
    h.className = `${DLG_CLS}-h`;
    const name = document.createElement("span");
    name.textContent = GROUP_LABEL[g];
    h.appendChild(name);
    // all / none per group — with a dozen ambient effects, one tap each way
    for (const [label, want] of [
      ["all", true],
      ["none", false],
    ] as const) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ml-plate-btn";
      b.textContent = label;
      b.addEventListener("click", () => {
        // "all" fills UP TO the cap and then stops, in the order shown — it is
        // a convenience, never a way past the limit.
        for (const l of layers) if (!setLayer(l.id, want) && want) break;
        paint();
        ensureMapLayers();
      });
      h.appendChild(b);
    }
    body.appendChild(h);
    const grid = document.createElement("div");
    grid.className = `${DLG_CLS}-grid`;
    body.appendChild(grid);
    for (const l of layers) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ml-plate-btn ml-layer-row";
      btn.dataset.layer = l.id;
      const box = document.createElement("span");
      box.className = "ml-amb-check";
      box.setAttribute("aria-hidden", "true");
      const t = document.createElement("span");
      t.textContent = l.label;
      const sw = swatch(l.mark());
      btn.append(box, sw, t);
      btn.addEventListener("click", () => {
        setLayer(l.id, !on.has(l.id));
        paint();
        ensureMapLayers();
      });
      grid.appendChild(btn);
      rows.push({ id: l.id, btn, box, sw });
    }
  }
  const foot = document.createElement("div");
  foot.className = `${DLG_CLS}-foot`;
  const done = document.createElement("button");
  done.type = "button";
  done.className = `ml-plate-btn ${DLG_CLS}-done`;
  done.textContent = "Done";
  done.addEventListener("click", closeDialog);
  foot.appendChild(done);
  card.appendChild(foot);
  back.appendChild(card);
  back.addEventListener("click", (e) => {
    if (e.target === back) closeDialog();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      closeDialog();
      window.removeEventListener("keydown", onKey);
    }
  };
  window.addEventListener("keydown", onKey);
  paint();
  document.body.appendChild(back);
  dialog = back;
}

function build(page: HTMLElement, frame: HTMLElement) {
  styleOnce();
  row = document.createElement("div");
  row.className = ROW_CLS;
  openBtn = document.createElement("button");
  openBtn.className = `ml-plate-btn ${OPEN_CLS}`;
  openBtn.type = "button";
  openBtn.addEventListener("click", openDialog);
  row.appendChild(openBtn);
  // ABOVE the map, which is what "at the top of the Map tab" means; the page's
  // first child is the .ml-map wrapper.
  page.insertBefore(row, page.firstChild);
  svg = svgEl("svg", { viewBox: "0 0 100 100", preserveAspectRatio: "none" }) as SVGSVGElement;
  svg.setAttribute("class", SVG_CLS);
  frame.appendChild(svg);
  marks = document.createElement("div");
  marks.className = MARK_CLS;
  frame.appendChild(marks);
  syncButton();
}

/** The button names how many OFFERED layers are on ("layers · 2"), so the
 *  state is readable without opening the dialog; an id nothing answers to
 *  (an ambient layer of a world that has none) is not counted. Then the
 *  LEGEND: one pill per layer that is on, in the chooser's own order, each
 *  wearing the colour and shape the map paints it in. Rebuilt from `offered()`
 *  every time, so a layer whose data has gone (a world without dungeons)
 *  takes its pill with it and an ambient file that just landed brings one. */
function syncButton() {
  if (!openBtn || !row) return;
  const live = offered().filter((l) => on.has(l.id));
  // ⧉ — "overlapping pages", the one glyph for layers. It carries no count:
  // the pills beside it are the count, and they say WHICH.
  openBtn.textContent = "⧉";
  openBtn.title = openBtn.ariaLabel = live.length ? `Choose layers (${live.length} on)` : "Choose layers";
  openBtn.classList.toggle("on", live.length > 0);
  for (const old of row.querySelectorAll(`.${PILL_CLS}`)) old.remove();
  for (const l of live) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = PILL_CLS;
    pill.dataset.layer = l.id;
    // A TAP FINDS THE LAYER ON THE MAP (maintainer 2026-09-19: "If I go to
    // the map-tab and press on a pill - I want that area to pulsate in order
    // for me to find it better. I don't want to remove it. To remove it I
    // will use the dialog."): the layer's marks and the pill itself pulse
    // together, four beats, and nothing changes state. The pill was its own
    // off switch before, which made the one gesture a legend invites — "which
    // one is this?" — the one that destroyed what you were asking about.
    pill.title = `find ${l.label} on the map`;
    pill.setAttribute("aria-label", `find ${l.label} on the map`);
    const name = document.createElement("span");
    name.textContent = l.label;
    pill.append(swatch(l.mark()), name);
    pill.addEventListener("click", () => pulseLayer(l.id));
    row.appendChild(pill);
  }
  row.appendChild(openBtn); // last child = bottom-right (margin-left:auto)
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
    closeDialog();
    build(page, frame);
  }
  if (!svg) return;
  // Only while the page is actually on screen: the row is in the DOM either
  // way, but projecting sixteen rectangles for a hidden page is waste.
  if (!page.offsetParent) return;
  const feed = ml()?.minimap?.();
  if (!feed || !feed.w || !feed.h) return;
  if (feed.world !== placesFor) {
    placesFor = feed.world;
    places = [];
    const forWorld = feed.world;
    void loadPlaceMarks(forWorld).then((list) => {
      if (placesFor === forWorld) {
        places = list;
        sig = "";
        syncButton();
      }
    });
  }
  if (feed.world !== ambientFor) {
    ambientFor = feed.world;
    ambientZones = [];
    const forWorld = feed.world;
    void loadAmbientZones(forWorld).then((list) => {
      if (ambientFor === forWorld) {
        ambientZones = list;
        sig = "";
        syncButton();
      }
    });
  }
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
  const next = `${feed.world}|${[...on].join(",")}|${z ? `${z.here}:${z.cols}x${z.rows}` : ""}|${meta ? 1 : 0}|${places.length}|${ambientZones.length}`;
  if (next === sig) return;
  sig = next;
  svg.textContent = "";
  if (marks) marks.textContent = "";
  if (!on.size) return;
  const at = (col: number, row2: number) => minimapCellPct(feed, meta, col, row2, 0);
  let drawing = ""; // the layer whose marks are being made — every mark carries it
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
      b.dataset.layer = drawing;
      b.style.left = `${x.toFixed(3)}%`;
      b.style.top = `${y.toFixed(3)}%`;
      b.textContent = text;
      marks.appendChild(b);
    },
    pin: (col, row2, text) => {
      if (!marks) return;
      // THE LEVEL IS NOT OPTIONAL FOR A PIN (maintainer 2026-09-12, at cave
      // mouths marked below their doors: "you should of course mark the
      // entrance and not the center"). maps2's projection is
      // py = ky*(x+y) - kz*level + y0, and kz is 1.05px per storey on this
      // render: a mouth 30 levels up the massif drawn at level 0 lands 32px
      // low on a 478px image — 6.6% of the frame, out on the snowfield below
      // the hole. `at()` is the GROUND plane, which is what a flat overlay
      // like the zone grid wants; a door is a surface you stand on, so it is
      // projected exactly the way the player's own dot is.
      const lvl = ml()?.levelAt?.((col + 0.5) * 32, (row2 + 0.5) * 32) ?? 0;
      const [px, py] = minimapCellPct(feed, meta, col, row2, lvl);
      // NOT clamped like a label: a pin is a claim about WHERE something is,
      // and dragging one to the rim would put a dungeon on a coastline it is
      // nowhere near. A place outside the cropped image is simply not drawn.
      if (px < 0 || px > 100 || py < 0 || py > 100) return;
      const b = document.createElement("b");
      b.className = "pin";
      b.dataset.layer = drawing;
      b.style.left = `${px.toFixed(3)}%`;
      b.style.top = `${py.toFixed(3)}%`;
      // THE MARK IS THE WHOLE PIN — NO TEXT OVER THE MAP (maintainer
      // 2026-09-12: "when I want to see dungeons on the minimap I don't want
      // any text over the dungeons. The dungeons should not have a name (just
      // icon is enough)"). The map is ~300px wide on a phone and nine caves
      // sit in one massif, so names were half-dropped for overlap anyway and
      // the ones that survived covered the island he was reading. The name
      // still rides the element as data, not ink: it is what the gate finds a
      // pin by, and what a future tap-a-pin would open.
      b.dataset.pin = text;
      b.dataset.cell = `${col},${row2}`;
      b.appendChild(document.createElement("s"));
      marks.appendChild(b);
    },
  };
  for (const l of allLayers()) {
    if (!on.has(l.id)) continue;
    // ONE <g> PER LAYER, so a layer's marks can be pulsed as one thing.
    const g = svgEl("g", { "data-layer": l.id });
    svg.appendChild(g);
    drawing = l.id;
    l.draw({ ...ctx, svg: g });
    drawing = "";
  }
}

/** PULSE ONE LAYER — its wash or pins on the map and its own pill, four
 *  beats, then exactly as before. Restarted on a second tap (the class comes
 *  off and back on across a forced layout), so tapping twice finds it twice. */
function pulseLayer(id: string) {
  const sel = `[data-layer="${id}"]`;
  const targets: Element[] = [
    ...(svg?.querySelectorAll(sel) ?? []),
    ...(marks?.querySelectorAll(sel) ?? []),
    ...(row?.querySelectorAll(`.${PILL_CLS}${sel}`) ?? []),
  ];
  for (const t of targets) {
    t.classList.remove(PULSE_CLS);
    void (t as HTMLElement).offsetWidth;
    t.classList.add(PULSE_CLS);
    t.addEventListener("animationend", () => t.classList.remove(PULSE_CLS), { once: true });
  }
}

/** QA/probe: which layers are on; with an argument, set one. */
export function mapLayers(id?: string, want?: boolean): string[] {
  if (id && allLayers().some((l) => l.id === id)) {
    setLayer(id, want === undefined ? !on.has(id) : want);
    ensureMapLayers();
  }
  return [...on];
}

/** QA/probe: the layers the chooser offers right now (id, group, on). */
export function mapLayerList(): { id: string; group: LayerGroup; on: boolean }[] {
  return offered().map((l) => ({ id: l.id, group: l.group, on: on.has(l.id) }));
}

// The probe surface this module OWNS — `window.__ml.mapLayers` is the scene's
// wiring (games agent) and stays; the chooser's own list/set/open live here,
// the way ambient publishes __mlAmbient and the select screen __mlSelect.
(window as unknown as { __mlMapLayers?: unknown }).__mlMapLayers = {
  list: mapLayerList,
  set: mapLayers,
  open: () => openDialog(),
  close: () => closeDialog(),
};
