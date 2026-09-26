# View rotation — the world drawn N, W, S or E up

LIVE, on the spin bar's arrows, not behind a switch (maintainer 2026-09-26: "Put
it on the buttons always. We will fix any bugs and move forward.").

## The spin bar drives it

`spinbar.ts` is games-ui's and knows nothing of the world; WorldScene listens.
A tap on `.ml-spinbtn.left/.right` moves a GOAL one quarter as the finger lifts
(the bar's own `ml-spin` fires only when the orb rests, 360 ms a quarter later),
and `ml-spin {quarter}` then settles the goal on the orb's quarter. The view
chases the goal a quarter at a time (`chaseSpin`), and A DRIVEN TURN MOVES LIKE
A BODY (`TurnDrive`): a velocity that carries across quarters, a constant
acceleration (a lone quarter is a triangle profile over 1100 ms, peak 2/ms
quarters), a braking curve that stops it exactly on the goal — read every frame,
so a tap mid-quarter re-plans it. Owed more than this quarter, it runs on through
at speed: its overlay (showing B, the live view) is HELD until the next quarter's
frame A covers it, so a chain neither stops nor flashes between quarters (each
quarter faded out and eased to rest before). Owed none, it decelerates, turns
round, and at A swaps the renderer back — his orb's rule, "change direction
immediately and go back". The blur and the zoom pulse follow that velocity, not
the clock. PREPARE, THEN RUN (maintainer 2026-09-26, on the live build: "it lags
like crazy in the middle of the rotation animation"): until B is COMPLETE — the
frame, its bodiless twin, its owner map — a driven turn only creeps (to 0.12 at
0.12/450 ms), so every swap, upload, readback and extra render lands while it
barely moves and the fast middle draws and nothing else (it crawled at mid-turn
waiting for B, up to 3 s, and took B there). Its B settle is 3 checks 60 ms
apart, capped at 1.5 s. THE CUBE FOLLOWS THE WORLD ("it's not in sync with the
cube rotation"): the chase publishes `ml-view-angle {q, goal, busy}` every frame
in the bar's quarters, and `spinbar.ts` draws the cube at the target minus the
world's remaining turn — on its own 0.4 s clock it was done before the world
had begun. A turn that did not happen (dead, no world yet, a swap that threw) is
retried from `update` a second later. Q / E `.click()` the bar's own buttons, so
the orb and the view never disagree. The debug hooks keep the eased clock.
THE DIRECTION IS THE ORB'S: his orb's front face moves RIGHT on a right tap, so
the world's near side does too — `viewRot - 1` per right quarter (the picture
turns anticlockwise).

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
- THE ON-SCREEN SPEED IS THE TURNED SCREEN'S: each input carries the view it was
  steered in (`InputMessage.vr`, the server takes it mod 4; prediction replays each
  window under its own, like `sm`), and `screenToWorldVector`, `gaitSpeed` and the
  slide shares measure screen length on that view (`screenLenTurned`: only the
  turn's parity matters). The direction arrives un-turned; only the length moves.
  (Measured unturned at 90/270, left/right ran 2.29x and up/down 0.44x.)
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
A directed piece turned to face AWAY (its art exists only for the camera-facing
sides) shows the NEAREST side it has — east and north-east take south-east, west
and north-west south-west, its back the camera's south (`nearestCameraFacing`;
the NPCs' rule: a drawn facing with no art faces the camera). Hidden instead, 46
pieces left the houses at 90° and their cards faded out of every turn. A piece
HUNG ON A WALL (`z`: windows, hearths, hangings) belongs to the wall's far face,
so it is hidden IN PLACE — never dropped — and every scenery index still joins
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
UPRIGHT THINGS ARE BILLBOARDS, ALWAYS STANDING (maintainer 2026-09-26: "The player,
monsters, npcs and scenery should not rotate ... billboards that are always rendered
straight up ... show motion blur however"). Players, NPCs, monsters and the
depth-resolved scenery are not in the terrain mesh; textured onto it they lay flat
and smeared into streaks mid-turn. At A and at B the renderer draws one more frame
WITHOUT them (under the overlay, invisible): the mesh wears that bodiless frame, and
each thing is a CARD — its pixels are the difference between the two frames (a
waterline crop, the light and its name come along), carried by its feet' projection,
depth-tested at its feet against the mesh (a bridge in front hides it as the painter
did; its name draws on top, as labels do), drawn back to front BEFORE the blur pass
(so it blurs with the scene). Overlaps are settled by an OWNER MAP: the things drawn
once more as flat colours in the painter's order into an off-screen target, read back
once, so each card keeps only the pixels it owns (grouping overlaps instead carried
the player off-centre with the front-most NPC's feet). THE SET IS TAKEN IN THE FRAME
IT IS CUT FROM (`turnCapture`: rects and owner map after that frame's update, the
frame on its render; the bodiless twin hides the same OBJECTS a frame later): cut
from the next frame, anything that moved in between kept a rect its frame held
nothing in, and walking NPCs vanished for the whole turn. Every card, the player's
too, crosses A to B mid-turn, solidly (the next card over the last, the last
fading only once the next is whole). (A third facing for the player — the side a
45° camera shows, cut from one more frame — was dropped: that frame differed from
the bodiless one wherever grass or a light flickered, the card kept every such
pixel at the player's depth over the player's whole rect, and painted ground over
every NPC behind for the middle of the turn.) A
thing only ONE frame saw (leaving or entering the view) is matched by name
(`RotBody.id`; scenery by its server feet, which the swap's rebuild keeps) and
keeps its one card all turn, fading only at the far end — handed over at
mid-turn, a lamp leaving the view vanished mid-screen. A card samples only what
its frame saw: a rect past the frame's edge, clamped, drew a striped block.
THE LOOK (`RotTune`, `__ml.turnTune`, defaults his to change): `blur` scales the
arc; `zoom` 0.1 is a zoom pulse about the pivot riding the angular speed (keeps
more of the screen on ground a frame saw); what NEITHER frame saw is a soft 5x5
average of the nearest frame's edge region (`soft` 0.02 uv), dimmed with the
distance outside (`dim` 0.35) — a clamped sample streaked one edge texel across the
bottom third; a frame's border is feathered over 5% so seen-and-sharp meets that
fill in a band; `vignette` 0.28 darkens the rim at peak speed. (Compared in one
turn: none / gentle / strong / zoom-only — strong went dark, none streaked.)
THE FADE IS AT THE BLUR'S PEAK (maintainer 2026-09-26: "motion lines from the 90°
view to meet in the middle so the fade takes place at the max blur"): `fade` 0.06
is the half-width, in turn progress, of the ground's A-to-B mix, centred on
mid-turn; before it the screen is A alone (its motion lines growing), after it B
alone (its lines dying away), and every card but the player's hands over inside
it. (A fade across half the turn, 0.25-0.75, laid the two views over each other
for most of the orbit and muddied both sets of lines.)
FRAME B WAITS FOR A NON-VACUOUS SETTLE: every art key on the cells in view is a
texture, no cell in view is owed a repaint, the ground pass has blitted, at least
60 cells were checked, held for five checks 100 ms apart — and no occluder cell in
view is incomplete and no scenery still is streaming (a B taken on the ground
alone ended the turn on holes, then the live view popped them in). (A test that checked
nothing answered "drawn" 20 ms after the swap and B was a half-painted view.)

Hooks: `__ml.viewRot(k)` (instant), `__ml.turnView(dir, ms, waitB, blur)` (in
VIEW quarters: +1 is the picture clockwise; neither moves the spin goal),
`__ml.turnSeek(u)` (pin progress for screenshots), `__ml.turnInfo()`,
`__ml.pickAtView/surfaceAtView` (view-space twins for the foam layer).

## Measured (headless Chrome, maintainer's screen 393x851 @2.75, software GL)

- Swap: rebuild ~330 ms; parse of the turned doc ~45 ms (the first turn's
  world.json fetch ~6.5 s under load — a cache hit on a phone).
- Frame A capture 65 ms; turned view drawn (art streamed) 87-121 s HERE, where
  art streams at ~1 item / 3 s; a phone's is the number that decides the feel.

## Known gaps

- One-sided art: the 69 wall pieces (windows, hearths, hangings) exist only for
  camera-facing walls and are hidden when turned away (all of them at 180°);
  the 27 free-standing directed pieces show their nearest side; NPC idle art
  exists only for south/south-west/south-east (faithful rotation freezes all 31
  at 90/180 and shows their backs at 180 — a taste call); undirected anisotropic
  scenery (beds, rugs, boats) draws its south still from every side.
- Indoors while turned: the cut-away masks are still read by the drawing loops
  in server keys.
- The spawn-area debug overlay is not re-placed on a turn; the minimap stays
  north-up.
- A chained quarter still holds for its frame A (three frames) at the junction,
  and creeps near its start while its B is drawn.
