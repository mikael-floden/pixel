import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";

/* EMBER SPARKS — what comes off a fire and goes UP.
 *
 * The maintainer set the two conditions himself: "Ember sparks need to both
 * know if this is a fire AND where the fire/light source is."
 *
 * WHERE is solved and shared with the moths: `__ml.lightsInView` publishes the
 * DRAWN position of a source's glowing pixels, so a spark leaves the flame
 * rather than the object's foot.
 *
 * WHETHER IT IS A FIRE IS NOT IN THE DATA, and that is worth stating plainly
 * because it decides how this file is written. Nothing published says a light
 * burns:
 *   - the scenery light block is {strength, color, radius, states} — no type;
 *   - `tags` is ["SCENERY"] on every piece;
 *   - the game's own `flicker` is a BRIGHTNESS decision, not a semantic one:
 *     `lightKindOf` matches /light|lamp|lantern|torch|brazier|fire|candle|
 *     beacon|hearth|forge/, so a street lamp is "flame" to it;
 *   - and colour cannot classify — the_game's torch_post_004 is a blue resin
 *     flame (#b4d7ff) and brazier_001's first state is cyan, while plenty of
 *     cold glows are warm.
 * The world lights 143 pieces across 17 groups and most of them are crystals,
 * mushrooms, toadstool rings, waystones and streetlights.
 *
 * So until the scenery domain publishes a `type` beside `strength` (the game's
 * own light notes already anticipate it), this file classifies by the piece's
 * GROUP — the published `group/id` the placement carries. An allowlist, and it
 * is deliberately CONSERVATIVE: a fire that is missed shows nothing, while a
 * crystal that is wrongly counted throws sparks out of a rock, which is a bug
 * anyone can see. `FIRE_GROUPS` is the single line to delete when the real
 * field lands — see `isFire`.
 *
 * THE LOOK: a spark leaves the flame fast, slows as it rises (it is riding
 * heat, not thrown), wobbles across, COOLS from the fire's own colour toward a
 * deep red, and winks out. It never simply appears or vanishes: it brightens
 * out of the flame over its first breath and dies by cooling. Sparks come in
 * BURSTS, because a fire pops rather than pours.
 */

const KEY = "amb-ember";
const DEPTH = 900_000.08; // over the darkness overlay, like every other ambient mark
const GAIN_TAU = 1400;

const LIGHT_MS = 560; // how often the light list is re-read (NOT per frame)
const MAX_SPARKS = 30;
const PER_FIRE = 10;
const MIN_R = 1; // cells — even a candle-sized fire may spark

/** The fires, by published piece group. THE ONE LINE TO REPLACE when scenery
 * publishes a light type. Conservative on purpose: crystal_trees, crystals,
 * giant_mushrooms, mushrooms, toadstool_rings, soulstone_outcrops, waystones,
 * ancient_trees, streetlights and lantern_posts all light the_game and none of
 * them burns. wayside_shrines and beacons are left OUT pending his call — a
 * shrine may hold a votive flame and a beacon may be a bonfire, but may equally
 * be a magic light, and inventing that is how sparks end up over a rock. */
const FIRE_GROUPS = new Set([
  "campfire", "campfires", "bonfires",
  "braziers", "hearths", "forges", "fire_pits", "firepits",
  "cauldron_camps", "charcoal_kilns", "torch_posts", "torches",
]);

const isFire = (piece: string): boolean => FIRE_GROUPS.has((piece || "").split("/")[0]);

const LIFE: [number, number] = [700, 1700];
const RISE0: [number, number] = [34, 78]; // px/s at the flame
const RISE_DRAG = 0.55; // how much of that speed is left at the end of its life
const SIDE: [number, number] = [4, 16]; // px of sideways wander over the whole rise
const WOBBLE_HZ: [number, number] = [0.9, 2.4];
const START_SPREAD = 4; // px — sparks leave the flame's width, not one point

const BURST_GAP: [number, number] = [240, 1500]; // ms between bursts from one fire
const BURST: [number, number] = [1, 4]; // sparks per burst

const IN_MS = 90; // brighten out of the flame — fast, it is already burning
const COOL = 0x8c1c06; // what an ember cools toward before it dies
const ALPHA: [number, number] = [0.55, 1];

interface Spark {
  sprite: Phaser.GameObjects.Image;
  fire: number;
  x: number;
  y: number;
  age: number;
  life: number;
  up: number; // px/s at birth
  side: number; // px across, over the whole rise
  ph: number;
  hz: number;
  base: number;
  tint: number; // the fire's own colour, cooled per frame
  live: boolean;
}

interface Fire {
  id: string;
  x: number;
  y: number;
  color: number;
  gap: number;
}

export function embersFeature(): AmbientFeature {
  const sparks: Spark[] = [];
  let fires: Fire[] = [];
  let lightAge = 0;
  let probes = 0;
  let lit = 0; // how many lights were in view at the last read (QA)
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let seed = 40_961;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const range = ([a, b]: [number, number]) => a + rnd() * (b - a);

  const readFires = (): Fire[] => {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const f = ml?.lightsInView as
      | undefined
      | ((pad?: number) => {
          id: string; x: number; y: number; r: number; piece: string;
          color: [number, number, number]; sealed: boolean;
        }[]);
    if (!f) return [];
    probes++;
    try {
      const all = f(48) || [];
      lit = all.length;
      return all
        .filter((l) => !l.sealed && l.r >= MIN_R && isFire(l.piece))
        .map((l) => {
          // The light's own colour, normalised — a blue resin torch throws blue
          // sparks, which is the whole reason this is read rather than assumed.
          const peak = Math.max(l.color[0], l.color[1], l.color[2], 0.001);
          const ch = (v: number) => Math.max(60, Math.min(255, Math.round((v / peak) * 255)));
          return {
            id: l.id, x: l.x, y: l.y,
            color: (ch(l.color[0]) << 16) | (ch(l.color[1]) << 8) | ch(l.color[2]),
            gap: range(BURST_GAP),
          };
        });
    } catch {
      return [];
    }
  };

  const mix = (a: number, b: number, k: number) => {
    const m = (sh: number) =>
      Math.round(((a >> sh) & 255) + (((b >> sh) & 255) - ((a >> sh) & 255)) * k) & 255;
    return (m(16) << 16) | (m(8) << 8) | m(0);
  };

  const emit = (ctx: AmbientCtx, fi: number, fire: Fire) => {
    let s = sparks.find((q) => !q.live);
    if (!s && sparks.length < MAX_SPARKS) {
      s = {
        sprite: ctx.scene.add.image(0, 0, KEY).setOrigin(0.5, 0.5).setScale(1).setVisible(false),
        fire: fi, x: 0, y: 0, age: 0, life: 0, up: 0, side: 0, ph: 0, hz: 1, base: 1,
        tint: 0xffffff, live: false,
      };
      sparks.push(s);
    }
    if (!s) return; // at the ceiling
    s.fire = fi;
    s.x = fire.x + (rnd() - 0.5) * 2 * START_SPREAD;
    s.y = fire.y + (rnd() - 0.5) * START_SPREAD;
    s.age = 0;
    s.life = range(LIFE);
    s.up = range(RISE0);
    s.side = range(SIDE) * (rnd() < 0.5 ? 1 : -1);
    s.ph = rnd() * Math.PI * 2;
    s.hz = range(WOBBLE_HZ);
    s.base = range(ALPHA);
    s.tint = fire.color;
    s.live = true;
    s.sprite.setVisible(true).setAlpha(0);
  };

  return {
    name: "embers",
    init(ctx) {
      // One pixel, painted WHITE — setTint multiplies, so the drawn colour is
      // the fire's own, cooling as the spark rises.
      if (!ctx.scene.textures.exists(KEY)) {
        const g = ctx.scene.make.graphics({ x: 0, y: 0 }, false);
        g.fillStyle(0xffffff, 1);
        g.fillRect(0, 0, 1, 1);
        g.generateTexture(KEY, 1, 1);
        g.destroy();
      }
    },
    update(ctx, dt) {
      // Embers read at any hour but they only really tell after dark, so this
      // leans on night without switching off in daylight.
      const target = forced ? 1 : suppressed ? 0 : 0.25 + 0.75 * ctx.env.night;
      gain += (target - gain) * Math.min(1, (dt / GAIN_TAU) * 3);
      const g = gain * ctx.outdoor;
      if (g <= 0.02) {
        for (const s of sparks) if (s.sprite.visible) { s.sprite.setVisible(false); s.live = false; }
        fires = [];
        return;
      }

      lightAge += dt;
      if (lightAge >= LIGHT_MS) {
        lightAge = 0;
        const next = readFires();
        // Keep each fire's own burst clock across a re-read, or a fire that
        // stays in view would restart its timer twice a second and never pop.
        for (const f of next) {
          const was = fires.find((o) => o.id === f.id);
          if (was) f.gap = was.gap;
        }
        fires = next;
      }

      // ---- the fires pop ----
      const secs = dt / 1000;
      for (let fi = 0; fi < fires.length; fi++) {
        const f = fires[fi];
        f.gap -= dt;
        if (f.gap > 0) continue;
        f.gap = range(BURST_GAP);
        const alive = sparks.filter((q) => q.live && q.fire === fi).length;
        const want = Math.min(Math.round(range(BURST)), PER_FIRE - alive);
        for (let k = 0; k < want; k++) emit(ctx, fi, f);
      }

      // ---- the sparks rise ----
      for (const s of sparks) {
        if (!s.live) continue;
        s.age += dt;
        const t = s.age / s.life;
        if (t >= 1) { s.live = false; s.sprite.setVisible(false); continue; }

        // Riding heat: fast at the flame, slowing as it goes.
        const speed = s.up * (1 - (1 - RISE_DRAG) * t);
        s.y -= speed * secs;
        s.x += (s.side / s.life) * dt + Math.sin(s.ph + (s.age / 1000) * s.hz * Math.PI * 2) * 0.35;

        /* IN, THEN COOL. It brightens out of the flame over its first breath and
         * then dies by COOLING rather than by being switched off: the tint runs
         * from the fire's own colour toward a deep red as the alpha falls, which
         * is what an ember does and what keeps it from reading as a fading dot. */
        const rise = Math.min(1, s.age / IN_MS);
        const fade = t < 0.35 ? 1 : 1 - (t - 0.35) / 0.65;
        const iy = Math.round(s.y);
        s.sprite
          .setPosition(Math.round(s.x), iy)
          .setDepth(DEPTH + iy * 1e-6)
          .setTint(mix(s.tint, COOL, Math.min(1, t * 1.3)))
          .setAlpha(g * s.base * rise * fade * fade)
          .setBlendMode(Phaser.BlendModes.ADD);
      }
    },
    setSuppressed(on) { suppressed = on; },
    setForced(on) { forced = on; },
    debug() {
      const live = sparks.filter((s) => s.live && s.sprite.visible);
      return {
        gain: +gain.toFixed(3),
        probes, // QA: the light list walks every source — it must stay throttled
        lights: lit, // how many lights were in view at all
        fires: fires.length, // ...and how many of those are fires
        fireList: fires.map((f) => ({ id: f.id, x: Math.round(f.x), y: Math.round(f.y), color: f.color })),
        sparks: live.length,
        all: live.map((s) => ({
          x: Math.round(s.sprite.x), y: Math.round(s.sprite.y),
          fire: s.fire, t: +(s.age / s.life).toFixed(3),
          a: +s.sprite.alpha.toFixed(3), tint: s.sprite.tintTopLeft,
          fx: Math.round(fires[s.fire]?.x ?? 0), fy: Math.round(fires[s.fire]?.y ?? 0),
        })),
      };
    },
    dispose() {
      for (const s of sparks) s.sprite.destroy();
      sparks.length = 0;
      fires = [];
    },
  };
}
