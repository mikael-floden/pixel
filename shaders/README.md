# shaders/ — every spell, attack, item and monster effect

The **shader agent**'s domain (Shader-agent on his phone; board
`coordination/shaders.json`; a `shaders-assistant` works the same folder under
PROTOCOL's two-writer rules). Named `effects/` until 2026-09-26 (maintainer:
"I want to call you the shader-agent instead"); history in git.
It makes the visual effects the game plays when something HAPPENS: spells,
healing, buffs and debuffs, channels, summons, projectiles and arrows, weapon
swings, monster attacks, potions. They are **GLSL shaders, not sprite
sheets** — procedural, resolution-free, and driven by a level 1-10 that the
effect itself turns into size, heat, debris and extra layers.

The maintainer browses the library, tunes it and binds effects to skills
later ("the more effects I have in the library the more likely it is I can
find something that looks really good"): the goal is 500+ effects, grown in
batches so each batch learns from his verdicts on the last.

## The laws

- **The effect owns its look.** The game passes WHAT happens (level, where,
  to whom, how long); it never passes colours, sizes or brightness. Levels 1-10
  are drawn by the effect (`levels` text on every effect says what changes).
  The maintainer's own knobs are TUNABLES (colour pickers, sliders, switches
  declared per effect), saved to `live/tuning/shaders.json`, never a game
  parameter (maintainer 2026-09-26: "don't expose a do-anything effect").
- **World space, the game's projection.** Every position is the game's world
  units + a height in px; the game hands the runtime its own `project(x, y)`.
  The runtime does no iso math of its own, so terrain height and view rotation
  are the game's. Ground shapes are drawn in the game's iso ellipse (32/14).
- **Pixel-true by default.** A layer renders at WORLD resolution (one texel per
  art pixel) and is scaled nearest-neighbour like every sprite: effect pixels
  ARE the art's pixels. Palettes are a few hard bands with ordered dither
  (house style, `DEFAULT_STYLE`; the viewer's "House style" panel tunes it).
- **One shader contract.** A layer is `vec4 effect(vec2 p)`: p in world px
  from the layer's anchor, y UP; it returns PREMULTIPLIED colour (rgb > a is
  added light, a is coverage), so one blend (ONE, ONE_MINUS_SRC_ALPHA) draws
  glow, fire and smoke alike. GLSL ES 1.00 (his phone runs WebGL1), highp
  (games2 `highp.ts`), sin-free hashes, loops of constant bound.
- **Emissive or painted, decided per layer.** A light source (fire, magic,
  lightning) is `emissive` and the night never dims it; matter (smoke, dust,
  rock, vines) is painted and the night darkens it like the world.
- **Every effect is staged as it is meant to be seen.** Its `stage` recipe
  says who casts it (hero or monster), who it lands on, and the caster's clip
  (`characters2/animation_map.json` state); the spell leaves on that clip's
  key frame from the wand tip measured on the art (`castpoints.py`). The
  viewer, the wiki and the game read the same recipe — a preview is never a
  guess (maintainer 2026-09-26: "the spell should be emitted in sync with
  the animation").
- **Every effect explains itself.** `thinking` (why it looks like this) and
  `levels` (what 1 to 10 changes) are required and gated
  (`catalog.mjs`, >= 120 chars of thinking). They are what the wiki shows him.
- **Glow is compact.** `fall(d, r)` ends at r; never `exp()` for a halo (its
  tail becomes a box of dithered dust at the layer's edge — measured on the
  first fireball). `dglow` drops values under 0.06.
- **Fill rate is his phone's budget.** Tight boxes; <= 4 noise octaves; loops
  <= 30; a layer is `when`-gated off below the level that needs it.
  `phaser-check` prints texels per frame (all 31 effects at once: 82 layers,
  ~0.5 M texels at world resolution — 1/9 of drawing them at his zoom 3).
- **Cache safety (root law).** Hand-written source ships under stable names
  and is served `no-cache`; anything a pipeline regenerates (catalog, future
  sprite sheets) follows the root rule — a regenerated ASSET gets a hashed
  name. `shaders.json` and `library/index.js` are indexes, rebuilt, never
  hand-merged.

## Layout

```
shaders/
  runtime/          the engine (plain ES modules, zero deps; .d.ts for TS)
    fx.js           FxWorld: kinds, timelines, events, anchors, lights, draw list, volleys
    volley.js       the formations (fan, barrage, spread, rain, ring, line)
    showcase.js     the staging recipe: layout(), showcase(), castFrom(), facingOf()
    gl.js           FxGL: compiles a layer, draws one box (framework-free)
    glsl.js         the shader prelude: hashes, noise, SDFs, ring/iso helpers, bands, dither
    define.js       defineEffect, level curves, layer boxes, CAST_ANIMS, stage + sound slots
    phaser.js       THE GAME ADAPTER (Phaser 3.90): pre-pass textures + Images
    index.js        the public entry
  library/          THE EFFECTS: <family>/<name>.js, one effect per file
    _shared/        GLSL snippets (sparks, smoke, flame, bolt, comet, flow ...)
    families.js     the families (element/school) and their colours
    index.js        GENERATED: imports every effect
    cast_points.js  GENERATED (castpoints.py): wand tips / orbs / arrows per hero, clip, facing
  shaders.json      GENERATED: the catalog (metadata, stage, sounds, tunables, thinking; no code)
  viewer/           THE STAGE the wiki embeds: index.html, viewer.js, stage.js (the game's
                    light), bodies.js (the heroes and shipped monsters it casts with)
  pipeline/         catalog.mjs, castpoints.py, shoot.mjs, phaser-check.mjs (+ .html)
  docs/             integration.md (the game) · wiki.md (the wiki) · authoring.md (writing one)
```

An effect's **id** is its file path in the library (`fire/fireball` =
`library/fire/fireball.js`); its **key** for feedback and tuning is the repo
path without extension, `shaders/library/fire/fireball`, like every domain's.

## The kinds (the game's API is per kind)

| kind | the game passes | its own events | ends |
|---|---|---|---|
| `projectile` | from, to (fn = homing), height, targetHeight | impact | itself (`h.flightTime` known at once) |
| `burst` | at, from (direction), height | peak | itself |
| `melee` | at (attacker), to (victim), height | hit | itself |
| `chain` | from, targets[] | hop(i) | itself |
| `beam` | from, to (fns), duration | start, stop | `stop()` / duration |
| `aura` | at (fn: the body), height, duration | start, stop | `stop()` / duration |
| `zone` | at, radius (cells), duration | start, stop | `stop()` / duration |
| `screen` | duration | start, stop | `stop()` / duration |

Every kind also takes `release` (s to the clip's key frame), and
projectiles and opted-in bursts `count` + `formation` (a volley); every kind
fires `cast`, `release`, its own events and `end`, each with an index (which
copy, which hop).

Coordinates, depth, speeds, lights, tuning and the wiring checklist:
**`docs/integration.md`**. Embedding, verdicts and the tuning file:
**`docs/wiki.md`**. How to write an effect and the visual language:
**`docs/authoring.md`**.

## Run it

```bash
node shaders/pipeline/catalog.mjs            # rebuild library/index.js + shaders.json (--check in a gate)
python3 shaders/pipeline/castpoints.py       # re-measure the wand tips when a hero changes (the catalog gate says when)
python3 -m http.server -d . 8000             # repo root; open /shaders/viewer/
node shaders/pipeline/shoot.mjs --ids fire/fireball --levels 1,5,10 --zoom 2   # contact sheets -> $TMPDIR/shaders-shots
PHASER=<node_modules> node shaders/pipeline/phaser-check.mjs --ids ...        # the real-Phaser gate
```

`shoot` and `phaser-check` need playwright-core and a Chromium
(`/opt/pw-browsers` in the agent image), `phaser-check` needs phaser 3.90 —
both are games2 devDependencies. **Before every push**: `catalog.mjs --check`,
`shoot --all` (a shader that fails to compile fails it) and `phaser-check`
with the ids you touched (0 GL errors). Look at the sheets — a gate cannot
tell a beautiful effect from an ugly one.

## The review loop

- He reviews in the WIKI (Items > Shaders, the stage embedded) and nowhere
  else: pushing to `main` is how he sees the work (maintainer 2026-09-26:
  "why you use artifacts when we have our own wiki. Just push to main so I
  can see your work!"). When the page cannot show something yet, say so on
  the board and in the run's answer — never route around it with a side link.
- Verdicts: `live/feedback/shaders.json` (keyed `shaders/library/<id>`),
  read at the start of every run and acted on per `live/docs/review-contract.md`
  (a redo replaces the art and clears the entry in the same unit; an approval
  is never cleared; a rejection removes the effect file, its catalog entry and
  every verdict and tuning entry keyed on it).
- Tuning: `live/tuning/shaders.json` — his slider values; they are the
  effect's look now. When he tunes an effect, bake the values into the
  effect's `def`s only when he asks; the live override already ships them.
- The wiki section and the file plumbing are asked of the wiki and games
  agents on this board (see `coordination/shaders.json` requests).

## Rejected (do not retry)

- A side review link (a one-file bundle of the viewer published as an
  artifact): he reviews in the wiki (maintainer 2026-09-26, above).
- Sprite-sheet VFX as the base: fixed resolution, no level scaling, a
  generation per variant. PixelLab art may still be ADDED as a texture a
  shader samples (particles, runes) — never as the effect itself.
- Rendering effects at device resolution: 9x the fragments at his zoom and
  "mixels" next to the art.
- A layer framebuffer bound mid-frame: on his tile-based GPU each switch
  stores and reloads the whole frame. The pre-pass renders before the frame.
- Phaser `Shader` game objects: a pipeline flush per object and smooth
  device-resolution output; `Extern`: same flush and a mid-frame target.
- Phaser's `WebGLFramebufferWrapper` for the layer targets: its destroy()
  raises INVALID_ENUM on WebGL1 (a raw framebuffer around a Phaser texture).
- `fract(sin(x))` hashes: band on a 16-bit mobile `sin` (games2 lighting law).
