// FxWorld — the effect manager the game (and the viewer) owns ONE of.
//
//   const fx = createFx(host);            // host.project(x, y) is required
//   fx.register(def)                      // or registerAll(library)
//   const h = fx.play("fire/fireball", { level: 7, from, to, owner: "self" });
//   h.flightTime                          // s from play() to impact — schedule damage on it
//   h.on("impact", (i) => ...)            // or listen (i = which copy / which hop, else 0)
//   fx.play(id, { ..., release: 0.25 })   // leave the hand on the cast animation's release frame
//   fx.play(id, { ..., count: 3, formation: "fan" })   // a volley (see volley.js)
//   fx.update(dtSeconds)                  // once per frame
//   fx.drawList()                         // what to draw this frame (renderers consume it)
//   fx.lights()                           // what may light the world this frame
//
// COORDINATES: every position is the GAME'S WORLD SPACE — x, y in world units
// on the ground (the same numbers the server moves bodies with) plus z, a
// height in world px above the ground at that point. The host's project()
// turns (x, y) into the Phaser world point of that ground (terrain lift and
// view rotation included); the runtime never does iso math of its own, so a
// turned view or a raised plateau just works. A position may be a FUNCTION
// returning {x, y, z}: it is re-read every frame (a homing bolt, an aura on a
// walking body).

import { tuneDefaults } from "./define.js";
import { FORMATIONS, formationsOf, MAX_VOLLEY } from "./volley.js";

const DEF_CELL_WU = 32;
const DEF_BASIS = [32, 14, -32, 14]; // px per cell: world +x, world +y (unturned view)
export const DEFAULT_STYLE = Object.freeze({ pixel: true, bands: 5, dither: true, stepFps: 0, bright: 1 });
export const PLANE_ORDER = { ground: 0, body: 1, air: 2, screen: 3 };

const clampLevel = (l) => Math.max(1, Math.min(10, Math.round(Number(l) || 1)));
const val = (v, s, dflt) => (typeof v === "function" ? v(s) : v === undefined ? dflt : v);
const read = (p) => (typeof p === "function" ? p() : p);

export function createFx(host, opts) {
  return new FxWorld(host, opts);
}

export class FxWorld {
  constructor(host = {}, opts = {}) {
    if (typeof host.project !== "function") throw new Error("createFx: host.project(x, y) is required");
    this.host = host;
    this.cellWu = host.cellWu || DEF_CELL_WU;
    this.defs = new Map();
    this.insts = [];
    this.tuning = {}; // effect id -> { tunable: value } (live/tuning/shaders.json)
    this.style = { ...DEFAULT_STYLE, ...(opts.style || {}) };
    this.seq = 1;
    this.log = opts.log || ((m) => console.warn(m));
  }

  register(def) {
    this.defs.set(def.id, def);
    return this;
  }
  registerAll(defs) {
    for (const d of defs) this.register(d);
    return this;
  }
  /** The maintainer's tuned values, keyed by effect id (or by the repo-path
   *  key the wiki writes: "shaders/library/<id>"). Replaces the whole table. */
  setTuning(table) {
    const t = {};
    for (const k in table || {}) {
      const id = k.replace(/^shaders\/library\//, "");
      const { was, updated_at, ...vals } = table[k] || {};
      t[id] = vals;
    }
    this.tuning = t;
    return this;
  }
  setStyle(style) {
    this.style = { ...this.style, ...style };
    return this;
  }

  /** Start an effect. Unknown id -> a harmless dead handle (logged once).
   *  `count` > 1 plays a VOLLEY in `formation` (see volley.js): one handle,
   *  every copy's release / impact / peak fired with its index. */
  play(id, params = {}) {
    const made = this.make(id, params);
    if (made) for (const i of made.insts) this.insts.push(i);
    return made ? made.handle : deadHandle(id);
  }

  /** The schedule play() WOULD run, without playing it: [{ event, index, t }]
   *  in seconds from play(), sorted. A sustained effect without a duration
   *  has no stop/end yet. (The wiki's timeline and sound preview read this.) */
  timeline(id, params = {}) {
    const made = this.make(id, params);
    return made ? made.handle.timeline() : [];
  }

  make(id, params) {
    const def = this.defs.get(id);
    if (!def) {
      this.log(`[shaders] unknown effect "${id}"`);
      return null;
    }
    const n = Math.max(1, Math.min(MAX_VOLLEY, Math.round(Number(params.count) || 1)));
    if (n > 1) {
      const forms = formationsOf(def);
      if (forms.length) {
        const f = forms.includes(params.formation) ? params.formation : forms[0];
        if (params.formation && params.formation !== f) this.log(`[shaders] ${id}: no formation "${params.formation}", playing "${f}"`);
        const v = new FxVolley(this, def, params, n, f);
        return { insts: v.children, handle: v.handle };
      }
      this.log(`[shaders] ${id} plays no volley; count ${n} ignored`);
    }
    const inst = new FxInstance(this, def, params, this.seq++);
    return { insts: [inst], handle: inst.handle };
  }

  /** Advance every effect by dt seconds; fire events; drop finished ones. */
  update(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.25); // a tab-in must not skip a whole cast
    for (const i of this.insts) i.update(dt);
    this.insts = this.insts.filter((i) => !i.dead);
  }

  clear() {
    for (const i of this.insts) i.dead = true;
    this.insts.length = 0;
  }

  get count() {
    return this.insts.length;
  }

  /** Every layer to draw this frame (see LayerDraw in index.d.ts), in a
   *  sensible default order: plane, then ground depth, then spawn order. */
  drawList(out = []) {
    out.length = 0;
    for (const i of this.insts) i.collect(out);
    out.sort((a, b) => PLANE_ORDER[a.plane] - PLANE_ORDER[b.plane] || a.sortY - b.sortY || a.order - b.order);
    return out;
  }

  /** Lights this frame, strongest first. Each: { x, y (wu), z (px), radius
   *  (cells), color [r,g,b] (intensity folded in, may exceed 1), flicker,
   *  weight, owner, id }. The game binds lights()[0] of its owner to the
   *  reserved slot (games2 lightslots.ts setSelfFxLight / setMonsterFxLight).
   *  A volley is ONE light (its copies merged), so it fits one slot. */
  lights(filter) {
    const out = [];
    const groups = new Map();
    for (const i of this.insts) {
      const l = i.light();
      if (!l) continue;
      if (!i.group) {
        out.push(l);
        continue;
      }
      let a = groups.get(i.group);
      if (!a) groups.set(i.group, (a = []));
      a.push(l);
    }
    for (const [g, ls] of groups) out.push(ls.length === 1 ? ls[0] : mergeLights(ls, g.handle, this.cellWu));
    const res = filter ? out.filter(filter) : out;
    res.sort((a, b) => b.weight - a.weight);
    return res;
  }

  // --- geometry helpers shared by instances ---
  /** A position's screen point. `sx` shifts it sideways in screen px: the
   *  wand tip of a cast animation is a SCREEN offset from the feet. */
  screenOf(P) {
    const g = this.host.project(P.x, P.y);
    return { x: g.x + (P.sx || 0), y: g.y - (P.z || 0) };
  }
  groundOf(P) {
    return this.host.project(P.x, P.y);
  }
  /** px per CELL of world +x and world +y at a point (screen, y down). */
  basisAt(P) {
    if (this.host.basis) return this.host.basis(P.x, P.y);
    const e = 0.01;
    const o = this.host.project(P.x, P.y);
    const a = this.host.project(P.x + e, P.y);
    const b = this.host.project(P.x, P.y + e);
    const k = this.cellWu / e;
    const B = [(a.x - o.x) * k, (a.y - o.y) * k, (b.x - o.x) * k, (b.y - o.y) * k];
    // A step in terrain lift under the probe reads as a huge vertical: fall
    // back to the flat default rather than squash a ring into a line.
    const n1 = Math.hypot(B[0], B[1]), n2 = Math.hypot(B[2], B[3]);
    if (!(n1 > 8 && n1 < 200 && n2 > 8 && n2 < 200)) return DEF_BASIS.slice();
    return B;
  }
}

function deadHandle(id) {
  const h = {
    id, kind: "none", seq: 0, count: 0, formation: null, flightTime: 0, impactAt: 0, releaseAt: 0,
    impacts: [], releases: [], duration: 0, done: true, time: 0,
    on() { return h; }, set() { return h; }, setTune() { return h; }, stop() {}, kill() {}, timeline() { return []; },
  };
  return h;
}

/** Call the listeners of `ev`. The first argument is the INDEX: which copy
 *  of a volley, which hop of a chain, else 0. */
function callListeners(list, ev, idx, handle, world, id) {
  for (const [n, fn] of list) {
    if (n === ev || n === "*") {
      try {
        fn(idx, handle, ev);
      } catch (e) {
        world.log(`[shaders] listener for ${id} ${ev} threw: ${e}`);
      }
    }
  }
}

/** A volley's copies as one light: at their weighted centre, reaching over
 *  their spread, their colours summed but capped (one slot must not blind). */
function mergeLights(ls, handle, cellWu) {
  let W = 0, x = 0, y = 0, z = 0, r = 0, fl = 0, peak = 0;
  const c = [0, 0, 0];
  for (const l of ls) {
    const w = l.weight || 1e-3;
    W += w; x += l.x * w; y += l.y * w; z += l.z * w;
    r = Math.max(r, l.radius);
    fl = Math.max(fl, l.flicker);
    for (let k = 0; k < 3; k++) c[k] += l.color[k];
    peak = Math.max(peak, l.color[0], l.color[1], l.color[2]);
  }
  x /= W; y /= W; z /= W;
  let spread = 0;
  for (const l of ls) spread = Math.max(spread, Math.hypot(l.x - x, l.y - y));
  const m = Math.max(c[0], c[1], c[2]), cap = peak * 1.6;
  if (m > cap) for (let k = 0; k < 3; k++) c[k] *= cap / m;
  const radius = r + (0.8 * spread) / cellWu;
  return { id: ls[0].id, owner: ls[0].owner, handle, x, y, z, radius, color: c, flicker: fl, weight: Math.max(c[0], c[1], c[2]) * radius };
}

/** A volley: n copies of one effect in a formation, one handle for all. */
class FxVolley {
  constructor(world, def, p, n, formation) {
    this.world = world;
    this.def = def;
    this.n = n;
    this.formation = formation;
    this.listeners = [];
    this.ended = false;
    // what the game may move while it flies (set({ from, to, at }))
    this.p = { from: p.from, to: p.to, at: p.at ?? p.to ?? p.from };
    const seed = p.seed === undefined ? Math.random() : p.seed;
    const burst = def.kind === "burst";
    const F = read(burst ? p.from ?? this.p.at : p.from) || read(this.p.at) || { x: 0, y: 0 };
    const T = read(burst ? this.p.at : p.to) || F;
    const D = Math.hypot(T.x - F.x, T.y - F.y) / world.cellWu;
    const g = D > 1e-3 ? norm(T.x - F.x, T.y - F.y) : [Math.SQRT1_2, -Math.SQRT1_2];
    const ctx = { D, g, seed, cellWu: world.cellWu };
    const offs = [];
    for (let i = 0; i < n; i++) offs.push(FORMATIONS[formation].at(i, n, ctx, def.kind) || {});
    const d0 = Math.min(...offs.map((o) => o.delay || 0));
    for (const o of offs) o.delay = (o.delay || 0) - d0;
    this.children = [];
    const R = p.release > 0 ? p.release : 0;
    let W = 0; // the first copy's release: the rest are timed from it
    for (let i = 0; i < n; i++) {
      const o = offs[i];
      const land = o.land || [0, 0];
      const cp = { ...p, count: undefined, formation: undefined, seed: (seed + i * 0.618034) % 1 };
      if (!burst) {
        cp.from = () => read(this.p.from);
        if (o.dest) {
          const dest = { x: F.x + o.dest[0], y: F.y + o.dest[1], z: o.ground ? 0 : undefined };
          cp.to = dest;
        } else {
          cp.to = () => {
            const q = read(this.p.to);
            return q && { x: q.x + land[0], y: q.y + land[1], z: o.ground ? 0 : q.z };
          };
        }
        cp.bow = o.bow || 0;
        cp.arcAdd = o.arc || 0;
        if (i > 0) {
          cp.release = W + o.delay;
          cp.gather = false; // one gather at the hand, not n stacked ones
        }
      } else {
        const shift = (P) => () => {
          const q = read(P);
          return q && { x: q.x + land[0], y: q.y + land[1], z: q.z };
        };
        cp.at = shift(this.p.at);
        cp.to = this.p.to !== undefined ? shift(this.p.to) : undefined;
        cp.release = R + o.delay;
      }
      const inst = new FxInstance(world, def, cp, world.seq++, this, i);
      if (i === 0) W = inst.releaseT - inst.origin;
      this.children.push(inst);
    }
    this.handle = this.makeHandle();
  }

  relay(ev, idx, inst) {
    if (ev === "cast" && inst.index !== 0) return;
    if (ev === "end") {
      if (this.ended || !this.children.every((c) => c.dead)) return;
      this.ended = true;
      idx = 0; // the volley's end, not a copy's
    }
    callListeners(this.listeners, ev, idx, this.handle, this.world, this.def.id);
  }

  makeHandle() {
    const self = this, C = this.children, kind = this.def.kind;
    const hs = C.map((c) => c.handle);
    const min = (a) => (a.length ? Math.min(...a) : 0);
    return {
      id: this.def.id,
      kind,
      seq: hs[0].seq,
      owner: hs[0].owner,
      count: this.n,
      formation: this.formation,
      releases: hs.map((h) => h.releaseAt),
      impacts: kind === "projectile" ? hs.map((h) => h.impactAt) : [],
      releaseAt: min(hs.map((h) => h.releaseAt)),
      flightTime: min(hs.map((h) => h.impactAt)),
      impactAt: min(hs.map((h) => h.impactAt)),
      get duration() { return Math.max(...hs.map((h) => h.duration)); },
      get done() { return C.every((c) => c.dead); },
      // a finished copy stops its clock: the volley's is the latest one's
      get time() { return Math.max(...hs.map((h) => h.time)); },
      on(ev, fn) { self.listeners.push([ev, fn]); return this; },
      set(q) {
        for (const k of ["from", "to", "at"]) if (q[k] !== undefined) self.p[k] = q[k];
        const { from, to, at, ...rest } = q;
        for (const h of hs) h.set(rest);
        return this;
      },
      stop() { for (const h of hs) h.stop(); },
      kill() { for (const h of hs) h.kill(); },
      setTune(t) { for (const h of hs) h.setTune(t); return this; },
      timeline() {
        const out = [];
        let end = 0;
        for (const h of hs) {
          for (const e of h.timeline()) {
            if (e.event === "cast" && e.index !== 0) continue;
            if (e.event === "end") { end = Math.max(end, e.t); continue; }
            out.push(e);
          }
        }
        if (end > 0) out.push({ event: "end", index: 0, t: end });
        return out.sort((a, b) => a.t - b.t);
      },
    };
  }
}

// Inverse ground basis for the shader: local px (y UP) -> cells, column-major.
function groundMatrix(B, scale) {
  const [a, b, c, d] = B; // e1 = (a, b), e2 = (c, d), y down
  const det = a * d - c * b || 1;
  const k = scale / det;
  return [d * k, -b * k, c * k, -a * k];
}

const norm = (x, y) => {
  const n = Math.hypot(x, y);
  return n > 1e-6 ? [x / n, y / n] : [1, 0];
};

const ONE_SHOT = new Set(["projectile", "melee", "burst", "chain"]);

class FxInstance {
  constructor(world, def, p, seq, group = null, index = 0) {
    this.world = world;
    this.def = def;
    this.seq = seq;
    this.group = group;
    this.index = index;
    this.dead = false;
    this.stopAt = Infinity;
    this.listeners = [];
    this.fired = new Set();
    this.oneShot = ONE_SHOT.has(def.kind);
    const level = clampLevel(p.level);
    this.p = {
      level,
      seed: p.seed === undefined ? Math.random() : p.seed,
      owner: p.owner,
      from: p.from,
      to: p.to,
      at: p.at ?? p.to ?? p.from,
      targets: p.targets || [],
      dir: p.dir,
      radius: p.radius,
      height: p.height ?? 88,
      targetHeight: p.targetHeight ?? p.height ?? 88,
      duration: p.duration,
      speed: p.speed,
      flightTime: p.flightTime,
      tune: p.tune,
      // s from play() to the moment the spell leaves the caster: the cast
      // animation's release frame. A projectile's gather fills it; every
      // other kind waits, unseen, and starts on it.
      release: p.release,
      bow: p.bow || 0, // volley: cells of sideways bulge
      arcAdd: p.arcAdd || 0, // volley: px of extra arc
      gather: p.gather !== false, // volley: only the first copy gathers
    };
    // A position's z defaults to where the body holds a spell / takes a hit:
    // the caster's hand (0.55 of its height), the target's chest (0.5).
    this.zFrom = 0.55 * this.p.height;
    this.zTo = def.targetZ !== undefined ? val(def.targetZ, { level, lv: (level - 1) / 9, theight: this.p.targetHeight }, 0) : 0.5 * this.p.targetHeight;
    this.tune = { ...tuneDefaults(def), ...(world.tuning[def.id] || {}), ...(p.tune || {}) };
    // The instance's level state, handed to every def function.
    this.base = { level, lv: (level - 1) / 9, seed: this.p.seed, tune: this.tune, kind: def.kind, height: this.p.height, theight: this.p.targetHeight };
    this.radius = this.p.radius ?? val(def.radius, this.base, 1.5);
    this.base.radius = this.radius;
    this.plan();
    // Instance time runs from `origin`: negative while a non-projectile waits
    // for its release, so every window below still starts at 0.
    this.T = this.origin;
    this.handle = this.makeHandle();
  }

  // ---- the timeline: phase windows [start, end) in instance seconds ----
  // Events, in firing order: cast (play() — the cast animation starts),
  // release (the spell leaves the caster), then the kind's own: impact,
  // hit, peak, hop:<k>, start; sustained kinds also fire stop (the outro
  // begins) from update(); every kind ends with end.
  plan() {
    const d = this.def, s = this.base, P = {};
    const layerDur = (phase) => {
      let m = 0;
      for (const L of d.layers) if (L.phase === phase) m = Math.max(m, val(L.delay, s, 0) + val(L.dur, s, 0));
      return m;
    };
    const R = this.p.release > 0 ? this.p.release : 0;
    this.origin = -R;
    switch (d.kind) {
      case "projectile": {
        const W = this.p.release >= 0 ? this.p.release : val(d.windup, s, 0);
        const from = read(this.p.from) || { x: 0, y: 0 }, to = read(this.p.to) || from;
        const cells = Math.hypot(to.x - from.x, to.y - from.y) / this.world.cellWu;
        const speed = Math.max(0.5, this.p.speed ?? val(d.speed, s, 10));
        const F = this.p.flightTime > 0 ? this.p.flightTime : Math.max(val(d.minFlight, s, 0.12), cells / speed);
        const I = Math.max(val(d.impactDur, s, 0), layerDur("impact"));
        P.windup = [0, W]; P.flight = [W, W + F]; P.impact = [W + F, W + F + I];
        this.flight = F; this.impactT = W + F; this.end = W + F + I;
        this.origin = 0; // a projectile's wait IS its windup: the gather shows
        this.releaseT = W;
        this.events = [["cast", 0], ["release", W], ["impact", W + F]];
        break;
      }
      case "melee": {
        const D = val(d.dur, s, 0.35);
        const H = val(d.hitAt, s, D * 0.5);
        const I = layerDur("hit");
        P.swing = [0, D]; P.hit = [H, H + I];
        this.end = Math.max(D, H + I);
        this.hitT = H;
        this.events = [["hit", H]];
        break;
      }
      case "chain": {
        const n = Math.max(1, this.p.targets.length);
        const hd = val(d.hopDelay, s, 0.12), hl = Math.max(val(d.hopDur, s, 0.3), layerDur("hop"));
        const I = layerDur("impact");
        this.hops = n; this.hopDelay = hd; this.hopLen = hl;
        P.main = [0, (n - 1) * hd + Math.max(hl, I)];
        this.end = P.main[1];
        this.events = [];
        for (let k = 0; k < n; k++) this.events.push([`hop:${k}`, k * hd]);
        break;
      }
      case "burst": {
        const D = Math.max(val(d.dur, s, 0), layerDur("main"));
        P.main = [0, D];
        this.end = D;
        this.events = [["peak", val(d.peakAt, s, 0)]];
        break;
      }
      default: {
        // beam / aura / zone / screen: sustained, until stop() or duration
        const I = val(d.intro, s, 0.2), O = val(d.outro, s, 0.3);
        this.intro = I; this.outro = O;
        const dur = this.p.duration ?? val(d.dur, s, undefined);
        if (dur !== undefined && isFinite(dur)) this.stopAt = Math.max(I, dur);
        this.events = [["start", I]];
      }
    }
    if (d.kind !== "projectile") {
      this.releaseT = 0;
      this.events.unshift(["cast", this.origin], ["release", 0]);
    }
    this.P = P;
  }

  /** The schedule, in seconds from play(). */
  timeline() {
    const o = this.origin, out = [];
    for (const [name, t] of this.events) {
      const k = name.indexOf(":");
      out.push({ event: k < 0 ? name : name.slice(0, k), index: k < 0 ? this.index : Number(name.slice(k + 1)), t: t - o });
    }
    if (this.oneShot) out.push({ event: "end", index: this.index, t: this.end - o });
    else if (isFinite(this.stopAt)) {
      out.push({ event: "stop", index: this.index, t: this.stopAt - o });
      out.push({ event: "end", index: this.index, t: this.stopAt + this.outro - o });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  // sustained kinds recompute their windows from stopAt each frame
  phases() {
    if (this.P.main || this.P.flight || this.P.swing) return this.P;
    const I = this.intro, O = this.outro, S = this.stopAt;
    return { intro: [0, I], loop: [I, S], outro: [S, S + O], sustain: [0, S + O] };
  }

  get finished() {
    if (this.oneShot) return this.T >= this.end;
    return this.T >= this.stopAt + this.outro;
  }

  update(dt) {
    const prev = this.T;
    this.T += dt;
    for (const [name, t] of this.events) {
      if (!this.fired.has(name) && prev <= t && this.T >= t) {
        this.fired.add(name);
        if (name === "impact") this.freezeImpact();
        this.emit(name);
      }
    }
    if (!this.oneShot && !this.fired.has("stop") && this.T >= this.stopAt) {
      this.fired.add("stop");
      this.emit("stop");
    }
    if (this.finished && !this.dead) {
      this.dead = true;
      this.emit("end");
    }
  }

  emit(name) {
    const k = name.indexOf(":");
    const ev = k < 0 ? name : name.slice(0, k);
    const idx = k < 0 ? this.index : Number(name.slice(k + 1));
    if (this.group) this.group.relay(ev, idx, this);
    else callListeners(this.listeners, ev, idx, this.handle, this.world, this.def.id);
  }

  makeHandle() {
    const self = this;
    const kind = this.def.kind;
    const o = this.origin;
    const hitT = kind === "projectile" ? this.impactT - o : kind === "melee" ? this.hitT - o : 0;
    return {
      id: this.def.id,
      kind,
      seq: this.seq,
      owner: this.p.owner,
      count: 1,
      formation: null,
      /** Seconds from play() to the release (the spell leaves the caster). */
      releaseAt: this.releaseT - o,
      /** Seconds from play() to impact (projectile), to the hit (melee). */
      flightTime: hitT,
      impactAt: hitT,
      releases: [this.releaseT - o],
      impacts: kind === "projectile" ? [hitT] : [],
      get duration() { return (self.oneShot ? self.end : self.stopAt + self.outro) - o; },
      get done() { return self.dead; },
      get time() { return self.T - o; },
      on(ev, fn) { self.listeners.push([ev, fn]); return this; },
      set(p) {
        for (const k of ["at", "from", "to", "dir", "targets", "height"]) if (p[k] !== undefined) self.p[k] = p[k];
        if (p.level !== undefined) {
          self.base.level = clampLevel(p.level);
          self.base.lv = (self.base.level - 1) / 9;
        }
        if (p.radius !== undefined) self.radius = self.base.radius = p.radius;
        return this;
      },
      /** A sustained effect plays its outro; a one-shot is cut short; one
       *  still waiting for its release never appears. */
      stop() {
        if (self.T < 0) self.dead = true;
        else if (!self.oneShot) {
          if (self.T < self.stopAt) self.stopAt = self.T;
        } else self.dead = true;
      },
      kill() { self.dead = true; },
      /** Live-edit tunables of the running effect (the wiki's sliders). */
      setTune(t) { Object.assign(self.tune, t); return this; },
      /** [{ event, index, t }]: every event, in seconds from play(). */
      timeline() { return self.timeline(); },
    };
  }

  // ---- positions (world px, y down) ----
  pt(P, dz) {
    const q = read(P);
    if (!q) return null;
    return { x: q.x, y: q.y, z: q.z ?? dz, sx: q.sx || 0 };
  }

  flightU() {
    const [a, b] = this.P.flight;
    return Math.max(0, Math.min(1, (this.T - a) / (b - a || 1)));
  }

  /** The projectile head: screen point, ground point, screen dir (y up). */
  headAt(u) {
    const d = this.def, s = this.base, w = this.world;
    const F = this.pt(this.p.from, this.zFrom), G = this.pt(this.p.to, this.zTo) || F;
    const a = w.screenOf(F), b = w.screenOf(G);
    const arc = val(d.arc, s, 0) + this.p.arcAdd;
    const [amp, cyc] = val(d.wave, s, [0, 0]);
    // a volley's sideways bulge: `bow` cells to the left of travel, on the
    // GROUND (so it sorts and lights where it flies), drawn through the basis
    let bgx = 0, bgy = 0, bsx = 0, bsy = 0;
    if (this.p.bow) {
      const [ux, uy] = norm(G.x - F.x, G.y - F.y);
      const B = w.basisAt(F);
      const cx = -uy * this.p.bow, cy = ux * this.p.bow; // cells
      bgx = cx * w.cellWu; bgy = cy * w.cellWu;
      bsx = cx * B[0] + cy * B[2]; bsy = cx * B[1] + cy * B[3];
    }
    const path = (v) => {
      const e = 4 * v * (1 - v);
      return [a.x + (b.x - a.x) * v + bsx * e, a.y + (b.y - a.y) * v - arc * e + bsy * e];
    };
    let [x, y] = path(u);
    // the nose follows the path's tangent (not the wave's wiggle)
    const p0 = path(Math.max(0, u - 0.01)), p1 = path(Math.min(1, u + 0.01));
    const [dx, dy] = norm(p1[0] - p0[0], -(p1[1] - p0[1]));
    if (amp) {
      const [nx, ny] = norm(-(b.y - a.y), b.x - a.x);
      const env = Math.sin(Math.PI * u);
      const off = amp * env * Math.sin(u * cyc * Math.PI * 2 + s.seed * 6.28);
      x += nx * off; y += ny * off;
    }
    const e = 4 * u * (1 - u);
    const gx = F.x + (G.x - F.x) * u + bgx * e, gy = F.y + (G.y - F.y) * u + bgy * e;
    const z = F.z + (G.z - F.z) * u + arc * e;
    return { x, y, gx, gy, z, dir: [dx, dy] };
  }

  freezeImpact() {
    if (this.def.kind !== "projectile") return;
    const h = this.headAt(1);
    const G = this.pt(this.p.to, this.zTo) || this.pt(this.p.from, this.zFrom);
    this.impact = { x: h.x, y: h.y, gx: G.x, gy: G.y, z: G.z, dir: h.dir };
  }

  /** Screen + ground position of a named anchor. */
  anchor(name, hop) {
    const w = this.world;
    let P;
    switch (name) {
      case "head": {
        if (this.def.kind === "projectile") {
          const h = this.headAt(this.flightU());
          return { x: h.x, y: h.y, gx: h.gx, gy: h.gy, z: h.z };
        }
        P = this.pt(this.p.from, this.zFrom);
        break;
      }
      case "impact": {
        if (this.impact) return this.impact;
        if (this.def.kind === "projectile") {
          this.freezeImpact();
          return this.impact;
        }
        P = this.pt(this.p.to, this.zTo) || this.pt(this.p.at, 0);
        break;
      }
      case "from": P = this.pt(this.p.from, this.zFrom) || this.pt(this.p.at, 0); break;
      case "to": P = this.pt(this.p.to, this.zTo) || this.pt(this.p.at, 0); break;
      case "target": P = this.pt(this.p.targets[hop] ?? this.p.to, this.zTo); break;
      case "prev": P = hop > 0 ? this.pt(this.p.targets[hop - 1], this.zTo) : this.pt(this.p.from, this.zFrom); break;
      default: P = this.pt(this.p.at, 0) || this.pt(this.p.from, this.zFrom);
    }
    if (!P) return null;
    const s = w.screenOf(P);
    return { x: s.x, y: s.y, gx: P.x, gy: P.y, z: P.z };
  }

  /** An anchor dropped to its ground point (z = 0). */
  flat(A) {
    if (!A) return A;
    const g = this.world.groundOf({ x: A.gx, y: A.gy });
    return { ...A, x: g.x, y: g.y, z: 0 };
  }

  /** Screen direction (y up) + ground direction (cells) of the effect. */
  direction(A, B) {
    if (A && B) {
      const g = norm(B.gx - A.gx, B.gy - A.gy);
      const sd = norm(B.x - A.x, -(B.y - A.y));
      const len = Math.hypot(B.x - A.x, B.y - A.y);
      return { dir: sd, gdir: g, len, glen: Math.hypot(B.gx - A.gx, B.gy - A.gy) / this.world.cellWu };
    }
    const d = read(this.p.dir);
    if (d) {
      const g = norm(d.x, d.y);
      const B0 = this.world.basisAt(read(this.p.at) || read(this.p.from) || { x: 0, y: 0 });
      const sx = g[0] * B0[0] + g[1] * B0[2], sy = g[0] * B0[1] + g[1] * B0[3];
      return { dir: norm(sx, -sy), gdir: g, len: 0, glen: 0 };
    }
    return { dir: [1, 0], gdir: norm(1, -1), len: 0, glen: 0 };
  }

  // ---- per-layer state ----
  layerWindow(L, phases, hop) {
    const s = this.base;
    const ph = L.phase || this.defaultPhase();
    let win;
    if (this.def.kind === "chain" && (ph === "hop" || ph === "impact")) {
      const k0 = hop * this.hopDelay;
      win = [k0, k0 + this.hopLen];
    } else {
      win = phases[ph];
    }
    if (!win) return null;
    const t0 = win[0] + val(L.delay, s, 0);
    const dur = L.dur !== undefined ? val(L.dur, s, 0) : win[1] - t0;
    return [t0, dur];
  }

  defaultPhase() {
    switch (this.def.kind) {
      case "projectile": return "flight";
      case "melee": return "swing";
      case "chain": return "hop";
      case "burst": return "main";
      default: return "sustain";
    }
  }

  defaultAnchor(L) {
    const ph = L.phase || this.defaultPhase();
    switch (this.def.kind) {
      case "projectile": return ph === "flight" ? "head" : ph === "impact" ? "impact" : "from";
      case "beam": return "from";
      case "chain": return ph === "impact" ? "target" : "prev";
      case "melee": return ph === "hit" ? "to" : "at";
      default: return "at";
    }
  }

  stateFor(L, hop) {
    const phases = this.phases();
    const win = this.layerWindow(L, phases, hop);
    if (!win) return null;
    const [t0, dur] = win;
    const t = this.T - t0;
    if (t < 0 || (isFinite(dur) && t > dur)) return null;
    const w = this.world, d = this.def;
    const kind = d.kind;
    const s = Object.assign({}, this.base);
    s.t = t;
    s.dur = dur;
    s.life = isFinite(dur) && dur > 0 ? t / dur : 0;
    s.T = this.T;
    s.phase = L.phase || this.defaultPhase();
    s.hop = hop || 0;
    // the envelope of a sustained layer
    let fade = 1;
    if (kind === "beam" || kind === "aura" || kind === "zone" || kind === "screen") {
      const I = this.intro, O = this.outro;
      const inF = I > 0 ? Math.min(1, this.T / I) : 1;
      const outF = this.T > this.stopAt ? Math.max(0, 1 - (this.T - this.stopAt) / (O || 1e-3)) : 1;
      fade = inF * outF;
      s.stopping = this.T > this.stopAt;
    }
    s.fade = fade;
    // anchor + direction
    const aname = L.at || this.defaultAnchor(L);
    const A = this.anchor(aname, hop);
    if (!A) return null;
    let D;
    if (kind === "projectile") {
      if (s.phase === "flight") D = { ...this.direction(this.anchor("from"), this.anchor("to")), dir: this.headAt(this.flightU()).dir };
      else if (s.phase === "impact") D = { ...this.direction(this.anchor("from"), this.anchor("to")), dir: (this.impact || this.headAt(1)).dir };
      else D = this.direction(this.anchor("from"), this.anchor("to"));
      if (s.phase === "flight") D.len = Math.hypot(A.x - this.anchor("from").x, A.y - this.anchor("from").y);
    } else if (kind === "beam") D = this.direction(this.anchor("from"), this.anchor("to"));
    else if (kind === "chain") D = this.direction(this.anchor("prev", hop), this.anchor("target", hop));
    // on the ground, a direction is a GROUND direction: the attacker's feet to
    // the victim's feet, never feet to chest (that tilts every slash upward)
    else if (this.p.to && (kind === "melee" || kind === "burst" || kind === "zone")) D = this.direction(this.flat(this.anchor("at")), this.flat(this.anchor("to")));
    else if (this.p.from && this.p.at && kind === "burst" && this.p.from !== this.p.at) D = this.direction(this.flat(this.anchor("from")), this.flat(this.anchor("at")));
    else D = this.direction(null, null);
    s.dir = D.dir;
    s.gdir = D.gdir;
    s.len = D.len;
    s.glen = D.glen;
    s.basis = w.basisAt({ x: A.gx, y: A.gy });
    s.anchor = A;
    return s;
  }

  collect(out) {
    const d = this.def, w = this.world, style = w.style;
    const hops = d.kind === "chain" ? this.hops : 1;
    const tn = this.tune;
    const size = tn.size ?? 1;
    const bright = (tn.bright ?? 1) * (style.bright ?? 1);
    const anim = tn.anim ?? 1;
    for (let hop = 0; hop < hops; hop++) {
      for (const L of d.layers) {
        if (d.kind !== "chain" && hop > 0) break;
        if (d.kind === "chain" && hop > 0 && L.phase !== "hop" && L.phase !== "impact") continue;
        if (!this.p.gather && L.phase === "windup") continue;
        if (L.when && !L.when(this.base)) continue;
        const s = this.stateFor(L, hop);
        if (!s) continue;
        const scale = L.fixedScale ? 1 : size;
        const b = L.box(s);
        if (!b || !(b.w > 0) || !(b.h > 0)) continue;
        const A = s.anchor;
        let ax = A.x, ay = A.y;
        if (L.plane === "ground" || L.lift === "ground") {
          const g = w.groundOf({ x: A.gx, y: A.gy });
          ax = g.x; ay = g.y;
        }
        if (L.offset) {
          const [ox, oy] = L.offset(s);
          ax += ox; ay -= oy;
        }
        const bw = Math.min(1024, Math.ceil(b.w * scale)), bh = Math.min(1024, Math.ceil(b.h * scale));
        const ox = b.ox * scale, oy = b.oy * scale;
        const t = s.t * anim;
        const tq = style.stepFps > 0 ? Math.floor(t * style.stepFps) / style.stepFps : t;
        const u = L.u ? L.u(s) : {};
        let plane = L.plane;
        let x = ax - ox, y = ay - (bh - oy);
        if (plane === "screen") {
          const v = w.host.view ? w.host.view() : { x: 0, y: 0, w: 640, h: 360 };
          x = v.x; y = v.y; ax = v.x + v.w / 2; ay = v.y + v.h / 2;
          out.push(this.item(L, s, { x, y, w: v.w, h: v.h, ax, ay }, u, tq, bright, style, 1, hop));
          continue;
        }
        const it = this.item(L, s, { x, y, w: bw, h: bh, ax, ay }, u, tq, bright, style, scale, hop);
        out.push(it);
      }
    }
  }

  item(L, s, r, u, tq, bright, style, scale, hop) {
    const d = this.def;
    const A = s.anchor;
    // A layer may SORT as if it stood `cells` nearer the camera than its
    // anchor (the front half of a ring covers the body inside it; flames on
    // a body draw over it). "Toward the camera" is screen-down on the ground.
    let gx = A.gx, gy = A.gy;
    if (L.sort) {
      const cells = L.sort(s);
      if (cells) {
        const [a, b, c, dd] = s.basis;
        const det = a * dd - c * b || 1;
        const [fx, fy] = norm(-c / det, a / det);
        gx += fx * cells * this.world.cellWu;
        gy += fy * cells * this.world.cellWu;
      }
    }
    const g = this.world.groundOf({ x: gx, y: gy });
    return {
      key: `${d.id}#${L.id}`,
      frag: L.frag,
      id: d.id,
      layer: L.id,
      plane: L.plane,
      emissive: L.emissive !== false,
      x: r.x, y: r.y, w: r.w, h: r.h, ax: r.ax, ay: r.ay,
      gx, gy, z: L.plane === "ground" ? 0 : A.z || 0,
      // the ground point's screen y: what a body standing here sorts by
      sortY: L.plane === "ground" ? g.y - r.h / 2 : g.y,
      groundY: g.y,
      order: this.seq * 64 + L.order + hop * 0.01,
      owner: this.p.owner,
      handle: this.handle,
      std: {
        uTime: tq, uLife: s.life, uFade: s.fade, uLevel: s.level, uLv: s.lv, uSeed: s.seed,
        uDir: s.dir, uGDir: s.gdir, uLen: s.len / scale,
        uGround: groundMatrix(s.basis, scale),
        uBands: style.bands, uDither: style.dither ? 1 : 0, uBright: bright,
        uScale: scale,
      },
      u,
      scale,
    };
  }

  /** This effect's light this frame, or null. */
  light() {
    const d = this.def;
    if (!d.light || this.T < 0) return null;
    const phases = this.phases();
    let name = null;
    for (const k in phases) {
      const [a, b] = phases[k];
      if (this.T >= a && this.T < b && k !== "sustain") { name = k; break; }
    }
    if (!name) name = this.defaultPhase();
    if (name === "windup" && !this.p.gather) return null;
    const win = phases[name] || [0, 1];
    const s = Object.assign({}, this.base, {
      phase: name,
      t: this.T - win[0],
      life: isFinite(win[1] - win[0]) && win[1] > win[0] ? (this.T - win[0]) / (win[1] - win[0]) : 0,
      T: this.T,
      fade: 1,
    });
    if (this.intro !== undefined) {
      const inF = this.intro > 0 ? Math.min(1, this.T / this.intro) : 1;
      const outF = this.T > this.stopAt ? Math.max(0, 1 - (this.T - this.stopAt) / (this.outro || 1e-3)) : 1;
      s.fade = inF * outF;
    }
    const l = d.light(s);
    if (!l || !(l.intensity > 0) || !(l.radius > 0)) return null;
    const at = l.at || (this.def.kind === "projectile" ? (name === "flight" ? "head" : name === "impact" ? "impact" : "from") : this.defaultAnchor({ phase: name }));
    const hop = this.def.kind === "chain" ? Math.min(this.hops - 1, Math.floor(this.T / (this.hopDelay || 1))) : 0;
    s.hop = hop;
    const A = this.anchor(l.at || at, hop);
    if (!A) return null;
    const k = l.intensity * (this.tune.bright ?? 1);
    return {
      id: d.id,
      owner: this.p.owner,
      handle: this.handle,
      x: A.gx, y: A.gy, z: l.z ?? A.z ?? 0,
      radius: l.radius,
      color: [l.color[0] * k, l.color[1] * k, l.color[2] * k],
      flicker: l.flicker ?? 0,
      weight: k * l.radius,
    };
  }
}
