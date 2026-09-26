# Writing an effect — the visual language and the recipe

For the effects agent and its assistant. The library is meant to reach 500+
effects, so every one must be quick to write AND unmistakably part of one
game. The rules below are what the first 31 taught.

## The look (house style)

- **Pixel-true.** An effect is computed per ART pixel and scaled like the
  sprites. Shapes are hard-edged; soft light is ordered dither, not alpha
  mush. `qz(v, p)` quantizes a value into the style's bands (5) with Bayer
  dither; `cut(v, edge, p)` is a hard (dithered) edge; `dglow(v, p)` is a
  dithered glow that stops at 0.06.
- **Palettes are ramps of 3-5 colours**, dark to hot: fire = soot, ember,
  flame, yellow, white. Tunables are the ramp's anchor colours; the in-between
  stops are derived (`mix3`, `scale3`), so a maintainer's colour change keeps
  the ramp coherent.
- **One element, one language.** All fire uses the same ramp and the same
  flame noise (`FLAME`, `COMET`); all frost is faceted and hard; holy is clean
  white-gold with hard edges; shadow is drawn inside-out (a dark core with a
  bright rim, painted smoke); poison is wet (bubbles, drips, froth); physical
  (earth, weapons, monsters) is painted matter plus one bright accent at the
  moment of impact.
- **Read at a glance.** The first frame of an impact is the brightest (a white
  flash disk for 1-2 frames); direction is always visible (trails behind,
  sparks away from the source, rakes along the attack); a status reads as a
  symbol (stars = stunned, vines = rooted, bubbles = poisoned).
- **Wrap bodies, don't sticker them.** Anything around a body is two layers:
  a back half that sorts behind the body and a front half over it
  (`sort: () => ±cells`, and the shader keeps only its half — see
  `holy/heal`'s MOTES or `frost/frost_nova`'s SPIKES). Fire on a body goes
  mostly BEHIND it so the body cuts it into a silhouette (`fire/burning`).
- **Levels are visible upgrades**, not just scale: 1-3 the basic form, 4 adds
  a feature (sparks, a ring, leaves), 7 adds another (a second ring, a helix,
  a crater), 10 is a showpiece. `lv(s, a, b)` for continuous growth,
  `tier(s, n)` / `when: (s) => s.level >= n` for unlocks. Write it down in
  `levels`.
- **Light is part of the design**: every luminous effect returns a `light(s)`
  with an envelope (a flash that decays, a steady glow while sustained). It is
  what makes a fireball light the forest at night.

## The recipe

1. Pick the kind (the table in the README) and the family.
2. `library/<family>/<name>.js`, `export default defineEffect({...})` with
   `id` = the path, `name`, `kind`, `family`, `category`, `tags`, `thinking`,
   `levels`, `tune` (colours first, then feature switches), the kind's timing
   (`dur`, `speed`, `windup`, `intro`/`outro`, `hopDelay`, `hitAt`, `peakAt`),
   `radius` if it has a ground reach, `light`, and `layers`.
3. A layer: `id`, `phase` (projectile: windup | flight | impact; melee: swing |
   hit; chain: hop | impact; sustained: intro | loop | outro | sustain; burst:
   main), `plane`, `emissive`, `at` (anchor: from | to | at | head | impact |
   target | prev), optional `delay`/`dur`, `when`, `sort`, `offset`, `lift`,
   `fixedScale` (radius-bound ground layers), `box(s)` (from `box.*` — keep it
   tight: it IS the fill cost), `u(s)` (its uniforms), `frag` (GLSL).
4. The shader: `vec4 effect(vec2 p)` with p in world px from the anchor, y up.
   Helpers (prelude): `along(p)` (the direction frame), `gnd(p)` (ground cells),
   `galong(g)`, `ringPx(g, R)` (a ground ring of constant pixel width),
   `fall(d, r)`, `fbm`, `vnoise`, `ridged`, `voronoi`, `sdSeg`, `sdStar`,
   `ramp3/4/5`, `paint` (covers), `hot` (covers and is light), `glow` (adds),
   `over`. Standard uniforms: `uTime uLife uFade uLevel uLv uSeed uDir uGDir
   uLen uBright`. Snippets: `_shared/snippets.js` (SPARKS, SMOKE, SHOCK, BOLT,
   FLAME, COMET, FLOW, CLOUD, STAR4, MOTE).
5. `node effects/pipeline/catalog.mjs`, then shoot it and LOOK:
   `node effects/pipeline/shoot.mjs --ids <id> --levels 1,5,10 --zoom 2`
   (and `--day` for painted effects: the night hides them). Fix, shoot again.
6. `phaser-check --ids <id>`: 0 GL errors, 0 shader errors.

## Traps already paid for

- `exp()` halos: an endless tail, dithered into a visible box of dust at the
  layer edge. Use `fall()`.
- A flame field above its top: `(1 - y)` turns negative and flips a very
  negative `(1 - x*x)` into a full-width bar (fixed in `FLAME` with `max`).
- A direction from the attacker's FEET to the victim's CHEST tilts every
  melee effect upward; ground kinds take ground directions (the runtime does).
- Smoke drawn after the blast it belongs to covers it with a black blob:
  order layers back to front (smoke before blast).
- A ring width in cells is 2.3x thinner at the ellipse's top and bottom than
  at its sides: use `ringPx` for lines.
- Anything positioned above a tall body can leave the stage: the viewer gives
  the werewolf ~0.25 of the stage's height as headroom; check the sheet.
- GLSL ES 1.00: every float literal needs its point (`2.0`), no implicit int to
  float, `pow` of a negative base is undefined, loops need constant bounds
  (`for (int i = 0; i < 24; i++) { if (float(i) >= uN) break; }`).
