# Shaders in the game — the contract

For the games agents (and anyone binding an effect to a skill, an item or a
monster attack). The shaders domain owns how every effect LOOKS; the game
owns WHEN it plays, WHERE, on WHOM, and how strong (the level). This file is
the whole interface.

## In one minute

```ts
import { createPhaserFx, nangijalaDepth, toShaderLight } from "../../../shaders/runtime/phaser.js";
import LIBRARY from "../../../shaders/library/index.js";

// WorldScene.create()
this.fx = createPhaserFx(this, {
  project: (x, y) => this.project(x, y),   // server-space world units -> the LIFTED ground point
  library: LIBRARY,
  depth: (d) => nangijalaDepth(d),         // replace with the game's own rule (below)
});
this.fx.warm(["weapon/arrow", "fire/fireball"]); // compile what is bound, at load

// a skill fires: start the hero's clip and the effect in the SAME frame
const def = this.fx.defs.get("fire/fireball");
playClip(me, def.stage.anim, CAST_ANIMS[def.stage.anim].fps);   // spell_wand at 10 fps, once
const h = this.fx.play("fire/fireball", {
  level: skill.level,                                  // 1..10
  from: castFrom({ x: me.x, y: me.y }, me.heroId, def.stage.anim, me.facing), // the wand tip
  to: () => ({ x: mob.x, y: mob.y }),                  // functions are re-read every frame
  height: 88, targetHeight: mob.drawnHeight,           // drawn heights, px
  owner: "self",
  release: castRelease(def, skill.level),              // it leaves on the clip's key frame
  count: skill.missiles, formation: "fan",             // a volley (optional)
});
h.on("impact", (i) => showHit(mob));                  // i = which copy; or schedule at h.impacts[i]
```

The adapter hooks the scene's `postupdate` itself (after the game has moved
its bodies, before the camera renders). `autoUpdate: false` + `fx.tick(dt)`
if the game wants to call it at a precise point.

## Coordinates — world space, the game's projection

- **Every position is the game's world space**: `{ x, y }` in world units on
  the ground (the numbers the server moves bodies with; 32 wu per cell) plus
  an optional `z`, a height in world px above the ground at that point.
- **The runtime never does iso math of its own.** It calls the `project(x, y)`
  it was given for every anchor, every frame. WorldScene's `project()` already
  includes the terrain lift and the view rotation, so a spell cast from a
  plateau at a monster below, or in a turned view, is right with no extra code.
- **Heights have defaults that match bodies**: `from.z` = 0.55 x `height` (the
  hand), `to.z` = 0.5 x `targetHeight` (the chest), `at.z` = 0 (the feet).
  Pass the body's DRAWN height in px (`height` for the caster / the body at
  `at`, `targetHeight` for the victim) and the effect sizes itself to it: a
  burning troll burns bigger than a burning rat. An explicit `z` wins.
- **Ground sizes are in CELLS** (`radius`) because they are gameplay: a nova's
  ring, a zone's rim, a slam's reach are drawn on the ground in the game's iso
  ellipse at exactly the radius the server hits. Omit `radius` and the effect
  uses its own by level.
- **A cast point is a SCREEN offset**: `from: { x, y, sx, z }` draws `sx` px
  right of and `z` px above the feet — the wand tip of a clip's key frame is
  where the ART draws it, whatever the world direction (`castFrom`, below).
- **Screen space** is only the `screen` plane (camera-fixed overlays; none in
  the library yet). Everything else is world space.
- A position may be a **function**: it is read every frame (a homing bolt, an
  aura riding a walking body, a beam between two moving bodies).

## Kinds — what to pass, what comes back

| kind | play() takes | its own events | lifetime |
|---|---|---|---|
| `projectile` | `from`, `to`, `height`, `targetHeight` [+ `speed` or `flightTime`] | `impact` | ends itself; `h.flightTime` is known on play |
| `burst` | `at`, [`from` = its direction], `height` | `peak` (the moment to apply it) | ends itself |
| `melee` | `at` (attacker), `to` (victim) or `dir`, `height`, `targetHeight` | `hit` (the contact frame) | ends itself |
| `chain` | `from`, `targets: [...]` | `hop` (i = index into targets) | ends itself |
| `beam` | `from`, `to`, [`duration`] | `start`, `stop` | `h.stop()` or duration, then its outro |
| `aura` | `at` (the body, a function), `height`, [`duration`] | `start`, `stop` | `h.stop()` or duration |
| `zone` | `at`, `radius`, [`duration`] | `start`, `stop` | `h.stop()` or duration |
| `screen` | [`duration`] | `start`, `stop` | `h.stop()` or duration |

Every kind also fires, in order: `cast` (play() — the clip starts), `release`
(the spell leaves the caster), its own events, and `end`. A listener gets
`(i, handle, event)`: `i` = which copy of a volley, which hop of a chain,
else 0. `h.timeline()` (or `fx.timeline(id, params)` without playing) lists
every scheduled event in seconds from play(). Every handle: `on(event, fn)`,
`set({ at, from, to, level, radius, ... })` (retarget, re-level a running
effect), `stop()` (outro; before the release it never appears), `kill()`
(gone now), `done`, `duration`, `releaseAt`, `impactAt`, `releases[]`,
`impacts[]`. An unknown id returns a dead handle and logs once; it never
throws in a frame.

## Cast sync — the clip and the spell

- **Each effect names its clip** (`def.stage.anim`, catalog `stage.anim`):
  the `characters2/animation_map.json` state the hero plays — `spell_wand`,
  `spell_channel`, `bow`, `sword`, `punch`, `kick` — or a monster's
  `attack`. Every hero clip is 4 frames; on frame 2 (the KEY frame) the wand
  thrusts and sparks, the bow looses, the blade and fist land.
- **The rates** (`CAST_ANIMS`): the spell and bow clips at 10 fps (the
  game's registered rate for them today — nothing triggers them yet), sword,
  punch and kick at 12 (the game's punch rate). A monster's attack lasts
  0.7 s whatever its frame count (the game's rule); its key is mid-clip.
- **Start both in the same frame and pass `release`**: `castRelease(def,
  level)` = seconds from the clip's start to the key frame (a melee's blow
  LANDS on it: its swing starts earlier by its `hitAt`). A projectile's
  gather fills that time at the hand; every other kind waits unseen and
  starts on it. Omit `release` and an effect starts at once (its own windup).
- **Cast from the art**: `castFrom(body, hero, anim, facing)` returns the
  `from` for the wand tip / orb between the hands / arrow in flight, measured
  on each hero's key frame per facing against the game's foot anchor
  (`shaders/library/cast_points.js`, `python3 shaders/pipeline/castpoints.py`
  — the catalog gate fails if the hero frames change under it). PixelLab's
  south-facing wand points screen-right, the north one up: a fixed
  "0.55 of the height" misses the wand by up to 50 px.
- A channel clip (`spell_channel`) on a sustained effect holds its last frame
  until the effect's `stop`; a one-shot clip returns to idle.

## Volleys — several copies in a formation

`count` (2-12) plays that many copies as ONE handle; `formation` picks how
they fly — the skill decides how many, the effect owns the shape:

| formation | kinds | what it does |
|---|---|---|
| `fan` | projectile | leave a beat apart, bow out to both sides, converge on the target |
| `barrage` | projectile | one after another down the same line |
| `spread` | projectile | a cone: straight lines landing side by side across the target |
| `rain` | projectile, burst | lobbed high / dropped, scattered over the target area |
| `ring` | projectile, burst | outward in every direction / a circle around the spot |
| `line` | burst | a row marching from the caster to the target |

Every projectile supports every projectile formation; a burst only the ones
it lists (catalog `volley.formations`: meteor and lightning strike rain, line
and ring; smite rain and ring). Every copy fires its own `release`,
`impact` / `peak` with its index; `h.impacts[i]` / `h.releases[i]` give the
times up front. Only the first copy gathers at the hand, and the copies share
ONE light (their centre, reach and summed colour, capped), so a volley still
fits one reserved slot.

## Sounds

Each effect lists its sound slots (`def.sounds`, catalog `sounds`) with the
game's audio event for each: `soundEvent(id, slot)` =
`shaders.<family>-<name>.<slot>` (`shaders.fire-fireball.impact`). Emit it
with `gameAudio.event(...)` on the runtime event the slot names (`slot.event`;
per copy when `slot.each`); a `loop` slot (a sustained effect's `channel`)
runs from its `release` to its `stop`. The wiki binds the sounds
(`live/tuning/sfx_requests.json` -> the composer).

## Timing and speed

- **Flight time** = max(minFlight, ground distance in cells / speed), plus the
  effect's windup (a few frames of gathering at the hand — or the `release`
  passed, so the flight starts on the clip's key frame). It is fixed at
  `play()` and returned as `h.flightTime`, so the game can schedule damage
  without waiting for an event. **If the server decides the arrival, pass it**
  (`flightTime: seconds`) and the visual lands exactly then. With `to` as a
  function the path bends toward a moving target and still arrives on time.
- **Speeds are cells per second on the ground** (the runtime converts the
  distance from world units). Recommended, and the defaults:

  | effect | cells/s (L1 -> L10) | feel |
  |---|---|---|
  | Arrow | 15 -> 20 | too fast to lose, too slow to miss |
  | Frost Bolt | 9 -> 12 | quick and precise |
  | Fireball | 8 -> 10 | readable, weighty |
  | Shadow Bolt | 7.5 -> 9.5 | heavier, ominous |
  | Acid Spit | 7 -> 8.5 on a 30-42 px lob | a visible arc you can dodge |

  For reference: a full run is 175 wu/s = 5.5 cells/s, so every projectile
  outruns a fleeing target; a phone in portrait shows ~8 cells across, which a
  fireball crosses in about 0.9 s. Keep new projectiles in 7-20 cells/s:
  slower reads as a floating orb, faster as a hitscan with a trail.
- **Bursts, melee and chains** have their own durations (the catalog lists
  them) and fire `peak` / `hit` / `hop` at the frame the thing HAPPENS
  (a meteor's `peak` is its impact at 0.95 s, after the warning circle).

## Draw order

Every layer an effect draws declares a **plane** and whether it is
**emissive**, and the adapter hands the game's `depth(d)` a `LayerDraw`
carrying both plus the ground point it sorts at:

- `ground` — flat on the ground (rings, circles, scorch, pools, cracks):
  under anything standing on it, over the terrain it lies on.
- `body` — stands at a ground point (a projectile, a pillar, flames on a
  body): sorts exactly like a body standing at `d.gx, d.gy`.
- `air` — above all world content (a falling meteor, a flash): over bodies.
- `screen` — camera-fixed, over everything but the HUD.
- `emissive: true` — a light source (fire, magic, lightning, holy light): the
  night must NOT dim it. `false` — matter (smoke, dust, rock, vines): the
  night dims it like the world around it.

Effects that wrap a body (a ring of spikes, an aura, a shield, flames) are
drawn as TWO layers, a back half and a front half; their ground points are
already moved half a body behind and in front of the anchor (`d.gx/gy`), so
a plain feet-y rule puts the back half behind the body and the front half
over it.

`nangijalaDepth(d)` (the default) encodes today's bands: painted layers at
the body band (`sortY`, the screen y a body standing at `gx,gy` sorts by),
emissive ones in the lit band `900_001 + base * 1e-5` (above the darkness
overlay at 900_000, keeping their order against lit copies), `air` at
900_003, `screen` at 900_004. The games agent should replace it with the real
rule — `resolveDrawDepth` at `(d.gx, d.gy)` for body layers, the flat-piece
rule for ground layers — because that is the ONE depth pipeline
(games2/CLAUDE.md: "never hand-roll a second depth path"). An emissive layer
behind an unlit body is the one case the lit band gets wrong (the effect
draws over the body at night); the lit-copy system already solves exactly
that for fire scenery.

## Lights

Every effect that should light the world has a light: `fx.lights(filter)`
returns this frame's, strongest first, as world units + height + radius in
cells + an overbright-capable colour + flicker. The reserved slots
(`games2/client/src/lightslots.ts`) are the binding:

```ts
const mine = this.fx.lights((l) => l.owner === "self")[0];
setSelfFxLight(mine ? toShaderLight(mine, { levelAt: (x, y) => this.levelAt(x, y) }) : null);
const atMe = this.fx.lights((l) => l.owner === "monster")[0]; // effects aimed at the local player
setMonsterFxLight(atMe ? toShaderLight(atMe, { levelAt: ... }) : null);
```

Remote players' effects are never lights (the torch rule: "a player can only
ever see its own torch"); they still glow, because their layers are emissive.

## Performance (his phone: WebGL1, fill-rate bound)

- Each live layer renders into a small texture at WORLD resolution on
  postupdate — before the frame's framebuffer is touched, so no mid-frame
  switch on a tile-based GPU — and is shown as an ordinary Image in the
  sprite batch. `fx.stats` = `{ layers, texels, reallocs }` per frame for the
  beacon. Measured (phaser-check, SwiftShader): all 31 effects at once = 82
  layers, 0.5 M texels; a fireball is 3-4 layers, a few thousand texels.
- Shaders compile on first use: `fx.warm(ids)` at load for the bound ones.
  A shader that fails to compile is skipped and logged, never thrown.
- The adapter restores the scissor state, rebinds Phaser's pipelines and
  handles a WebGL context restore (programs rebuilt, textures re-made).
- All shaders are highp; `highpInstall` would rewrite them anyway.

## Tuning, live

The maintainer's tuned values arrive in `live/tuning/shaders.json`
(`overrides["shaders/library/<id>"] = { <tunable>: value, ... }`). Apply the
table on boot and on every `live:update`:

```ts
this.fx.setTuning(liveState["tuning/shaders"]?.overrides ?? {});
```

It changes how new casts look (colours, size, brightness, per-effect
switches); it never changes gameplay.

## The one-time wiring (games agent) — also on the shaders board as a request

1. **Bundle**: the client imports `shaders/runtime/phaser.js` and
   `shaders/library/index.js` at build time (Vite: allow the repo root in
   `server.fs.allow`; the TS types are `.d.ts` beside the files, no allowJs).
   Add `shaders/runtime/**` and `shaders/library/**` to `fast-publish.yml`'s
   paths: a new effect is browser code and ships in the 33 s lane.
2. **Serve** (for the wiki's viewer): ship `shaders/` like an art domain —
   `.dockerignore` `!shaders`, the Dockerfile `COPY shaders/ shaders/`,
   `publish.json`, the deploy workflow's trigger paths, vite's
   `ASSET_DOMAINS`, the server's `/assets/<domain>` mounts.
3. **Live**: `"tuning/shaders.json"` in `LIVE_FILES`, `"shaders"` in
   `FEEDBACK_DOMAINS` (server/src/live.ts), so the wiki can save his verdicts
   and slider values and the game receives them.
4. **Bind** an effect to a skill / an attack only when the maintainer asks
   ("I will later bind them to something"): the binding is his.
