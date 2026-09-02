# Indoor mode (the cut-away)

The complete spec for walking inside a building: the truncation, the
transition crossfade, the interior lighting, the tap/occlusion rules, and
every prohibition that was paid for with a shipped rendering bug. It lives
outside `games2/CLAUDE.md` so both games2 agents don't carry 20 KB of it on
every run — the stub there is the pointer, THIS file is the law.

**Read this file before changing anything that draws, lights, picks or hides
a cell indoors.** Source: `client/src/indoorwall.ts` (the wall dial),
`client/src/indoorlight.ts` (the brightness dial), `shared/src/indoor.ts`
(`shell`), the indoor halves of `client/src/scenes/WorldScene.ts` and
`client/src/nightlight.ts`. Gates: `scripts/verify-indoor.mjs` and
`scripts/verify-indoorscope.mjs`.

**A CUT-AWAY, NOT AN X-RAY** (maintainer). Walk under a roof and the building
is drawn WHOLE but TRUNCATED: every column stops at `indoorTop =
min(roomFloor + dial, ceiling)`. Nothing hidden, nothing transparent, nothing
half a tile. The dial is `client/src/indoorwall.ts` ("Indoor wall height",
1…6 levels, default **1**); brightness is `indoorlight.ts`, default **40%**.
Both defaults are the maintainer's own picks — do not "restore" either.
Probes: `__ml.indoorWall(v?)` / `__ml.indoor()`.

- **Measured UP FROM THE FLOOR, not down from the roof.** `ceiling − N` is a
  wall height only when every room has the same ceiling — the house's
  ceiling is 6 and the caves' 8 over the same floor, so roof−4 left walls
  twice as tall in the caves. From the floor, 2 is 2 in a cottage and a
  cathedral. The ceiling survives as a CLAMP and as the "am I above the
  room?" line (`indoorCeil`, still `deckBot`, never `roofLevel`).
- **The floor is the ROOM'S MINIMUM**, not the cell underfoot (anchoring to
  the feet made every wall jump 16px per ledge step; the minimum keeps a
  raised shelf below the cut). The MAX is 6 = the tallest shipped room
  (measure from the floor and the DEEPEST room bounds you — opposite of the
  old roof−N dial). The storage key changed with the meaning
  (`ml-indoor-cut` → `ml-indoor-wall`) so old tuned values are not misread.
- **The cut is SCOPED TO THE COVERING CONE — the neighbour's house keeps its
  roof** (maintainer: entering house_a must not show into house_b).
  `indoorCut` is the complete CONSTRAINED SET: my building (per-wall raise)
  plus every other column whose full-height art would bury one of MY
  floors/entrances (the down-screen cone, capped per cell by the 0.9375·k
  burial slope, never below the dial). Everything else draws WHOLE, deck
  included — house_b renders closed and goes black under zero ambient,
  torch-findable. Threaded consequences: absent-from-the-map = full height
  (redrawGround falls through to the outdoor draw; occluders rebuild the
  neighbour's deck; aboveCut's per-cell answer is `entry ?? Infinity`); the
  shader's R channel gained the **127 "unconstrained" sentinel** (127 =
  resolve full; 0-126 = constrained cut; 128+cut = my room; setRoom writes
  the full grid and takes `top`). The kill switch (`__ml.indoorRaise(false)`)
  means the LEGACY world-wide scalar cut — the gates' flat frames depend on
  it. My space's connected chambers are ONE space, so their floors are all
  mine (the old world-wide protectedFloor pass is gone).
  - THE DEPTH FOG IS ROOM-GATED WITH IT (DEPTHFOG_FRAG uRoom/uRoomOn/
    uIndoorMix): its pale far bands painted a glowing ring over the
    zero-ambient blackness; fog outside my room fades on the same mix.
    Outdoors byte-identical. The MIST pass still paints indoors-outside —
    pre-existing, rare, noted.
  - Gate: `scripts/verify-indoorscope.mjs` (house_demo, six roofed houses):
    no constrained cell inside house_b, sentinels published, probe-light on
    the neighbour's roof, kill-switch flat world, the transition fade.
- **SCENERY UNDER THE ROOF FOLLOWS THE CUT** (maps3): a placement under a
  roof/cave deck is kept in the index and flagged (`SceneryPlacement.roofed`);
  `WorldScene.roofCutAwayAt` draws it only while `indoorMask` is up and that
  column's `cutAt` is finite and at/above the piece — i.e. exactly while the
  roof over it is not drawn. Gated on the DRAWN state like `aboveCut`, so the
  furniture stays through the exit fade and goes when the slab returns; keyed
  on the CUT, never on a room test, so the neighbour's house keeps both its
  roof and its furniture. Gate: `scripts/verify-indoorscenery.mjs`.
- **The transition is a DEBRIS CROSSFADE, not a pop**: on the indoor flip the
  REMOVED art (roof slab, wall bands above each cut, the cone's tops) is
  rebuilt as ordinary world-anchored images at occluder depths
  (`buildIndoorDebris`) wearing `alpha = 1 − indoorGrade()`. ENTRY: the
  world repaints to the cut state on the flip frame under OPAQUE debris
  (picture unchanged), which then dissolves. EXIT: commitIndoor(false) does
  NOT repaint; the cut world stays drawn (mask, cuts, `night.indoor`,
  aboveCut, pickGround follow the DRAWN state) while the debris fades back
  in; the real repaint happens when the GRADE lands — opaque debris equals
  the real geometry, so the swap is invisible. Mid-doorway turns just
  reverse the fade (the mix IS the state). Instant paths stay instant (kill
  switch, world unload, QA toggle). A direct room-A→B crossing mid-fade
  keeps ≤1s of stale fade art — accepted. Probe: `__ml.indoorFade()`.
  - **The debris obeys the LAP RULE**: where a deck coincides with its own
    equal-height column (`deck.level == cell.l` — a roof lapping its walls,
    hall pillars), the real renderers draw the COLUMN's baked top and skip
    the deck; buildIndoorDebris must too (same `dk.deck.level > cell.l`
    guard as rebuildOccluders/redrawGround) — else the fade shows a dark
    slab popping to the real mixed-tile roof. `__ml.debrisAt(c,r)` lists a
    cell's pieces (lvl, key); the gate holds a lap cell to ONE piece per
    level with the wall's own top (tone-independent — a pixel bar can't see
    this).
  - **TWO SPEEDS: debris at 3×, light grade at 1.5×** (`INDOOR_DEBRIS_RATE`
    / `INDOOR_GRADE_RATE`, both maintainer-tuned separately — running
    everything at 3× was sent back). `debrisAlpha()` keeps its 3× curves
    (entry done by mix ⅓; exit by ⅔); `indoorGrade()` — the eased mix at
    1.5×, clamped — is what every LIGHT half rides (`night.indoorMix`, every
    CPU light gain: fireRoomK, torch enable, outside fade, sealed fires,
    ambEff/sunIn/fogScale). The raw `indoorMix` stays the 0.35s easing
    substrate (what `indoor().mix` reports and the pin targets); consumers
    take the grade or the alpha, never the raw mix.
  - **The exit swap lands WITH the light grade (mix ⅓), not at mix 0**: the
    debris is view-culled to the FLIP frame's camera, so the old mix-0
    landing ~1.9s later exposed cut-state cells the walking player had
    dragged the camera onto. The grade lands ~0.39s in (≤~60px drift vs
    OCC_CULL_PAD ~360) and the swap frame is pixel-identical — LOCK THE
    CAMERA before trusting any screenshot diff (an unlocked run's
    "differences" were camera glide).
  - **The exit unclamps the RESOLVE at the flip, not at the end**
    (`night.indoor = indoorInside && mask`): a still-clamped resolve lit the
    returning roof debris as the shadowed interior, and the mix-0 repaint
    traded a dark slab for a sunlit one. The whole exit fade is lit as the
    outdoor world; the accepted cost is the mirror image, hidden under
    debris already covering it. Entry keeps the clamp from its own flip.
  - `__ml.indoorMixPin(v?)` parks the blend anywhere in (0,1) — how the
    starved harness photographs the crossfade deterministically (pin BEFORE
    the teleport). An exit pin ≤ ⅓ IS the landed grade — the swap fires
    under it; pin above ⅓ to hold the pre-swap frame.
  - Gate: verify-indoorscope sections 4-5 (pinned mid frame distinct from
    both endpoints >8 luma; debris gone at settle; the TWO SPEEDS are real;
    the late-exit frame matches the settled outdoor roof within a tight
    drift bar — the colour-snap regression).
- **The dial is a MINIMUM — walls rise per cell until they'd cover a floor**
  (maintainer: "as tall as they can be before they intersect with another
  floor"). `computeIndoorCuts` gives each cell of MY building its own cut
  (`indoorCut`: cell → drawn level): from min(realHeight, ceiling), walk the
  cell's up-screen cone and cap at `floor(0.9375·k + floorLevel − 1)` per
  protected floor k steps up (odd k overlaps u±1, even k the same iso
  column; 0.9375 = dy/lh, the burial slope; the −1 margin covers ZERO pixels
  of the floor diamond). Protected floors = roof + entrance cells of MY
  space (built in buildCaveDepth's space pass; a bridge protects nothing).
  What falls out free: a NEAR wall has its own room's floor 1-2 steps
  up-screen, capping it below the dial, so `cut = max(dial, cap)` keeps near
  walls at the dial with NO side classification (the culling lesson: nothing
  to classify, nothing to hole). Far/side walls rise to the ceiling;
  partitions with the next floor behind stay at the dial.
  - ALL consumers go per-cell: redrawGround + rebuildOccluders (the exposed-
    face start uses the front neighbours' DRAWN heights at the call site —
    else an occluder hole at every far-run/near-run corner), rebuildProps,
    pickGround (a raised wall drawn whole is a tappable sill; scan from the
    ceiling), aboveCut (extra fx/fy args — a body on that sill stands on
    painted ground), and the shader (per-cell cut in the room mask's R as
    128+cut; roomAt STEP-tests the top half; heightAt clamps each column).
    The cut could NOT ride the A channel: canvas uploads are premultiplied —
    A < 255 scales RGB (the pinned-alpha note in setRoom). setRoom's `cuts`
    param has its own change test (the dial moves every cut while the cell
    set is identical — set comparison alone would skip).
  - QA: `__ml.indoorRaise(on?)`, roomTex().raisedCells/maxCut; verify-indoor
    2a/2b/2c pin the FLAT frame, 2c' pins the raise, section 7's
    overhead-monster rule is per-cell.
- **DO NOT GO BACK TO CULLING.** The first cut drew no roof/near walls + a
  32px far-wall skirt and shipped HOLES — floating wall slabs, black wedges
  (maintainer: "rendering bugs I have never seen before"). Structural, not
  tuning: culling asks "whose inward face does the camera see", and a room's
  own CORNER has no inward face — no wall set can hold it; same at every
  T-junction. Truncation has nothing to classify.
- **The outside is DRAWN AT ZERO AMBIENT — never skipped** (the maintainer's
  original idea: the torch reveals the outdoors through the doorway before
  you step out; point lights from outside are off). Skipping cost three bugs
  at once (grass popping in at the door, a torch lighting nothing, missing-
  neighbour tile sides). The renderer draws every cell; the SHADER kills the
  light: a per-cell mask texture `uRoom` (`world-room-mask`, one texel per
  cell, NEAREST, unit 4, published by `setRoom()` on doorway crossings/dial
  turns — never per frame); `roomAt()` gates AMBIENT, aurora and the
  emission floor and NOTHING ELSE. Point lights stay additive — the torch
  spills through the doorway with the opening's own shadow (measured 5.2×
  brighter down the doorway than at the flanks).
  - **The cut applies to EVERY column in the world**, not just the building:
    painter order draws down-screen columns over the room (a column buries
    an interior cell once ~0.94·k levels taller at k steps). Around the
    house that never fires; in the caves the surrounding rock hid 417 of 417
    interior cells. One rule for every column; the shader's global heightAt
    clamp already assumes it. Gate: verify-indoor section 7.
  - `roomAt()` FAILS LIT (`uRoomOn`, same guard as uGlowOn): an unbound
    sampler2D reads unit 0 — the heightmap — so the failure mode is a BLACK
    ROOM on a real phone while headless SwiftShader looks fine.
  - **Nothing stands on ground the cut removed** (`aboveCut`): above the cut
    nothing is painted, so monsters/NPCs/remote players/drops whose surface
    level exceeds `indoorTop` are hidden. The threshold is the CUT, not the
    ceiling; the test is HEIGHT, not room membership (the mountain around a
    cave is outside the room AND above the cut → hidden; grass outside the
    door is outside the room at my level → drawn, torch-lightable). Gate:
    section 7 (cave only — needs a populated mountain overhead; turns
    "disable aggro" ON, else the gate gets killed mid-measurement).
  - **Anything drawn ABOVE the darkness overlay must gate itself** — zero
    ambient can't touch depth 900_001+. `indoorOutside(fx,fy,z)` is the
    predicate (NOT a visibility test; bodies are always drawn): name labels
    + chat bubbles (900_100), monster hp/Lv bars (900_001.5-1.7), the red
    ring (.45), the white outline (.43), the bonfire's blooms + full-bright
    lit copy (fireRoomK). A pitch-black villager with a crisp name tag is
    the tell.
  - **NPCs get a lit copy like every body** — without one their light came
    from the multiply overlay, which lights each pixel by the terrain cell
    resolved BEHIND it (a villager one step outside the door had black legs
    and a lit head).
  - The eased half is `uIndoorMix` (the outside FADES to black); geometry
    (`uIndoor`, `uIndoorTop`, the truncation) snaps. The CPU twin mirrors.
  - **Two ambient grades, one crossing** (`uAmbient`/`uAmbientOut`): a cell
    in my room blends outdoor→interior dial; a cell outside blends
    black→outdoor and never touches the interior grade. One shared ambient
    OVERSHOT on exit at night (interior 40% = 3.9× night's luma; the outside
    took it and eased back DOWN). Measured after: monotone rise, zero
    non-increasing steps.
  - **The light mask outlives the verdict by one roll** (`roomMask`, dropped
    in easeIndoorMix; `roomAt`/CPU twin gate on `uIndoorMix`, not
    `uIndoor`): geometry snaps back the frame you step out, the light is
    still rolling — a room that stopped existing mid-roll handed the WHOLE
    world the interior grade for a quarter second. Everything asking "is
    this outside MY room?" reads `roomMask`, never `indoorMask`.
  - The ambient agent's outdoor layer fades with it:
    `ambient/runtime/outdoor.ts` `OUTDOOR_FADE_MS` = **1050** = 3 ·
    INDOOR_TAU · 1000 (its roll is `k = 1 − exp(−(dt/fadeMs)·3)`, making it
    frame-identical to the game's). Its test asserts the relationship, so
    moving INDOOR_TAU without it fails in `npm test`.
- **THE CAVE SWALLOWS THE LIGHT** (maintainer: "a thickening shadow that gets
  very dark, very fast"). Every room dims with **depth from its nearest
  entrance** — depth, not camera distance. `buildCaveDepth` BFSes from
  `space.entrances` across each room's cells once per world, skipping
  anything the indoor verdict doesn't call a room (a bridge never darkens).
  Depth rides the room mask's free GREEN channel; the shader applies ONE
  exponential `exp(-depth * uCaveK)`. It multiplies the FINAL light, after
  point lights, ON PURPOSE (maintainer: "no light source can punch in" — a
  torch at the mouth buys the first cell). Your OWN room is exempt and
  un-dims on `uIndoorMix`. 255 = "no opening reaches this cell".
  `roomDebug()` reports `depthCells`/`depthMax` (a channel written once per
  world fails silently).
  - **The depth is read from the cell that is DRAWN, not the one the ray
    stops on** (`groundCellAt`) — why five rounds of mask surgery rendered
    nothing: the surface march stops at the first column whose top the ray
    meets and `heightAt` is max(terrain, deck), so every opening pixel
    resolved to the first interior column at BFS depth 0 (measured: 0 of
    86,640 mouth pixels darkened). The GROUND field carries no decks, so an
    identical walk over `groundAt` lands on the cell whose art is painted at
    the pixel (92% of inward-wall pixels, 70% of floor pixels, depths 1..8).
    It is a SECOND march on purpose — `cell`/`z` from the surface walk still
    drive Lambert/shadows/AO/emission — and runs only for pixels already
    under the ceiling gate.
  - The GATE stays on the surface march (`z < caveUnderAt(cell) − 0.5`): `z`
    separates the opening from the lintel. The ceiling underside comes from
    `grid.deckBot` in the mask's BLUE channel — rederiving it from the deck
    table produced 0 cells and compared against zero forever.
  - The room mask marks the INWARD-FACING walls only — `space.wallLeft`/
    `wallRight` (drawn faces are a cell's +col/+row sides; the near half of a
    ring is the mountain's outside skirt — darkening it blackened houses).
    No band, no rings (a wall face is 8 levels ≈ 128px vs a 15px cell step).
    The rock bar (two levels of headroom above the ceiling) keeps house walls
    out: the_island2's cave marks 146 cells, every house/arch 0.
  - `uCaveK` = 1.2 is the single dial (mouth untouched, then 30/9/2.7/0.8%
    over four cells; 3.6 was a cliff once the depth reached drawn cells).
- `shared/src/indoor.ts` publishes **`shell`** — the building, 8-connected,
  openings excluded; the ONLY set the renderer reads (`wallLeft`/`wallRight`
  survive as detector output). Fill and fringe stay 4-connected (a diagonal
  is not a step); `shell` is 8-connected because a point-touch is a visible
  seam.
- **The SURFACE resolve is clamped to the cut; the OCCLUSION march is not**
  (`uIndoorTop`): what the camera sees is truncated; what light travels
  through is not — the building stays solid to the sun (else the missing
  roof daylights the room), and skipping the surface clamp recreates the
  roof-in-the-heightmap bug one level up (a floor behind a level-3-drawn
  wall resolving at 6, torches attenuated across 48px of phantom gap).
- **A tap resolves against what is DRAWN, and only the floor is a target**:
  indoors `pickGround` starts its top-down scan at `indoorTop`, skips decks
  (the roof slab matched every indoor tap at level 6 — 6.40 cells
  down-screen of the finger), and skips building cells taller than the cut
  (a parapet's drawn top is not standable; the tap means the floor beyond —
  2.13 cells off). A wall SHORTER than the cut is untruncated and stays
  tappable — a real sill. Gate: the tap round-trip in verify-indoor.
- **THE WHITE OCCLUSION OUTLINE** (`syncCoverOutline`) — not indoor-only:
  any body a parapet/cliff/tower covers gets a white silhouette ring
  (HIDDEN_RING_COLOR) over the hidden part at 900_001.43, the exact
  COMPLEMENT of the lit copy (`syncLitCopy` crops [0, coverY); this draws
  [coverY, bottom)) — the two tile the figure seamlessly. The gate asserts
  the monotone CHAIN (5-level wall hides 61%, 3 levels 41%, 1 level 4%,
  open ground none) — something a stuck outline cannot fake.
  - **IT IS NOT A WALL-HACK.** It draws above the darkness overlay, so only
    refusing to draw can hide it. Two symmetric gates in `syncCoverOutline`:
    indoors, nobody OUTSIDE my room gets one (`indoorOutside`); outdoors,
    nobody sealed INSIDE a room does (`inHiddenRoom`) — else a monster deep in
    the mountain shows a crisp silhouette through rock. "Room" is the indoor
    state machine's verdict, not "has a slab overhead" — a body behind a
    cliff/tower/BRIDGE keeps its outline (that IS the feature); a body in a
    cave MOUTH is not sealed. **The gate is the CUT (`indoorInside &&
    indoorMask` — the same pair pickGround and aboveCut use), never the fade
    mask** — `roomMask` outlives the verdict for the ambient ease, and reading
    it kept cave monsters outlined through rock for a second after exit. One
    flood fill per space (`roomCellMemo`, filled from `space.roof`, cleared on
    world change); fails OPEN (a spare outline is cosmetic; a missing one is
    the feature broken). Gate: section 8 of verify-indoor — samples the first
    frame that is already outdoors with the fade still running (settle would
    wait it out), kept non-vacuous by `coverFrac` (≥2 sealed >50%-buried
    monsters required; the mid-fade check requires ≥1 — it once passed on
    "none of the 0 sealed monsters is outlined") and by requiring
    open-air-covered bodies still outline.
  - **Coverage is RASTERISED, not modelled** (maintainer: "pixel perfect …
    now the effect is just a line"). `coverY` is ONE scalar (top of the
    highest covering column's 64px image box) — but an iso wall top is a
    diagonal, an arch is a hole, a prop billboard is arbitrary alpha.
    Measured: 79.8-93.7% of outlined pixels sat over ground nothing covered
    (a complete 268-texel outline around a 0%-covered body at a tree); tile
    art starts ≥6px below its box top, so `min(o.y0)` over-claims by
    construction (missed 0.0% everywhere — one-sided error). **No analytic
    field can fix this** (billboards). The covering images RASTERISE it per
    body into three DynamicTextures in a shared atlas: E (body minus
    occluders in front), C (body minus E), O (dilate(C) minus body = the
    ring). "Covered" is Phaser's own painter rule (`depth > sprite.depth`),
    executed by the renderer. Verified GPU-vs-CPU: 0 differing texels;
    E∪C == silhouette, E∩C == 0. Gated on WEBGL; the flat-crop path stays
    verbatim as fallback (`coverExact`). THREE TRAPS paid for:
    * The atlas must RECYCLE: holding slots until body-destroy froze
      allocation at 13-25 slots and every covered body after reverted to the
      flat line mid-session. Any big-enough free slot serves (smallest
      first); a body uncovered for COVER_SLOT_GRACE ticks hands its back.
    * Ask about the ART BOX, not the frame box (mirrored when `flipX`):
      a 112×112 frame around a 29×86 figure admitted ~80 occluder candidates
      vs a median ~6. Safe: C ⊆ silhouette ⊆ artBounds.
    * The flat line may not VETO the exact path: `coverY` below the art does
      NOT mean nothing is covered (a low occluder at the feet — 95 covered
      texels with no outline because the early-out fired before the slot was
      consulted). With a slot, O answers for itself.
  - **Swimming: wear the body's OWN mask** — the same GeometryMask object
    `updateWaterClip` puts on the sprite (never a second copy of BOW_FRAC,
    never `swimming`/`swimT`): structurally unable to disagree with the
    body's cut/bow/bob/exit-jump and all three bail-outs. Measured fully
    submerged: 712 ring pixels above the crest, 0 below.
- **INDOOR MODE → `scripts/verify-indoor.mjs`** (dev stack, ~3 min): one
  pinned camera frames the_island2's house from outside and from within and
  the two shots are compared on REAL pixels. The script carries its own
  numbered sections and their reasoning in its header — read it there, and
  keep these four laws when you change it: sample points are DERIVED from
  maps2's `world.json` (deck footprint + terrain levels), so a re-authored
  house moves the samples instead of silently passing; every frame is shot
  with the TORCH OFF (a lit torch legitimately lifts outside ground); the
  light sections pin the DERIVATION, never the maintainer's 40% (taste); and
  every "is it black?" test is a MEDIAN over a wide patch (scattered decor
  — fireflies, footstep marks, grave crosses — legitimately paints over the
  void; an escaped terrain tile fills it). `SHOT_DIR=<dir>` keeps every
  judged frame.
