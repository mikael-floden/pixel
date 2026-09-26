// The effects review page: pick an effect, drag its level 1-10, tune it,
// read why it looks the way it does. Standalone (open shaders/viewer/ from any
// static server at the repo root, or /assets/shaders/viewer/ in the game), or
// EMBEDDED in the wiki with ?embed=1 — then it talks to the wiki over
// postMessage (shaders/docs/wiki.md): the wiki saves what the sliders change.
//
// ?sheet=<id>[,<id>]&levels=1,5,10&frames=6 renders a deterministic contact
// sheet instead (the gate and the agent's own eyes use it).

import { createFx, DEFAULT_STYLE } from "../runtime/fx.js";
import { tuneDefaults } from "../runtime/define.js";
import { Stage, ISO } from "./stage.js";
import LIBRARY from "../library/index.js";
import { FAMILIES, KIND_LABEL } from "../library/families.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const EMBED = params.has("embed");
const SHEET = params.get("sheet");
const STORE = "nfx-viewer-v1";
const ROOT = new URL("../../", import.meta.url); // the repo root (or /assets/)

const BODY_CASTER = "characters2/humans/default_boy/base/east.webp";
const TARGETS = {
  werewolf: { label: "Werewolf", url: "monsters/werewolf/rotations/west.webp" },
  troll: { label: "Crag troll", url: "monsters/crag_troll/rotations/west.webp" },
  human: { label: "Human", url: "characters2/humans/default_girl/base/west.webp" },
};
const BODY_TARGET = TARGETS.werewolf.url;
const BODY_DUMMY = "characters2/humans/default_girl/base/south-west.webp";

// A single-file build (pipeline/bundle.mjs) carries the bodies inline.
const assetUrl = (rel) => (window.__NFX_ASSETS && window.__NFX_ASSETS[rel]) || new URL(rel, ROOT).href;

const defs = LIBRARY.slice().sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));
const byId = new Map(defs.map((d) => [d.id, d]));
const keyOf = (id) => `shaders/library/${id}`;

// ---------------------------------------------------------------- state ----
const saved = (() => {
  try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch { return {}; }
})();
const state = {
  id: params.get("id") && byId.has(params.get("id")) ? params.get("id") : saved.id && byId.has(saved.id) ? saved.id : defs[0]?.id,
  level: Number(params.get("level")) || saved.level || 5,
  loop: saved.loop ?? true,
  night: saved.night ?? true,
  slow: 1,
  family: "all",
  query: "",
  style: { ...DEFAULT_STYLE, ...(saved.style || {}) },
  tune: saved.tune || {}, // id -> { key: value } (only what differs from the default)
};
const persist = () => {
  try {
    localStorage.setItem(STORE, JSON.stringify({ id: state.id, level: state.level, loop: state.loop, night: state.night, style: state.style, tune: state.tune }));
  } catch {}
};

// ---------------------------------------------------------------- stage ----
const canvas = $("stage");
let stage, fx, view = { x: 0, y: 0, w: 360, h: 210 }, vp = { x: 0, y: 0, w: 360, h: 210 };
let caster, target, dummies = [];
const pos = { caster: { x: 0, y: 0 }, target: { x: 0, y: 0 } };

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
  pos.caster = { x: cast.c * ISO.cellWu, y: cast.r * ISO.cellWu };
  if (!pos.targetSet) {
    const k = (0.5 * W) / (2 * ISO.dx);
    pos.target = { x: (cast.c + k) * ISO.cellWu, y: (cast.r - k) * ISO.cellWu };
  }
  stage.buildGround(view);
}

// ------------------------------------------------------------- director ----
const HOLD = 2.4; // s a sustained effect runs before the viewer stops it
const director = {
  h: null, wait: 0, t: 0,
  play() {
    const def = byId.get(state.id);
    if (!def || !fx) return;
    fx.clear();
    fx.setStyle(state.style);
    const tune = { ...(state.tune[def.id] || {}) };
    const seed = Math.random();
    const demo = def.demo || {};
    const lvl = state.level;
    const C = { ...pos.caster }, T = { ...pos.target };
    let tgt = T;
    if (def.kind === "melee" || demo.close) {
      // close in: melee reads at arm's length, not across the stage
      const dx = T.x - C.x, dy = T.y - C.y, n = Math.hypot(dx, dy) || 1, reach = (demo.dist ?? 1.25) * ISO.cellWu;
      tgt = { x: C.x + (dx / n) * reach, y: C.y + (dy / n) * reach };
    }
    placeBodies(C, tgt, def);
    const H = caster.feet.height, TH = target.feet.height;
    const common = { level: lvl, seed, tune, owner: "self" };
    const onCaster = demo.on === "caster" || (def.kind === "aura" && demo.on !== "target");
    switch (def.kind) {
      case "projectile":
        this.h = fx.play(def.id, { ...common, from: C, to: tgt, height: H, targetHeight: TH });
        break;
      case "beam":
        this.h = fx.play(def.id, { ...common, from: C, to: tgt, height: H, targetHeight: TH, duration: demo.hold ?? HOLD });
        break;
      case "chain":
        this.h = fx.play(def.id, { ...common, from: C, to: tgt, targets: [tgt, ...dummies.filter((d) => d.visible).map((d) => ({ x: d.wx, y: d.wy }))], height: H, targetHeight: TH });
        break;
      case "melee":
        this.h = fx.play(def.id, { ...common, at: C, to: tgt, height: H, targetHeight: TH });
        break;
      case "burst": {
        let at = onCaster ? C : tgt;
        if (demo.dest === "free") {
          // a free spot: between the two bodies, a step toward the camera
          at = { x: (C.x + tgt.x) / 2 + 1.1 * ISO.cellWu, y: (C.y + tgt.y) / 2 + 1.1 * ISO.cellWu };
        }
        this.h = fx.play(def.id, { ...common, at, from: C, to: onCaster || demo.dest ? undefined : tgt, height: onCaster || demo.dest ? H : TH, targetHeight: TH });
        if (demo.move) {
          const P = stage.project(at.x, at.y);
          this.h.on("peak", () => { caster.x = P.x; caster.y = P.y; });
        }
        break;
      }
      case "aura":
        this.h = fx.play(def.id, { ...common, at: onCaster ? C : tgt, height: onCaster ? H : TH, duration: demo.hold ?? HOLD });
        break;
      case "zone":
        this.h = fx.play(def.id, { ...common, at: onCaster ? C : tgt, from: C, height: H, duration: demo.hold ?? HOLD + 0.6 });
        break;
      default:
        this.h = fx.play(def.id, { ...common, at: C, duration: demo.hold ?? HOLD });
    }
    this.wait = 0;
    this.t = 0;
  },
  tick(dt) {
    if (!this.h) return;
    this.t += dt;
    if (this.h.done) {
      this.wait += dt;
      if (state.loop && this.wait > 0.7) this.play();
    }
  },
};

function placeBodies(C, T, def) {
  caster.x = stage.project(C.x, C.y).x; caster.y = stage.project(C.x, C.y).y;
  target.x = stage.project(T.x, T.y).x; target.y = stage.project(T.x, T.y).y;
  const chain = def.kind === "chain";
  dummies.forEach((d, i) => {
    d.visible = chain;
    const off = [[0.6, 1.4], [-0.9, -1.3]][i];
    d.wx = T.x + off[0] * ISO.cellWu; d.wy = T.y + off[1] * ISO.cellWu;
    const p = stage.project(d.wx, d.wy);
    d.x = p.x; d.y = p.y;
  });
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
  renderNotes();
  director.play();
  if (EMBED) post({ type: "shaders:selected", id, key: keyOf(id), level: state.level });
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

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function usage(d) {
  const L = `level: ${state.level}`;
  switch (d.kind) {
    case "projectile": return `const h = fx.play("${d.id}", { ${L}, from: caster, to: target,\n  height: casterPx, targetHeight: targetPx, owner: "self" });\nh.on("impact", () => applyDamage());   // or schedule at h.flightTime`;
    case "beam": return `const h = fx.play("${d.id}", { ${L}, from: caster, to: () => target,\n  height: casterPx, targetHeight: targetPx });\n// every frame the target moves: nothing (to is read each frame)\nh.stop();                                 // when the channel ends`;
    case "chain": return `fx.play("${d.id}", { ${L}, from: caster, targets: [t1, t2, t3] })\n  .on("hop", (i) => applyDamage(targets[i]));`;
    case "melee": return `fx.play("${d.id}", { ${L}, at: attacker, to: victim, height: attackerPx })\n  .on("hit", () => applyDamage());`;
    case "aura": return `const h = fx.play("${d.id}", { ${L}, at: () => body, height: bodyPx });\nh.stop();                                 // when the buff ends`;
    case "zone": return `fx.play("${d.id}", { ${L}, at: spot, radius: cells, duration: seconds });`;
    case "burst": return `fx.play("${d.id}", { ${L}, at: spot, from: source, height: bodyPx })\n  .on("peak", () => applyEffect());`;
    default: return `const h = fx.play("${d.id}", { ${L} }); h.stop();`;
  }
}

function renderNotes() {
  const d = byId.get(state.id);
  const h = director.h;
  const facts = [];
  facts.push(`<span>Kind <b>${esc(KIND_LABEL[d.kind])}</b></span>`);
  facts.push(`<span>Element <b>${esc(FAMILIES[d.family]?.label || d.family)}</b></span>`);
  if (d.kind === "projectile") {
    const s = { level: state.level, lv: (state.level - 1) / 9, tune: {} };
    const sp = typeof d.speed === "function" ? d.speed(s) : d.speed ?? 10;
    facts.push(`<span>Speed <b>${sp.toFixed(1)} cells/s</b></span>`);
  }
  if (h && isFinite(h.duration) && h.duration > 0) facts.push(`<span>Lasts <b>${h.duration.toFixed(2)} s</b></span>`);
  const planes = [...new Set(d.layers.map((L) => L.plane))].join(", ");
  facts.push(`<span>Draws on <b>${esc(planes)}</b></span>`);
  facts.push(`<span>Light <b>${d.light ? "yes" : "no"}</b></span>`);
  $("notes").innerHTML = `
    <div><h3>What I was thinking</h3><p>${esc(d.thinking)}</p></div>
    ${d.levels ? `<div><h3>Levels 1 to 10</h3><p>${esc(d.levels)}</p></div>` : ""}
    <div class="facts">${facts.join("")}</div>
    <div><h3>In the game</h3><pre>${esc(usage(d))}</pre></div>
    <div class="key">${esc(keyOf(d.id))}</div>`;
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

// A different body to hit: a small human, the werewolf, a huge troll. Effects
// size themselves to the body's height, so this is how that is judged.
const targetCache = {};
async function setTarget(key) {
  const T = TARGETS[key];
  if (!T || !stage) return;
  let s = targetCache[key];
  if (!s) {
    s = await stage.addSprite(assetUrl(T.url), key);
    targetCache[key] = s;
  }
  for (const o of Object.values(targetCache)) o.visible = false;
  s.visible = true;
  target = s;
}

// ------------------------------------------------------------ embedding ----
function post(msg) {
  try { if (window.parent !== window) window.parent.postMessage(msg, "*"); } catch {}
}
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || typeof m !== "object") return;
  if (m.type === "shaders:open" && byId.has(m.id)) {
    if (m.level) setLevel(m.level);
    select(m.id);
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
  persist();
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
  const url = assetUrl;
  try {
    [caster, target] = await Promise.all([stage.addSprite(url(BODY_CASTER), "caster"), stage.addSprite(url(BODY_TARGET), "target")]);
    targetCache.werewolf = target;
    dummies = await Promise.all([stage.addSprite(url(BODY_DUMMY), "d1"), stage.addSprite(url(BODY_DUMMY), "d2")]);
  } catch (e) {
    showError(`Could not load the stage's bodies (${e.message}).\nServe the repo root, or open /assets/shaders/viewer/.`);
    return;
  }
  fx = createFx(stage.host(() => view), { style: state.style });
  fx.registerAll(defs);
  fit();
  window.addEventListener("resize", () => { clearTimeout(fit.t); fit.t = setTimeout(fit, 120); });

  $("level").value = state.level;
  $("level-out").textContent = state.level;
  $("level").addEventListener("input", (e) => { setLevel(Number(e.target.value)); renderNotes(); director.play(); });
  $("loop").checked = state.loop;
  $("loop").addEventListener("change", (e) => { state.loop = e.target.checked; persist(); if (state.loop && director.h?.done) director.play(); });
  $("night").checked = state.night;
  $("night").addEventListener("change", (e) => { state.night = e.target.checked; persist(); });
  $("play").onclick = () => director.play();
  for (const b of document.querySelectorAll("[data-slow]")) {
    b.onclick = () => {
      state.slow = Number(b.dataset.slow);
      for (const o of document.querySelectorAll("[data-slow]")) o.classList.toggle("on", o === b);
    };
  }
  for (const b of document.querySelectorAll("[data-target]")) {
    b.onclick = async () => {
      const key = b.dataset.target;
      for (const o of document.querySelectorAll("[data-target]")) o.classList.toggle("on", o === b);
      await setTarget(key);
      director.play();
    };
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
    const w = stage.unproject(sx, sy);
    pos.target = w;
    pos.targetSet = true;
    $("stage-hint").hidden = true;
    director.play();
  });

  renderFamilies();
  renderList();
  renderHeader();
  renderTune();
  renderStyle();
  director.play();
  renderNotes();
  if (EMBED) post({ type: "shaders:ready", ids: defs.map((d) => d.id) });

  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000) * state.slow;
    last = now;
    director.tick(dt);
    fx.update(dt);
    try {
      stage.render(fx, { view, vp, night: state.night });
    } catch (e) {
      showError(String(e.stack || e));
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window.__nfx = { fx, stage, state, director, select, setLevel, errors: () => [...stage.fxgl.errors] };
}

// ---------------------------------------------------------- sheet mode ----
/** The moments worth a frame: a projectile's launch, flight and impact beats;
 *  a sustained effect's intro, body and outro; anything else evenly. */
function keyTimes(d, h, n, stopAt) {
  if (d.kind === "projectile") {
    const I = h.impactAt, F = Math.max(0.05, I);
    const base = [0.4 * F, 0.8 * F, I + 0.03, I + 0.09, I + 0.18, I + 0.32, I + 0.55, I + 0.9, I + 1.4, I + 2];
    return base.slice(0, n);
  }
  if (!isFinite(h.duration)) {
    const span = stopAt + 0.45;
    return Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * span);
  }
  const span = Math.min(h.duration, Math.max(1.2, h.duration));
  return Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * span);
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
  const night = params.get("night") !== "0";
  const cv = document.createElement("canvas");
  cv.width = W * frames; cv.height = H * ids.length * levels.length;
  cv.id = "sheet";
  cv.style.imageRendering = "pixelated";
  const zoom = Number(params.get("zoom") || 1);
  cv.style.width = `${cv.width * zoom}px`;
  cv.style.height = `${cv.height * zoom}px`;
  document.body.append(cv);
  const st = new Stage(cv, { preserve: true, log: (m) => console.warn(m) });
  const url = assetUrl;
  const [c, t] = await Promise.all([st.addSprite(url(BODY_CASTER), "caster"), st.addSprite(url(BODY_TARGET), "target")]);
  const ds = await Promise.all([st.addSprite(url(BODY_DUMMY), "d1"), st.addSprite(url(BODY_DUMMY), "d2")]);
  caster = c; target = t; dummies = ds; stage = st;
  const style = { ...DEFAULT_STYLE };
  for (const k of ["bands", "stepFps"]) if (params.has(k)) style[k] = Number(params.get(k));
  if (params.has("dither")) style.dither = params.get("dither") !== "0";
  view = { x: 0, y: 0, w: W, h: H };
  const cast = { c: 3.2, r: 6.2 };
  st.origin = { x: Math.round(0.2 * W - (cast.c - cast.r) * ISO.dx), y: Math.round(0.78 * H - (cast.c + cast.r) * ISO.dy) };
  pos.caster = { x: cast.c * ISO.cellWu, y: cast.r * ISO.cellWu };
  const k = (0.56 * W) / (2 * ISO.dx);
  pos.target = { x: (cast.c + k) * ISO.cellWu, y: (cast.r - k) * ISO.cellWu };
  st.buildGround(view);
  const report = [];
  let row = 0;
  for (const id of ids) {
    const d = byId.get(id);
    for (const lvl of levels) {
      fx = createFx(st.host(() => view), { style });
      fx.register(d);
      state.id = id; state.level = lvl;
      const origRandom = Math.random;
      Math.random = () => 0.37;
      director.play();
      Math.random = origRandom;
      const h = director.h;
      const total = isFinite(h.duration) ? h.duration : (d.demo?.hold ?? HOLD) + 0.4;
      if (!isFinite(h.duration)) h.stop && setTimeout(() => {}, 0);
      const stopAt = d.demo?.hold ?? HOLD;
      const times = keyTimes(d, h, frames, stopAt);
      let tNow = 0;
      for (let f = 0; f < frames; f++) {
        const tf = times[f];
        while (tNow < tf - 1e-6) {
          const step = Math.min(1 / 120, tf - tNow);
          fx.update(step);
          tNow += step;
          if (!isFinite(h.duration) && tNow >= stopAt && !h._stopped) { h.stop(); h._stopped = true; }
        }
        // WebGL's viewport y is from the bottom
        const vpy = cv.height - (row + 1) * H;
        st.render(fx, { view, vp: { x: f * W, y: vpy, w: W, h: H }, night, clear: true });
      }
      report.push({ id, level: lvl, duration: total, layers: fx.drawList().length });
      row++;
    }
  }
  window.__sheet = { done: true, report, errors: [...st.fxgl.errors], w: cv.width, h: cv.height };
}

if (SHEET) sheet().catch((e) => { window.__sheet = { done: true, error: String(e.stack || e) }; });
else boot();
