// The Shaders review stage: pick an effect, drag its level 1-10, tune it,
// read why it looks the way it does — rendered the way the game renders it
// (stage.js): the real hero casting with its real clip, the spell leaving on
// the clip's key frame from the measured wand tip, a real monster to hit,
// the game's light by time of day with the hero's torch.
//
// Standalone (open shaders/viewer/ from a static server at the repo root, or
// /assets/shaders/viewer/ in the game), or EMBEDDED in the wiki with ?embed=1:
// then it talks to the wiki over postMessage (shaders/docs/wiki.md) — the wiki
// saves what the sliders change and plays the sounds bound to the events it
// is told about. Every stage setting also lives in the URL, so an iframe the
// wiki re-renders comes back exactly as it was.
//
// ?sheet=<id>[,<id>]&levels=1,5,10&frames=6 renders a deterministic contact
// sheet instead (the gate and the agent's own eyes use it).

import { createFx, DEFAULT_STYLE } from "../runtime/fx.js";
import { tuneDefaults, CAST_ANIMS, soundEvent } from "../runtime/define.js";
import { FORMATIONS, formationsOf } from "../runtime/volley.js";
import { layout, showcase, facingOf } from "../runtime/showcase.js";
import { Stage, ISO, TORCH, blendPhases, TIME_PHASES, measureFeet } from "./stage.js";
import LIBRARY from "../library/index.js";
import { CAST_POINTS } from "../library/cast_points.js";
import { FAMILIES, KIND_LABEL } from "../library/families.js";
import { HEROES, MONSTERS, EXTRA_MONSTER } from "./bodies.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const EMBED = params.has("embed");
const SHEET = params.get("sheet");
const STORE = "nfx-viewer-v2";
const ROOT = new URL("../../", import.meta.url); // the repo root (or /assets/)

const HERO_PX = 88; // games2 CHARACTER_BODY_PX
const HERO_W = 44; // a person's drawn width: what a melee reach is measured against
const HERO_IDLE_FPS = 6; // games2 ANIM_FPS.idle
const CAST_HOLD = 0.2; // s a finished one-shot clip holds its last frame

const assetUrl = (rel) => new URL(rel, ROOT).href;

const defs = LIBRARY.slice().sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));
const byId = new Map(defs.map((d) => [d.id, d]));
const keyOf = (id) => `shaders/library/${id}`;

// ---------------------------------------------------------------- state ----
const saved = (() => {
  try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch { return {}; }
})();
const pick = (k, ok, dflt) => {
  const q = params.get(k);
  if (q !== null && ok(q)) return q;
  return saved[k] !== undefined && ok(String(saved[k])) ? saved[k] : dflt;
};
const num = (lo, hi) => (v) => Number(v) >= lo && Number(v) <= hi;
const state = {
  id: pick("id", (v) => byId.has(v), defs[0]?.id),
  level: Number(pick("level", num(1, 10), 5)),
  tod: Number(params.get("night") === "1" ? 0.5 : params.get("night") === "0" ? 2.5 : pick("tod", num(0, 4), 0.5)),
  torch: String(pick("torch", (v) => v === "0" || v === "1" || v === "true" || v === "false", "1")) !== "0" && String(pick("torch", () => true, "1")) !== "false",
  hero: pick("hero", (v) => v in HEROES, "default_boy"),
  monster: params.get("target") in MONSTERS ? params.get("target") : pick("monster", (v) => v in MONSTERS, Object.keys(MONSTERS)[0]),
  count: Number(pick("count", num(1, 6), 1)),
  formation: pick("formation", (v) => v in FORMATIONS, "fan"),
  speed: Number(pick("speed", (v) => ["1", "0.5", "0.25"].includes(String(v)), 1)),
  loop: String(pick("loop", () => true, "1")) !== "0" && String(pick("loop", () => true, "1")) !== "false",
  family: "all",
  query: "",
  style: { ...DEFAULT_STYLE, ...(saved.style || {}) },
  tune: saved.tune || {}, // id -> { key: value } (only what differs from the default)
  monsterPicked: params.has("monster") || params.get("target") in MONSTERS, // an explicit pick beats an effect's hint
};
const STAGE_KEYS = ["id", "level", "tod", "torch", "hero", "monster", "count", "formation", "speed", "loop"];
const stageState = () => Object.fromEntries(STAGE_KEYS.map((k) => [k, state[k]]));
const persist = () => {
  try {
    localStorage.setItem(STORE, JSON.stringify({ ...stageState(), style: state.style, tune: state.tune }));
  } catch {}
  if (EMBED) post({ type: "shaders:state", state: stageState() });
};

// --------------------------------------------------------------- actors ----
// A body that plays the game's clips. Frames are loaded per (clip, facing)
// on first use; until they arrive the body shows what it had.
class Actor {
  constructor(stage, body) {
    this.stage = stage;
    this.body = body;
    this.kind = null; // "hero" | "monster"
    this.id = null;
    this.facing = "east";
    this.clip = null; // { name, fps, once, t0, hold, frames }
    this.cache = new Map();
    this.height = HERO_PX;
  }
  async setHero(id) {
    if (this.kind === "hero" && this.id === id) return;
    this.kind = "hero"; this.id = id; this.cache.clear(); this.height = HERO_PX; this.width = HERO_W;
    await this.idle(0);
  }
  async setMonster(id) {
    if (this.kind === "monster" && this.id === id) return;
    this.kind = "monster"; this.id = id; this.cache.clear();
    this.manifest = await fetch(assetUrl(`monsters/${id}/monster.json`)).then((r) => r.json());
    await this.idle(0);
    const f = await this.frames("idle");
    this.height = f.feet.height;
    this.width = f.feet.width;
  }
  /** Frame urls of a clip for the current facing. */
  urls(name) {
    if (this.kind === "hero") {
      const a = CAST_POINTS.heroes[this.id]?.anims[name];
      if (!a) return [];
      return Array.from({ length: a.frames }, (_, i) => `characters2/humans/${this.id}/animations/${a.folder}/${this.facing}/${i}.webp`);
    }
    const st = this.manifest?.states?.[name] ?? name;
    const d = this.manifest?.animations?.[st]?.directions?.[this.facing];
    if (d?.frame_paths?.length) return d.frame_paths.map((p) => `monsters/${p}`);
    const rot = this.manifest?.rotations?.[this.facing];
    return rot ? [`monsters/${rot}`] : [];
  }
  async frames(name) {
    const key = `${name}|${this.facing}`;
    let c = this.cache.get(key);
    if (!c) {
      c = (async () => {
        const fr = await Promise.all(this.urls(name).map((u) => this.stage.image(assetUrl(u))));
        let anchor, feet;
        if (this.kind === "hero") {
          const a = CAST_POINTS.heroes[this.id].anchors[this.facing];
          anchor = { x: a.x * CAST_POINTS.frame.w, y: a.y * CAST_POINTS.frame.h };
        } else {
          feet = measureFeet(fr[0].img);
          anchor = { x: feet.x, y: feet.y };
        }
        return { frames: fr, anchor, feet };
      })();
      this.cache.set(key, c);
    }
    return c;
  }
  async face(facing) {
    if (this.facing === facing) return;
    this.facing = facing;
    if (this.clip) await this.frames(this.clip.name).catch(() => {});
  }
  async idle(t) {
    const fps = this.kind === "hero" ? HERO_IDLE_FPS : null;
    await this.playClip("idle", { t, fps, once: false });
  }
  /** Start a clip at clock time t. fps null = the monster rule (per count). */
  async playClip(name, { t, fps, once, hold = 0, then = null }) {
    const f = await this.frames(name).catch(() => null);
    if (!f || !f.frames.length) return;
    const n = f.frames.length;
    const rate = fps ?? (name === "attack" ? Math.max(5, n / 0.7) : n <= 6 ? 4 : 7); // WorldScene's monster rates
    this.clip = { name, fps: rate, once, t0: t, hold, then, f };
  }
  update(t) {
    const c = this.clip;
    if (!c) return;
    const n = c.f.frames.length;
    let i = Math.floor((t - c.t0) * c.fps);
    if (c.once) {
      if (i >= n && c.then && t - c.t0 >= n / c.fps + c.hold) {
        const next = c.then;
        c.then = null;
        next(t);
      }
      i = Math.max(0, Math.min(n - 1, i));
    } else i = ((i % n) + n) % n;
    this.body.frame = c.f.frames[i];
    this.body.anchor = c.f.anchor;
  }
}

// ---------------------------------------------------------------- stage ----
const canvas = $("stage");
let stage, fx, view = { x: 0, y: 0, w: 360, h: 210 }, vp = { x: 0, y: 0, w: 360, h: 210 };
let actors = {}; // caster, target, x1, x2
const pos = { origin: { x: 0, y: 0 }, target: null };
let clock = 0; // stage seconds (speed-scaled)

function showError(msg) {
  const e = $("stage-err");
  e.textContent = msg;
  e.hidden = false;
}

/** Fit the stage: the game shows ~360-420 world px across a phone at a whole
 *  zoom, so the stage does the same — every world px is N device px. */
function fit() {
  const wrap = $("stage-wrap");
  const dpr = Math.min(window.devicePixelRatio || 1, 4);
  const cssW = wrap.clientWidth || 360;
  const devW = Math.floor(cssW * dpr);
  const zoom = Math.max(1, Math.round(devW / 390));
  const worldW = Math.floor(devW / zoom);
  const worldH = Math.round(worldW * 0.62);
  if (state.style.pixel) {
    canvas.width = worldW; canvas.height = worldH;
    vp = { x: 0, y: 0, w: worldW, h: worldH };
  } else {
    canvas.width = worldW * zoom; canvas.height = worldH * zoom;
    vp = { x: 0, y: 0, w: worldW * zoom, h: worldH * zoom };
  }
  canvas.style.width = `${(worldW * zoom) / dpr}px`;
  canvas.style.height = `${(worldH * zoom) / dpr}px`;
  view = { x: 0, y: 0, w: worldW, h: worldH };
  layoutWorld(worldW, worldH);
}

function layoutWorld(W, H) {
  // the caster stands at a quarter of the width; the world grid is the game's
  const cast = { c: 4.5, r: 7.5 };
  stage.origin = { x: Math.round(0.24 * W - (cast.c - cast.r) * ISO.dx), y: Math.round(0.74 * H - (cast.c + cast.r) * ISO.dy) };
  pos.origin = { x: cast.c * ISO.cellWu, y: cast.r * ISO.cellWu };
  pos.range = (0.5 * W) / (2 * ISO.dx) * Math.SQRT2;
  stage.buildGround(view);
}

// ------------------------------------------------------------- director ----
// It stages the effect with runtime/showcase.js — the same recipe the wiki
// and the game read — and starts the caster's clip in the same frame, so the
// spell leaves on the clip's key frame.
const director = {
  h: null, sc: null, wait: 0, events: [], timeline: [], def: null, playing: 0,
  async play() {
    const def = byId.get(state.id);
    if (!def || !fx) return;
    const ticket = ++this.playing;
    fx.clear();
    fx.setStyle(state.style);
    const S = def.stage;
    // where everyone stands: the recipe's layout toward the (tapped) target
    const O = pos.origin;
    let dir = [Math.SQRT1_2, -Math.SQRT1_2], range = pos.range;
    if (pos.target) {
      const dx = pos.target.x - O.x, dy = pos.target.y - O.y, n = Math.hypot(dx, dy);
      if (n > 8) { dir = [dx / n, dy / n]; range = n / ISO.cellWu; }
    }
    // who plays each role (the recipe's roles; positions come after, once
    // the bodies' widths are known)
    const roles = layout(def, { origin: O, dir, range, cellWu: ISO.cellWu });
    const want = S.monster && MONSTERS[S.monster] && !state.monsterPicked ? S.monster : state.monster;
    const setups = [];
    for (const role of ["caster", "target"]) {
      const b = roles[role], A = actors[role];
      A.body.visible = false;
      A.world = null;
      if (!b) continue;
      setups.push(b.kind === "hero" ? A.setHero(state.hero) : A.setMonster(want));
    }
    roles.extras.forEach((_, i) => setups.push(actors[`x${i + 1}`].setMonster(EXTRA_MONSTER)));
    for (const k of ["x1", "x2"]) actors[k].body.visible = false;
    try { await Promise.all(setups); } catch (e) { showError(`Could not load a body (${e.message}).`); return; }
    if (ticket !== this.playing) return;
    // a body wider than a person pushes a melee reach out by the difference
    const half = (k) => (roles[k] ? Math.max(0, (actors[k].width || HERO_W) - HERO_W) / 2 : 0);
    const pad = (half("caster") + half("target")) / (ISO.dx * Math.SQRT2);
    const bodies = layout(def, { origin: O, dir, range, cellWu: ISO.cellWu, pad });
    for (const role of ["caster", "target"]) if (bodies[role]) actors[role].world = bodies[role];
    // facings: the caster at the target, the victims at the caster
    const scr = (p) => stage.project(p.x, p.y);
    const faceTo = (from, to) => { const a = scr(from), b = scr(to); return facingOf(b.x - a.x, b.y - a.y); };
    const C = bodies.caster, T = bodies.target;
    if (C) { C.facing = T ? faceTo(C, T) : "south-east"; C.hero = actors.caster.kind === "hero" ? state.hero : undefined; }
    if (T) T.facing = C ? faceTo(T, C) : "south-west";
    const placed = [["caster", C], ["target", T], ["x1", bodies.extras[0]], ["x2", bodies.extras[1]]];
    await Promise.all(placed.map(async ([k, b]) => {
      if (!b) return;
      const A = actors[k];
      await A.face(b.facing || (C ? faceTo(b, C) : "south-west"));
      const p = scr(b);
      A.body.x = p.x; A.body.y = p.y; A.body.visible = true;
      b.height = A.height;
    }));
    // the caster's clip is loaded BEFORE the effect starts: clip and spell
    // share their first frame, so the key frame IS the release
    const A = actors.caster;
    if (C && S.anim) await A.frames(S.anim).catch(() => null);
    if (ticket !== this.playing) return;
    const tune = { ...(state.tune[def.id] || {}) };
    const seed = Math.random();
    const forms = formationsOf(def);
    const count = forms.length ? state.count : 1;
    const formation = forms.includes(state.formation) ? state.formation : forms[0];
    const sc = showcase(fx, def, bodies, { level: state.level, seed, tune, count, formation });
    this.sc = sc;
    this.h = sc.handle;
    this.def = def;
    this.t0 = clock;
    this.events = [];
    this.timeline = this.h.timeline();
    if (sc.cast && C) {
      const sustained = !["projectile", "melee", "burst", "chain"].includes(def.kind);
      const holdChannel = sustained && sc.cast.anim === "spell_channel";
      A.playClip(sc.cast.anim, { t: clock, fps: sc.cast.fps ?? null, once: true, hold: holdChannel ? Infinity : CAST_HOLD, then: (t) => A.idle(t) });
      if (holdChannel) this.h.on("stop", () => { if (A.clip && A.clip.hold === Infinity) A.idle(clock); });
    } else if (C) A.idle(clock);
    if (sc.move) {
      const P = scr(sc.move);
      this.h.on("peak", () => { A.body.x = P.x; A.body.y = P.y; });
    }
    this.h.on("*", (i, h, ev) => {
      this.events.push({ event: ev, index: i, t: h.time });
      if (EMBED) {
        const slots = def.sounds.filter((s) => s.event === ev && (!s.loop || ev === "release"));
        post({ type: "shaders:event", id: def.id, key: keyOf(def.id), event: ev, index: i, t: +h.time.toFixed(3), slots: slots.map((s) => ({ slot: s.slot, loop: !!s.loop, sound_event: soundEvent(def.id, s.slot) })) });
        if (ev === "stop" && def.sounds.some((s) => s.loop)) post({ type: "shaders:event", id: def.id, key: keyOf(def.id), event: "channel-end", index: 0, t: +h.time.toFixed(3), slots: [{ slot: "channel", loop: true, sound_event: soundEvent(def.id, "channel") }] });
      }
    });
    this.wait = 0;
    if (!SHEET) {
      renderTimeline();
      renderNotes();
    }
    if (EMBED) post({ type: "shaders:timeline", id: def.id, key: keyOf(def.id), events: this.timeline, sounds: def.sounds.map((s) => ({ ...s, sound_event: soundEvent(def.id, s.slot) })) });
  },
  tick(dt) {
    if (!this.h) return;
    if (this.h.done) {
      this.wait += dt;
      if (state.loop && this.wait > 0.8) this.play();
    }
  },
};

// ------------------------------------------------------------ timeline ----
// When each sound-bindable moment happens, and the caster's clip frames.
const EV_CLASS = { cast: "ev-cast", release: "ev-rel", impact: "ev-imp", hit: "ev-imp", peak: "ev-imp", hop: "ev-imp", start: "ev-sus", stop: "ev-sus", end: "ev-end" };
function renderTimeline() {
  const box = $("timeline");
  const d = director.def, h = director.h;
  if (!d || !h) return;
  const tl = director.timeline;
  const end = Math.max(0.5, ...tl.map((e) => e.t), isFinite(h.duration) ? h.duration : 0);
  const pct = (t) => `${Math.max(0, Math.min(100, (t / end) * 100)).toFixed(2)}%`;
  const cast = director.sc?.cast;
  let frames = "";
  if (cast) {
    const n = cast.frames || 4, fps = cast.fps || n / (cast.seconds || 0.7);
    for (let i = 0; i < n; i++) frames += `<i class="fr${i === (cast.key ?? Math.floor(n * (cast.keyAt ?? 0.5))) ? " key" : ""}" style="left:${pct(i / fps)};width:${pct(1 / fps)}"></i>`;
  }
  const marks = tl.filter((e) => e.event !== "end").map((e) => `<b class="mk ${EV_CLASS[e.event] || ""}" style="left:${pct(e.t)}" title="${esc(e.event)}${e.index ? " " + (e.index + 1) : ""} ${e.t.toFixed(2)} s"></b>`).join("");
  const loopSlot = d.sounds.find((s) => s.loop);
  const rel = tl.find((e) => e.event === "release"), stp = tl.find((e) => e.event === "stop");
  const bed = loopSlot && rel ? `<span class="bed" style="left:${pct(rel.t)};width:${pct((stp ? stp.t : end) - rel.t)}"></span>` : "";
  const counts = {};
  for (const e of tl) counts[e.event] = (counts[e.event] || 0) + 1;
  const slots = d.sounds.map((s) => {
    const at = tl.filter((e) => e.event === s.event);
    const when = s.loop ? `${(rel?.t ?? 0).toFixed(2)}–${stp ? stp.t.toFixed(2) : "…"} s` : at.map((e) => e.t.toFixed(2)).join(", ") + " s";
    return `<li><span class="sw ${s.loop ? "ev-sus" : EV_CLASS[s.event] || ""}"></span><span class="sl">${esc(s.label)}${!s.loop && at.length > 1 ? ` <em>×${at.length}</em>` : ""}</span><span class="sw-t">${esc(when)}</span><code>${esc(soundEvent(d.id, s.slot))}</code></li>`;
  }).join("");
  box.innerHTML = `
    <div class="tl-track">${bed}${frames ? `<div class="tl-frames" title="the caster's clip; the lit frame is the key frame">${frames}</div>` : ""}${marks}<span class="tl-head" id="tl-head"></span></div>
    <div class="tl-scale"><span>0</span><span>${end.toFixed(2)} s</span></div>
    <ul class="tl-slots">${slots}</ul>`;
}
function tickTimeline() {
  const h = director.h, head = $("tl-head");
  if (!h || !head) return;
  const tl = director.timeline;
  const end = Math.max(0.5, ...tl.map((e) => e.t), isFinite(h.duration) ? h.duration : 0);
  head.style.left = `${Math.min(100, (h.time / end) * 100).toFixed(2)}%`;
}

// ------------------------------------------------------------------- UI ----
function familyDot(f) {
  const s = document.createElement("span");
  s.className = "fam-dot";
  s.style.background = FAMILIES[f]?.color || "var(--muted)";
  return s;
}

function renderFamilies() {
  const box = $("families");
  box.textContent = "";
  const fams = ["all", ...Object.keys(FAMILIES).filter((f) => defs.some((d) => d.family === f))];
  for (const f of fams) {
    const b = document.createElement("button");
    b.type = "button";
    if (f !== "all") b.append(familyDot(f));
    b.append(f === "all" ? `All ${defs.length}` : `${FAMILIES[f].label} ${defs.filter((d) => d.family === f).length}`);
    b.className = state.family === f ? "on" : "";
    b.onclick = () => { state.family = f; renderFamilies(); renderList(); };
    box.append(b);
  }
}

function visibleDefs() {
  const q = state.query.trim().toLowerCase();
  return defs.filter((d) => (state.family === "all" || d.family === state.family) &&
    (!q || d.name.toLowerCase().includes(q) || d.id.includes(q) || d.tags.some((t) => t.includes(q)) || d.kind.includes(q)));
}

function renderList() {
  const ul = $("list");
  ul.textContent = "";
  for (const d of visibleDefs()) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = d.id === state.id ? "on" : "";
    const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = d.name;
    const kd = document.createElement("span"); kd.className = "kd"; kd.textContent = KIND_LABEL[d.kind];
    b.append(familyDot(d.family), nm, kd);
    b.onclick = () => select(d.id);
    li.append(b);
    ul.append(li);
  }
}

function select(id) {
  if (!byId.has(id)) return;
  state.id = id;
  persist();
  renderHeader();
  renderList();
  renderTune();
  renderStageControls();
  director.play();
  if (EMBED) post({ type: "shaders:selected", id, key: keyOf(id), level: state.level, version: VERSIONS[id] });
}

function renderHeader() {
  const d = byId.get(state.id);
  const i = defs.indexOf(d);
  $("count").textContent = `${i + 1} of ${defs.length}`;
  $("now-name").textContent = d.name;
  $("now-kind").textContent = KIND_LABEL[d.kind];
  $("now-dot").style.background = FAMILIES[d.family]?.color || "var(--muted)";
  document.title = `${d.name} · Nangijala Shaders`;
}

function valueLabel(spec, v) {
  if (spec.type === "range") return Number(v).toFixed(spec.step < 0.1 ? 2 : spec.step < 1 ? 1 : 0);
  return "";
}

function controlRow(id, spec, value, isChanged, onChange) {
  const row = document.createElement("div");
  row.className = "row" + (isChanged ? " changed" : "");
  const lab = document.createElement("label");
  lab.textContent = spec.label || id;
  const inp = spec.type === "select" ? document.createElement("select") : document.createElement("input");
  inp.id = `t-${id}`;
  lab.htmlFor = inp.id;
  const out = document.createElement("span");
  out.className = "val";
  if (spec.type === "color") { inp.type = "color"; inp.value = value; out.textContent = value; }
  else if (spec.type === "bool") { inp.type = "checkbox"; inp.checked = !!value; }
  else if (spec.type === "select") {
    for (const o of spec.options) { const op = document.createElement("option"); op.value = o; op.textContent = o; inp.append(op); }
    inp.value = value;
  } else {
    inp.type = "range"; inp.min = spec.min; inp.max = spec.max; inp.step = spec.step ?? 0.01; inp.value = value;
    out.textContent = valueLabel(spec, value);
  }
  const read = () => (spec.type === "bool" ? inp.checked : spec.type === "range" ? Number(inp.value) : inp.value);
  inp.addEventListener("input", () => {
    const v = read();
    if (spec.type === "range") out.textContent = valueLabel(spec, v);
    if (spec.type === "color") out.textContent = v;
    onChange(v, row);
  });
  row.append(lab, inp, out);
  return row;
}

function renderTune() {
  const d = byId.get(state.id);
  const box = $("tune");
  box.textContent = "";
  const cur = state.tune[d.id] || {};
  const dflt = tuneDefaults(d);
  for (const k of Object.keys(d.tune)) {
    const spec = d.tune[k];
    const v = cur[k] ?? spec.def;
    box.append(controlRow(k, spec, v, k in cur, (nv, row) => {
      const t = (state.tune[d.id] = state.tune[d.id] || {});
      if (nv === dflt[k]) delete t[k]; else t[k] = nv;
      if (!Object.keys(t).length) delete state.tune[d.id];
      row.classList.toggle("changed", k in (state.tune[d.id] || {}));
      if (director.h && director.h.setTune) director.h.setTune({ [k]: nv });
      persist();
      if (EMBED) post({ type: "shaders:tune", id: d.id, key: keyOf(d.id), values: { ...(state.tune[d.id] || {}) }, defaults: dflt });
      $("copy-out").hidden = true;
    }));
  }
}

function renderStyle() {
  const box = $("style");
  box.textContent = "";
  const spec = {
    pixel: { type: "bool", label: "Pixel-true" },
    bands: { type: "range", min: 0, max: 8, step: 1, label: "Colour bands" },
    dither: { type: "bool", label: "Dither" },
    stepFps: { type: "select", options: ["0", "8", "12", "15", "24"], label: "Animate on (fps)" },
  };
  for (const k of Object.keys(spec)) {
    const v = k === "stepFps" ? String(state.style[k]) : state.style[k];
    box.append(controlRow(`s-${k}`, spec[k], v, v !== (k === "stepFps" ? String(DEFAULT_STYLE[k]) : DEFAULT_STYLE[k]), (nv, row) => {
      state.style[k] = k === "stepFps" ? Number(nv) : nv;
      row.classList.toggle("changed", state.style[k] !== DEFAULT_STYLE[k]);
      fx.setStyle(state.style);
      persist();
      if (k === "pixel") fit();
    }));
  }
}

/** A segmented control: options [[value, label]], `on` = current value. */
function seg(box, options, on, onPick) {
  box.textContent = "";
  for (const [v, label] of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.className = String(v) === String(on) ? "on" : "";
    b.onclick = () => onPick(v);
    box.append(b);
  }
}

function phaseName(u) {
  const i = Math.floor(((u % 4) + 4) % 4);
  return TIME_PHASES[i].name;
}

/** The stage row: who is on stage, the volley, the time of day. */
function renderStageControls() {
  const d = byId.get(state.id);
  const S = d.stage;
  const hasHero = S.caster === "hero" || S.target === "hero";
  const hasMonster = S.caster === "monster" || S.target === "monster" || S.at === "target";
  $("hero-row").hidden = !hasHero;
  $("monster-row").hidden = !hasMonster;
  seg($("hero-seg"), Object.entries(HEROES), state.hero, (v) => { state.hero = v; persist(); renderStageControls(); director.play(); });
  const cur = S.monster && MONSTERS[S.monster] && !state.monsterPicked ? S.monster : state.monster;
  const sel = $("monster");
  sel.textContent = "";
  for (const [k, label] of Object.entries(MONSTERS)) {
    const o = document.createElement("option");
    o.value = k; o.textContent = label;
    sel.append(o);
  }
  sel.value = cur;
  const forms = formationsOf(d);
  $("volley-row").hidden = !forms.length;
  if (forms.length) {
    seg($("count-seg"), [1, 2, 3, 4, 5, 6].map((n) => [n, n === 1 ? "1" : `×${n}`]), state.count, (v) => { state.count = Number(v); persist(); renderStageControls(); director.play(); });
    const f = forms.includes(state.formation) ? state.formation : forms[0];
    seg($("formation-seg"), forms.map((k) => [k, FORMATIONS[k].label]), f, (v) => { state.formation = v; persist(); renderStageControls(); director.play(); });
    $("formation-seg").hidden = state.count < 2;
    $("formation-about").textContent = state.count > 1 ? FORMATIONS[f].about : "";
  }
  $("tod").value = state.tod;
  $("tod-out").textContent = phaseName(state.tod);
  $("torch").checked = state.torch;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function usage(d) {
  const L = `level: ${state.level}`;
  const S = d.stage;
  const rel = S.caster && S.anim ? `, release: ${d.kind === "melee" ? "castRelease(def, level)" : (CAST_ANIMS[S.anim].seconds ? CAST_ANIMS[S.anim].seconds * CAST_ANIMS[S.anim].keyAt : CAST_ANIMS[S.anim].key / CAST_ANIMS[S.anim].fps).toFixed(2)}` : "";
  const vol = formationsOf(d).length ? `\n// a volley: add count: 3, formation: "${formationsOf(d)[0]}" — every copy fires its own events` : "";
  switch (d.kind) {
    case "projectile": return `const h = fx.play("${d.id}", { ${L}, from: castFrom(caster, hero, "${S.anim}", facing),\n  to: target, height: casterPx, targetHeight: targetPx, owner: "self"${rel} });\nh.on("impact", (i) => applyDamage());   // or schedule at h.impacts[i]${vol}`;
    case "beam": return `const h = fx.play("${d.id}", { ${L}, from: caster, to: () => target,\n  height: casterPx, targetHeight: targetPx${rel} });\n// every frame the target moves: nothing (to is read each frame)\nh.stop();                                 // when the channel ends`;
    case "chain": return `fx.play("${d.id}", { ${L}, from: caster, targets: [t1, t2, t3]${rel} })\n  .on("hop", (i) => applyDamage(targets[i]));`;
    case "melee": return `fx.play("${d.id}", { ${L}, at: attacker, to: victim, height: attackerPx${rel} })\n  .on("hit", () => applyDamage());`;
    case "aura": return `const h = fx.play("${d.id}", { ${L}, at: () => body, height: bodyPx${rel} });\nh.stop();                                 // when the buff ends`;
    case "zone": return `fx.play("${d.id}", { ${L}, at: spot, radius: cells, duration: seconds${rel} });`;
    case "burst": return `fx.play("${d.id}", { ${L}, at: spot, from: source, height: bodyPx${rel} })\n  .on("peak", (i) => applyEffect());${vol}`;
    default: return `const h = fx.play("${d.id}", { ${L} }); h.stop();`;
  }
}

function renderNotes() {
  const d = byId.get(state.id);
  const h = director.h;
  const S = d.stage;
  const facts = [];
  facts.push(`<span>Kind <b>${esc(KIND_LABEL[d.kind])}</b></span>`);
  facts.push(`<span>Element <b>${esc(FAMILIES[d.family]?.label || d.family)}</b></span>`);
  if (d.kind === "projectile") {
    const s = { level: state.level, lv: (state.level - 1) / 9, tune: {} };
    const sp = typeof d.speed === "function" ? d.speed(s) : d.speed ?? 10;
    facts.push(`<span>Speed <b>${sp.toFixed(1)} cells/s</b></span>`);
  }
  if (h && isFinite(h.duration) && h.duration > 0) facts.push(`<span>Lasts <b>${h.duration.toFixed(2)} s</b></span>`);
  if (S.caster && S.anim) facts.push(`<span>Cast <b>${esc(S.anim.replace("_", " "))}</b>, leaves at <b>${(h?.releaseAt ?? 0).toFixed(2)} s</b></span>`);
  const planes = [...new Set(d.layers.map((L) => L.plane))].join(", ");
  facts.push(`<span>Draws on <b>${esc(planes)}</b></span>`);
  facts.push(`<span>Light <b>${d.light ? "yes" : "no"}</b></span>`);
  $("notes").innerHTML = `
    <div><h3>What I was thinking</h3><p>${esc(d.thinking)}</p></div>
    ${d.levels ? `<div><h3>Levels 1 to 10</h3><p>${esc(d.levels)}</p></div>` : ""}
    <div class="facts">${facts.join("")}</div>
    <div><h3>In the game</h3><pre>${esc(usage(d))}</pre></div>
    <div class="key">${esc(keyOf(d.id))} · v ${esc(VERSIONS[d.id] || "—")}</div>`;
}

function copyTuning() {
  const out = {};
  for (const id of Object.keys(state.tune)) out[keyOf(id)] = state.tune[id];
  const text = JSON.stringify(out, null, 2);
  const ta = $("copy-out");
  ta.value = text;
  ta.hidden = false;
  const done = () => { $("copy").textContent = "Copied"; setTimeout(() => ($("copy").textContent = "Copy tuning"), 1400); };
  try {
    navigator.clipboard.writeText(text).then(done, () => { ta.select(); });
  } catch {
    ta.select();
  }
}

// ------------------------------------------------------------ embedding ----
// Same origin only: the wiki and this page are both served from the game.
let VERSIONS = {};
function post(msg) {
  try { if (window.parent !== window) window.parent.postMessage(msg, location.origin); } catch {}
}
function applyState(s) {
  let replay = false;
  if (s.level !== undefined) { setLevel(s.level); replay = true; }
  if (s.tod !== undefined && Number(s.tod) >= 0 && Number(s.tod) <= 4) state.tod = Number(s.tod);
  if (s.torch !== undefined) state.torch = !!s.torch && s.torch !== "0";
  if (s.hero in HEROES && s.hero !== state.hero) { state.hero = s.hero; replay = true; }
  if (s.monster in MONSTERS && s.monster !== state.monster) { state.monster = s.monster; state.monsterPicked = true; replay = true; }
  if (s.count !== undefined && Number(s.count) >= 1 && Number(s.count) <= 6) { state.count = Number(s.count); replay = true; }
  if (s.formation in FORMATIONS) { state.formation = s.formation; replay = true; }
  if ([1, 0.5, 0.25].includes(Number(s.speed))) state.speed = Number(s.speed);
  if (s.loop !== undefined) state.loop = !!s.loop;
  return replay;
}
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || e.source !== window.parent) return;
  const m = e.data;
  if (!m || typeof m !== "object") return;
  if (m.type === "shaders:open" && byId.has(m.id)) {
    applyState(m);
    syncControls();
    select(m.id);
  } else if (m.type === "shaders:ground" && m.tiles?.length && m.grid?.cells?.length) {
    // the wiki's floor plan: its base-set choices, painted as they are
    stage.setGroundPlan(m).then((ok) => { if (ok) post({ type: "shaders:ground-painted", ground: m.ground, set: m.set?.id }); }).catch((err) => console.warn(`[shaders] ground plan: ${err.message}`));
  } else if (m.type === "shaders:time") {
    // the game's clock: u = phase + progress (0..4), or t = 0..1 of the cycle
    const u = m.u !== undefined ? Number(m.u) : Number(m.t) * 4;
    if (u >= 0 && u <= 4) { state.tod = u; renderStageControls(); persist(); }
  } else if (m.type === "shaders:set") {
    const replay = applyState(m.state || {});
    syncControls();
    renderStageControls();
    persist();
    if (replay) director.play();
  } else if (m.type === "shaders:tuning" && m.table) {
    // the live table (live/tuning/shaders.json overrides): it becomes the default
    fx.setTuning(m.table);
    state.tune = {};
    for (const k of Object.keys(m.table)) {
      const { was, updated_at, ...v } = m.table[k] || {};
      state.tune[k.replace(/^shaders\/library\//, "")] = v;
    }
    renderTune();
    director.play();
  }
});

function setLevel(v) {
  state.level = Math.max(1, Math.min(10, Math.round(v)));
  $("level").value = state.level;
  $("level-out").textContent = state.level;
}

function syncControls() {
  $("level").value = state.level;
  $("level-out").textContent = state.level;
  $("loop").checked = state.loop;
  for (const o of document.querySelectorAll("[data-slow]")) o.classList.toggle("on", Number(o.dataset.slow) === state.speed);
}

/** The hero's torch as the game carries it: at the hero, faded by day. */
function torchLight() {
  if (!state.torch) return null;
  const hero = ["caster", "target"].map((k) => actors[k]).find((A) => A.kind === "hero" && A.body.visible);
  if (!hero?.world) return null;
  const f = blendPhases(state.tod).torchF;
  if (f <= 0.01) return null;
  return { col: hero.world.x / ISO.cellWu, row: hero.world.y / ISO.cellWu, z: TORCH.z, radius: TORCH.radius, color: TORCH.color.map((c) => c * f), flicker: TORCH.flicker };
}

// ----------------------------------------------------------------- boot ----
async function boot() {
  if (EMBED) document.body.classList.add("embed");
  try {
    stage = new Stage(canvas, { log: (m) => console.warn(m) });
  } catch (e) {
    showError(`This page needs WebGL.\n${e.message}`);
    return;
  }
  for (const k of ["caster", "target", "x1", "x2"]) actors[k] = new Actor(stage, stage.addBody(k));
  fx = createFx(stage.host(() => view), { style: state.style });
  fx.registerAll(defs);
  fetch(assetUrl("shaders/shaders.json")).then((r) => r.json()).then((c) => {
    VERSIONS = Object.fromEntries(c.effects.map((e) => [e.id, e.version]));
    renderNotes();
  }).catch(() => {});
  fit();
  window.addEventListener("resize", () => { clearTimeout(fit.t); fit.t = setTimeout(fit, 120); });

  syncControls();
  $("level").addEventListener("input", (e) => { setLevel(Number(e.target.value)); persist(); director.play(); });
  $("loop").addEventListener("change", (e) => { state.loop = e.target.checked; persist(); if (state.loop && director.h?.done) director.play(); });
  $("tod").addEventListener("input", (e) => { state.tod = Number(e.target.value); $("tod-out").textContent = phaseName(state.tod); persist(); });
  $("torch").addEventListener("change", (e) => { state.torch = e.target.checked; persist(); });
  $("monster").addEventListener("change", (e) => { state.monster = e.target.value; state.monsterPicked = true; persist(); director.play(); });
  $("play").onclick = () => director.play();
  for (const b of document.querySelectorAll("[data-slow]")) {
    b.onclick = () => { state.speed = Number(b.dataset.slow); syncControls(); persist(); };
  }
  $("prev").onclick = () => { const i = defs.findIndex((d) => d.id === state.id); select(defs[(i - 1 + defs.length) % defs.length].id); };
  $("next").onclick = () => { const i = defs.findIndex((d) => d.id === state.id); select(defs[(i + 1) % defs.length].id); };
  $("q").addEventListener("input", (e) => { state.query = e.target.value; renderList(); });
  $("reset").onclick = () => { delete state.tune[state.id]; persist(); renderTune(); director.play(); if (EMBED) post({ type: "shaders:tune", id: state.id, key: keyOf(state.id), values: {}, defaults: tuneDefaults(byId.get(state.id)) }); };
  $("copy").onclick = copyTuning;
  canvas.addEventListener("pointerdown", (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * view.w + view.x;
    const sy = ((e.clientY - r.top) / r.height) * view.h + view.y;
    pos.target = stage.unproject(sx, sy);
    $("stage-hint").hidden = true;
    director.play();
  });

  renderFamilies();
  renderList();
  renderHeader();
  renderTune();
  renderStyle();
  renderStageControls();
  director.play();
  if (EMBED) post({ type: "shaders:ready", ids: defs.map((d) => d.id), state: stageState() });

  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000) * state.speed;
    last = now;
    clock += dt;
    director.tick(dt);
    fx.update(dt);
    for (const A of Object.values(actors)) A.update(clock);
    try {
      stage.render(fx, { view, vp, u: state.tod, torch: torchLight(), t: clock });
    } catch (e) {
      showError(String(e.stack || e));
      return;
    }
    tickTimeline();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window.__nfx = { fx, stage, state, director, actors, select, setLevel, applyState, errors: () => [...stage.fxgl.errors] };
}

// ---------------------------------------------------------- sheet mode ----
/** The moments worth a frame: a projectile's launch, flight and impact beats;
 *  a sustained effect's intro, body and outro; anything else evenly. */
function keyTimes(d, h, n, stopAt) {
  if (d.kind === "projectile") {
    const I = h.impactAt, R = h.releaseAt, F = Math.max(0.05, I - R);
    const base = [R + 0.4 * F, R + 0.8 * F, I + 0.03, I + 0.09, I + 0.18, I + 0.32, I + 0.55, I + 0.9, I + 1.4, I + 2];
    return base.slice(0, n);
  }
  const R = h.releaseAt || 0;
  if (!isFinite(h.duration)) {
    const span = stopAt + 0.45;
    return Array.from({ length: n }, (_, i) => R + ((i + 0.5) / n) * span);
  }
  const span = Math.max(1.2, h.duration - R);
  return Array.from({ length: n }, (_, i) => R + ((i + 0.5) / n) * span);
}

// A grid: one row per (effect, level), `frames` columns across the effect's
// life. Deterministic (seed fixed, time stepped), so two runs are identical.
async function sheet() {
  document.body.classList.add("embed");
  document.body.style.background = "#141619";
  $("app").innerHTML = "";
  const ids = SHEET.split(",").filter((i) => byId.has(i));
  const levels = (params.get("levels") || "1,5,10").split(",").map(Number);
  const frames = Number(params.get("frames") || 6);
  const W = Number(params.get("w") || 240), H = Number(params.get("h") || 180);
  const u = state.tod;
  const cv = document.createElement("canvas");
  cv.width = W * frames; cv.height = H * ids.length * levels.length;
  cv.id = "sheet";
  cv.style.imageRendering = "pixelated";
  const zoom = Number(params.get("zoom") || 1);
  cv.style.width = `${cv.width * zoom}px`;
  cv.style.height = `${cv.height * zoom}px`;
  document.body.append(cv);
  const st = new Stage(cv, { preserve: true, log: (m) => console.warn(m) });
  stage = st;
  for (const k of ["caster", "target", "x1", "x2"]) actors[k] = new Actor(st, st.addBody(k));
  const style = { ...DEFAULT_STYLE };
  for (const k of ["bands", "stepFps"]) if (params.has(k)) style[k] = Number(params.get(k));
  if (params.has("dither")) style.dither = params.get("dither") !== "0";
  view = { x: 0, y: 0, w: W, h: H };
  const cast = { c: 3.2, r: 6.2 };
  st.origin = { x: Math.round(0.2 * W - (cast.c - cast.r) * ISO.dx), y: Math.round(0.78 * H - (cast.c + cast.r) * ISO.dy) };
  pos.origin = { x: cast.c * ISO.cellWu, y: cast.r * ISO.cellWu };
  pos.range = ((0.56 * W) / (2 * ISO.dx)) * Math.SQRT2;
  st.buildGround(view);
  const report = [];
  let row = 0;
  for (const id of ids) {
    const d = byId.get(id);
    for (const lvl of levels) {
      fx = createFx(st.host(() => view), { style });
      fx.register(d);
      state.id = id; state.level = lvl;
      clock = 0;
      const origRandom = Math.random;
      Math.random = () => 0.37;
      await director.play();
      Math.random = origRandom;
      const h = director.h;
      const stopAt = d.stage.hold;
      const times = keyTimes(d, h, frames, stopAt);
      let tNow = 0;
      for (let f = 0; f < frames; f++) {
        const tf = times[f];
        while (tNow < tf - 1e-6) {
          const step = Math.min(1 / 120, tf - tNow);
          fx.update(step);
          tNow += step;
          clock = tNow;
        }
        for (const A of Object.values(actors)) A.update(clock);
        // WebGL's viewport y is from the bottom
        const vpy = cv.height - (row + 1) * H;
        st.render(fx, { view, vp: { x: f * W, y: vpy, w: W, h: H }, u, torch: torchLight(), clear: true, t: clock });
      }
      report.push({ id, level: lvl, duration: h.duration, layers: fx.drawList().length, release: h.releaseAt });
      row++;
    }
  }
  window.__sheet = { done: true, report, errors: [...st.fxgl.errors], w: cv.width, h: cv.height };
}

if (SHEET) sheet().catch((e) => { window.__sheet = { done: true, error: String(e.stack || e) }; });
else boot();
