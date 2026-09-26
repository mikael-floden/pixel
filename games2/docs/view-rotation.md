# View rotation — the world drawn N, W, S or E up

Branch-only (`claude/rotate-view-real-renderer`); not on main, not live.

## The one rule: RENDER-ONLY

Simulation stays in **server space**: `world`, `terrain`, prediction, collision,
every position from the Colyseus state, every `room.send`. Only what is **drawn**
turns. So a turn can draw something in the wrong place, but it cannot move the
player, desync the server or change a gameplay rule. (Rotating the simulation
instead would put the server's uniform-screen-speed rule, collision and every
ingestion point in play — the render boundary is ~30 sites, the simulation
boundary is the whole game.)

- `viewrot.ts` — the rotation, pure and DOM-free (the resolve worker imports it).
  One clockwise quarter-turn: cell `(x,y) -> (H-1-y, x)`, point `(x,y) -> (H-y, x)`,
  displacement `(dx,dy) -> (-dy, dx)`, facing `+2` in the 8-ring
  (`south, south-west, west, north-west, north, north-east, east, south-east`).
  `rotCell/unrotCell`, `rotPoint/unrotPoint`, `rotVec/unrotVec` are exact inverses
  (`server/test/viewrot.test.ts`, on the_game cell for cell).
- `viewWorld` — `parseWorld(rotateWorldDoc(world.json, k))`. The ground resolver
  AND ITS WORKER (which fetches world.json itself — rotating only the main thread
  left the worker resolving the unturned world), scenery, and the night pass are
  built from it.
- `projectFlat` / `projectCellCorner` take SERVER input and turn it;
  `projectFlatView` / `projectCellCornerView` take VIEW input (scenery). Turning a
  view-space input again rotates it twice.
- Screen -> world (`pickGround`, `nearestGroundTo`) un-turns once, right after the
  inverse; everything after it is server space.
- Keys and the stick are SCREEN directions of the turned view; the movement code
  (shared with the server) reads screen input of the UNTURNED frame. One
  quarter-turn is `(ax, ay) -> (ay, -ax)` in key space — exact for all eight
  directions, the diagonal grid-axis lock included; the stick bearing turns -90°.
  Input follows `inputRot`, which switches only when a turn's overlay has gone
  (mid-turn the player still sees the old view); taps are swallowed mid-turn.
- The stick's lean runs on the screen the finger sees (the VIEW keys and the raw
  bearing), then maps through the world once (`unturnScreenVec`, S R^-k S^-1). A
  quarter-turn of the grid is not a quarter-turn of screen bearings on a 32x14
  screen: turning the bearing by -90 ran up to 14.6 deg off between the octants.
- Facings: `stableDir` turns every displayed facing once; a turn re-bases
  `dispDir`/`pendDir` by the turn delta. NPCs keep their LOGICAL facing in
  `npc.dir` (every comparison reads it) and draw `rotDir8(dir, viewRot)`; their
  HOME is re-asked of the turned side's art (`npcFacing`): kept when the DRAWN
  facing has an idle, else the camera's south — the no-frozen-NPC rule, applied to
  what is drawn (faithfully turned, all 31 froze at 90 and showed backs at 180).

## Why no new art

A Wang boundary tile is indexed by its SCREEN corners (`8*NW + 4*NE + 2*SW + 1*SE`),
so rotating the data makes the resolver compute the permuted index and fetch a
tile that already exists (283 of 284 transition sets carry all 16 masks; the
convention holds at 96.46% of 18,039 sampled corners). The plate art is lit in
SCREEN space (a tile warped 90° matches its rotational partner no better than an
unrelated tile: 45.29 vs 45.37 MAE / 255), and the sun's cast direction is a GRID
vector that is deliberately NOT turned — read in the turned grid it points the
same way on screen, so every shadow falls where it always did.

## Same world, not a re-rolled one

Every resolver pick hashes cell coordinates (base set per region CHUNK, member per
cell, slope set, fade and detail rolls). `tiles3.setPickFrame` keys them by the
SERVER cell, so a turned view draws the same sets, members, fades and details —
keyed by the drawn cell, a turn re-rolled the world (the chunk grid does not even
line up once turned). Identity unless a turned view installs it: `tiles3.test.ts`
output is byte-identical to main's, its two pre-existing failures included.
Directed scenery that would face AWAY (its art exists only for camera-facing
sides) is hidden IN PLACE — never dropped — so every scenery index still joins
the server's footprints.

## The night pass

`NightLights.setWorld` re-arms the room texture's WRITE-ONCE cave channels (G =
depth from daylight, B = ceiling underside) and clears them: latched, the turned
publish was ignored and each view cell took the cave depth of whatever cell sat
there unturned — a black block over the river at 90 (37% of the frame, measured;
0.4% after). It redraws the heightmap canvases IN PLACE and re-binds every
sampler by key: the shaders bind their textures once when built, and deleting the
block-max grid left all three marching against a dead texture (the turned view
went near-black). The room, cave and cut maps, scenery footprints, torch, fog
centre, lit copies and campfire light are server-keyed and are re-keyed to the
view before they reach it (`publishRoom`, `viewFootprints`, `rotFootprints`) —
handed over as-is, "outside the room gets zero ambient" blacked out open river.

## Indoors

The cut-away is a function of the VIEW: the covering cone sweeps DOWN-SCREEN, a
different server direction per orientation. `computeIndoorCuts` runs on the turned
grid (`viewTerrain`, `viewDeckIndex`, the space re-keyed) and stores the answer
server-keyed; every drawing pass reads the memoised view twin (`drawKeyed`), bodies
and taps the server map. The mask signature carries `viewRot`, and a turn indoors
re-cuts before its repaint. Scenery, window and lamp room tests convert their drawn
cells first (`srvCell`, `unrotPoint`).

## Ambient

A turn dispatches `ml-view-turn`: the zone field drops its drawn-point picker memo
and mist raster (stale, they read the wrong zones — a pale mist sheet over a whole
turned view), the zone outline re-projects, and features drop per-drawn-cell caches
(`viewTurned`).

## The turn (`rotfx.ts`)

Built from the renderer's OWN two frames: A (the frame just drawn) and B (taken
once the turned view is DRAWN). The terrain's height field (one box per cell,
decks as slabs) is textured by PROJECTING those frames from the cameras that
took them, and an orthographic camera orbits the pivot (the ground under the
camera's centre):
- exact at both ends — when the render camera is a frame's camera every fragment
  samples its own pixel; the first frame IS A, the last IS B;
- real parallax between — cliffs, stairs and bridges turn as solids;
- a depth test per frame (RGBA-packed; WebGL1 has no depth texture) stops a
  cliff's pixels painting the ground it hid;
- what is still approximate (bodies and scenery are not in the mesh, so their
  pixels lie on the ground behind them) is blurred along the ground plane's own
  elliptical arc, peaking at mid-turn; the blur is a dial (`turnView`'s 4th arg).
FRAME B WAITS FOR A NON-VACUOUS SETTLE: every art key on the cells in view is a
texture, no cell in view is owed a repaint, the ground pass has blitted, at least
60 cells were checked, held for five checks 100 ms apart. (A test that checked
nothing answered "drawn" 20 ms after the swap and B was a half-painted view.)

Hooks: `__ml.viewRot(k)` (instant), `__ml.turnView(dir, ms, waitB, blur)`,
`__ml.turnSeek(u)` (pin progress for screenshots), `__ml.turnInfo()`,
`__ml.pickAtView/surfaceAtView` (view-space twins for the foam layer). Keys: Q / E.

## Measured (headless Chrome, maintainer's screen 393x851 @2.75, software GL)

- Swap: rebuild ~330 ms; parse of the turned doc ~45 ms (the first turn's
  world.json fetch ~6.5 s under load — a cache hit on a phone).
- Frame A capture 65 ms; turned view drawn (art streamed) 87-121 s HERE, where
  art streams at ~1 item / 3 s; a phone's is the number that decides the feel.

## Known gaps

- At 90/270 the server's uniform ON-SCREEN speed rule is applied in the unturned
  frame: left/right would run 2.29x and up/down 0.44x on screen (32/14). Fix =
  a per-input view rotation that server and prediction both honour.
- One-sided art: the 96 wall pieces (windows, hearths, hangings) exist only for
  camera-facing walls (all 96 face away at 180°); NPC idle art exists only for
  south/south-west/south-east (faithful rotation freezes all 31 at 90/180 and
  shows their backs at 180 — a taste call); undirected anisotropic scenery
  (beds, rugs, boats) draws its south still from every side.
- Indoors while turned: the cut-away masks are still read by the drawing loops
  in server keys.
- The spawn-area debug overlay is not re-placed on a turn; the minimap stays
  north-up.
