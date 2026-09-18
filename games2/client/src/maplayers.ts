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
// layer are games-ui's (2026-09-18). Same pattern the ambient agent's settings
// button uses (ambient/runtime/hudbutton.ts): find the page in the DOM, add to
// it, and re-add when the HudBar has thrown everything away — it rebuilds
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
const DLG_CLS = "ml-layers";
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

interface Layer {
  id: string;
  label: string;
  group: LayerGroup;
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

const LAYERS: Layer[] = [
  {
    id: "zones",
    label: "zones",
    group: "map",
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
    has: () => caves().length > 0,
    draw: (ctx) => {
      for (const c of caves()) ctx.pin(c.at[0], c.at[1], c.name);
    },
  },
];

/* -- ambient zones (maps2's ambient_zones.json) ----------------------------- */

interface AmbientZone {
  id: string;
  effect: string;
  /** How often the effect is active here, 0–100; 100 = always. */
  pct: number;
  /** World-cell rectangles, x1/y1 exclusive. */
  rects: [number, number, number, number][];
}

/** maps2's placed ambient zones for a world, or [] when the file is not
 *  published yet (or malformed — a bad entry is dropped, never thrown). */
async function loadAmbientZones(world: string): Promise<AmbientZone[]> {
  try {
    const res = await fetch(gameUrl(worldFileUrl(world, "ambient_zones.json")));
    if (!res.ok) return [];
    const doc = (await res.json()) as { zones?: unknown };
    if (!Array.isArray(doc.zones)) return [];
    const out: AmbientZone[] = [];
    for (const z of doc.zones as Record<string, unknown>[]) {
      if (!z || typeof z.effect !== "string") continue;
      const rects = (Array.isArray(z.rects) ? z.rects : [])
        .filter((r): r is number[] => Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === "number"))
        .map((r) => [r[0], r[1], r[2], r[3]] as [number, number, number, number]);
      if (!rects.length) continue;
      const pct = typeof z.pct === "number" ? Math.max(0, Math.min(100, z.pct)) : 100;
      out.push({ id: typeof z.id === "string" ? z.id : `${z.effect}-${out.length}`, effect: z.effect, pct, rects });
    }
    return out;
  } catch {
    return [];
  }
}

/** A stable hue per effect name, so "rain" is the same colour every visit
 *  and two effects sharing a coast read apart. */
function effectHue(effect: string): number {
  let h = 0;
  for (let i = 0; i < effect.length; i++) h = (h * 31 + effect.charCodeAt(i)) >>> 0;
  return h % 360;
}

let ambientFor = ""; // which world `ambientZones` belongs to
let ambientZones: AmbientZone[] = [];
let ambientLayerCache: { key: string; layers: Layer[] } = { key: "", layers: [] };

/** One layer per effect maps2 has placed, in first-seen order. Derived (and
 *  memoised) from the loaded zones, so the dialog and the redraw see new
 *  effects the moment the file lands. */
function ambientLayers(): Layer[] {
  const key = ambientZones.map((z) => z.effect).join(",");
  if (key === ambientLayerCache.key) return ambientLayerCache.layers;
  const effects = [...new Set(ambientZones.map((z) => z.effect))];
  const layers = effects.map<Layer>((effect) => ({
    id: `ambient:${effect}`,
    label: effect,
    group: "ambient",
    has: () => ambientZones.some((z) => z.effect === effect),
    draw: (ctx) => {
      const hue = effectHue(effect);
      for (const z of ambientZones) {
        if (z.effect !== effect) continue;
        // The fill DEEPENS with how often the effect is active: 100% reads
        // as a solid wash, a rare 10% as a tint — the pct is on the map
        // without a number over it (no text over the map, the law above).
        const alpha = 0.1 + 0.3 * (z.pct / 100);
        for (const [x0, y0, x1, y1] of z.rects) {
          ctx.svg.appendChild(
            ctx.el("path", {
              d: quad(ctx, x0, y0, x1, y1),
              fill: `hsla(${hue},70%,60%,${alpha.toFixed(3)})`,
              stroke: `hsla(${hue},70%,70%,0.9)`,
              "stroke-width": 0.35,
              "vector-effect": "non-scaling-stroke",
            }),
          );
        }
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
  /* THE CHOOSER: the drop-quantity dialog's recipe (hud.ts .ml-qty) — a
     blurred backdrop over everything and a wiki card, centred; the card
     scrolls when the ambient list outgrows a phone. Rows are the Settings
     checklist's own recipe (.ml-plate-btn + .ml-amb-check), so ticking a
     layer here looks exactly like ticking an effect there. */
  .${DLG_CLS}-back{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.5);
    backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
  .${DLG_CLS}{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
    width:min(360px,calc(100vw - 32px));max-height:calc(100dvh - 48px);overflow-y:auto;
    box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:14px;
    background:var(--bg);color:var(--ink);border:1px solid var(--border);border-radius:14px;
    box-shadow:var(--shadow);font:14px/1.45 var(--sans)}
  .${DLG_CLS} *{box-sizing:border-box}
  .${DLG_CLS}-h{display:flex;align-items:center;gap:6px;margin-top:6px;
    color:var(--muted);font:600 12px/1.2 var(--sans);letter-spacing:.08em;text-transform:uppercase}
  .${DLG_CLS}-h .ml-plate-btn{min-height:26px;padding:2px 9px;font-size:11px;border-radius:7px;
    text-transform:none;letter-spacing:0;font-weight:600}
  .${DLG_CLS}-h .ml-plate-btn:first-of-type{margin-left:auto}
  .${DLG_CLS} .ml-layer-row{justify-content:flex-start;gap:12px;text-align:left;white-space:nowrap;
    min-height:40px;padding:6px 12px}
  .${DLG_CLS}-done{margin-top:6px}
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
    box-sizing:border-box;transform:rotate(45deg);background:rgba(255,196,92,0.96);
    border:1.5px solid rgba(0,0,0,0.8);box-shadow:0 0 0 1px rgba(255,255,255,0.35)}
  .${MARK_CLS} b.pin s{text-decoration:none}`;
  document.head.appendChild(st);
}

/** Flip one layer and redraw now, not on the next move. */
function setLayer(id: string, want: boolean) {
  if (want) on.add(id);
  else on.delete(id);
  writeOn(on);
  sig = "";
  syncButton();
}

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
  const rows: { id: string; btn: HTMLButtonElement; box: HTMLElement }[] = [];
  const paint = () => {
    for (const r of rows) {
      r.btn.classList.toggle("on", on.has(r.id));
      r.box.classList.toggle("on", on.has(r.id));
    }
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
        for (const l of layers) setLayer(l.id, want);
        paint();
        ensureMapLayers();
      });
      h.appendChild(b);
    }
    card.appendChild(h);
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
      btn.append(box, t);
      btn.addEventListener("click", () => {
        setLayer(l.id, !on.has(l.id));
        paint();
        ensureMapLayers();
      });
      card.appendChild(btn);
      rows.push({ id: l.id, btn, box });
    }
  }
  const done = document.createElement("button");
  done.type = "button";
  done.className = `ml-plate-btn ${DLG_CLS}-done`;
  done.textContent = "Done";
  done.addEventListener("click", closeDialog);
  card.appendChild(done);
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
  openBtn.className = "ml-plate-btn";
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
 *  (an ambient layer of a world that has none) is not counted. */
function syncButton() {
  if (!openBtn) return;
  const n = offered().filter((l) => on.has(l.id)).length;
  openBtn.textContent = n ? `layers · ${n}` : "layers";
  openBtn.classList.toggle("on", n > 0);
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
  for (const l of allLayers()) if (on.has(l.id)) l.draw(ctx);
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
