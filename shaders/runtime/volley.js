// VOLLEYS — one cast, several copies of an effect in a FORMATION.
//
//   fx.play("fire/fireball", { level, from, to, count: 3, formation: "fan" })
//
// The skill decides HOW MANY (count, 2..12); the shader agent owns HOW THEY
// FLY (the formation's spacing, stagger and curve) — the same split as level
// vs look. Each copy is a full effect of its own seed and fires its own
// release / impact (projectiles) or release / peak (bursts) with its index.
//
// A formation maps (i, n, ctx) -> the copy's offsets. ctx: { D (cells from
// caster to target), g (ground unit dir caster->target), seed, cellWu }.
// Returned fields (all optional):
//   delay  s after the volley's release that this copy releases
//   bow    cells, a sideways bulge of the flight path (+ = left of travel)
//   land   [x, y] wu added to the landing point (projectiles) / spot (bursts)
//   ground true: lands ON the ground (z 0), not at the target's chest
//   arc    px added to the effect's own arc
//   dest   [x, y] wu from the CASTER: a fixed landing point (ring)

export const MAX_VOLLEY = 12;

const frac = (v) => v - Math.floor(v);
/** A deterministic 0..1 per (seed, i, salt): re-runs reproduce a volley. */
const rnd = (seed, i, salt) => frac(Math.sin(seed * 91.7 + i * 12.9898 + salt * 78.233) * 43758.5453);
const jitter = (seed, i, salt, amp) => (rnd(seed, i, salt) * 2 - 1) * amp;
/** A point of a sunflower disk: n points spread evenly over radius R. */
const disk = (i, n, R, seed) => {
  const r = R * Math.sqrt((i + 0.5) / n);
  const a = i * 2.399963 + seed * 6.2832;
  return [Math.cos(a) * r, Math.sin(a) * r];
};

export const FORMATIONS = {
  fan: {
    kinds: ["projectile"],
    label: "Fan",
    about: "leave the hand together a beat apart, bow out to both sides and converge on the target",
    at: (i, n, c) => {
      const k = i - (n - 1) / 2, half = (n - 1) / 2 || 1;
      const B = Math.min(1.3, 0.25 + 0.14 * c.D);
      return {
        delay: 0.045 * i,
        bow: (B * k) / half,
        land: [jitter(c.seed, i, 1, 0.12) * c.cellWu, jitter(c.seed, i, 2, 0.12) * c.cellWu],
      };
    },
  },
  barrage: {
    kinds: ["projectile"],
    label: "Barrage",
    about: "one after another down the same line, a rapid rhythm of releases and impacts",
    at: (i, n, c) => ({
      delay: 0.13 * i,
      land: [jitter(c.seed, i, 1, 0.18) * c.cellWu, jitter(c.seed, i, 2, 0.18) * c.cellWu],
    }),
  },
  spread: {
    kinds: ["projectile"],
    label: "Spread",
    about: "a cone: released together, straight lines that land side by side across the target",
    at: (i, n, c) => {
      const k = i - (n - 1) / 2;
      const S = Math.min(1.0, Math.max(0.5, 0.28 * c.D)) * c.cellWu;
      const px = -c.g[1], py = c.g[0];
      const a = jitter(c.seed, i, 3, 0.15) * c.cellWu;
      return { delay: 0.02 * i, land: [px * S * k + c.g[0] * a, py * S * k + c.g[1] * a] };
    },
  },
  rain: {
    kinds: ["projectile", "burst"],
    label: "Rain",
    about: "lobbed high (projectiles) or dropped (bursts) and scattered over the target area",
    at: (i, n, c, kind) => {
      const R = (kind === "burst" ? 0.8 + 0.22 * n : 0.5 + 0.18 * n) * c.cellWu;
      const [x, y] = disk(i, n, R, c.seed);
      return {
        delay: (kind === "burst" ? 0.11 : 0.08) * i + rnd(c.seed, i, 4) * 0.04,
        land: [x, y],
        ground: true,
        arc: kind === "burst" ? 0 : 50 + 6 * n,
      };
    },
  },
  ring: {
    kinds: ["projectile", "burst"],
    label: "Ring",
    about: "outward in every direction from the caster (projectiles) or a circle around the spot (bursts)",
    at: (i, n, c, kind) => {
      const a0 = Math.atan2(c.g[1], c.g[0]);
      const a = a0 + (i / n) * Math.PI * 2;
      if (kind === "burst") {
        const R = (1.0 + 0.18 * n) * c.cellWu;
        return { delay: 0.035 * i, land: [Math.cos(a) * R, Math.sin(a) * R] };
      }
      const R = Math.max(2.5, c.D) * c.cellWu;
      return { delay: 0.012 * i, dest: [Math.cos(a) * R, Math.sin(a) * R], ground: true };
    },
  },
  line: {
    kinds: ["burst"],
    label: "Line",
    about: "a row marching from the caster to the target, each a beat after the last",
    at: (i, n, c) => {
      // spots at (i+1)/n of the way from the caster to the spot, the last ON it
      const back = ((n - 1 - i) / n) * c.D * c.cellWu;
      return { delay: 0.09 * i, land: [-c.g[0] * back, -c.g[1] * back] };
    },
  },
};

/** The formations an effect supports: its own `volley` list, else the kind's
 *  default (every projectile formation; bursts only when they opt in). */
export function formationsOf(def) {
  if (def.volley === false) return [];
  if (Array.isArray(def.volley)) return def.volley.filter((f) => FORMATIONS[f]?.kinds.includes(def.kind));
  if (def.kind === "projectile") return Object.keys(FORMATIONS).filter((f) => FORMATIONS[f].kinds.includes("projectile"));
  return [];
}
