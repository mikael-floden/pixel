# Dev-test workflow

Where a test belongs, the browser gates, the harness traps, device geometry. Moved verbatim out of `games2/CLAUDE.md` (2026-09-09), which keeps the law and points here; the measurements, traps and rejected approaches live in this file. Rewrite in place under the root doc law.

## Dev-test workflow (fast loop — keep it this way)

- **A DERIVED FIXTURE DRIFTS WITH THE WORLD, AND A SILENT ONE IS WORSE THAN A
  TYPED ONE** (verify-lightparity, repaired 2026-09-14). The gate takes "the
  lit piece nearest spawn" as its outdoor lamp — correct when it was written
  (a streetlight on the road) and a SEALED HEARTH INDOORS once the town grew
  around the spawn house, which is indoor-only by design. Three arms then
  measured a wall and failed for the right reason about the wrong subject. A
  derivation must carry the property the arm depends on: the lamp is now the
  nearest lit piece that stands OUTSIDE every room (`world.rooms`), which is
  what "holds a world slot while I stand beside it" needs. Same class: the
  sweep that finds plain night ground indexed the ground rows with a placement's
  FRACTIONAL y (`ground[233.04]` is undefined), so every cell read as "no
  ground" and the gate died on a null.
- **A RING OF PIXELS AROUND ONE SITE IS NOT A LIGHT MEASUREMENT** (same
  repair). Luminance around a lamp is whatever the MAP put there — the ground
  material, the neighbours' art, the piece's own contact shadow. Measured at
  today's fixture the profile RISES outward (1.2:107 2:99 3:110 4:159 6:174
  8:183) while the pool falls away the whole time. A pixel claim survives only
  where the confounders CANCEL — the same piece at the same radii, as a ratio
  (the twin-parity arm) — and a falloff is asked of the light the pipeline and
  the shader both read (`__ml.lightAt`). The lesson generalises: pixels prove
  a DIFFERENCE between two pictures of the same thing, never a value.

- **A BUDGET WITH NO TEST IS A BUDGET THAT DRIFTS** (`server/test/lawsize.test.ts`,
  2026-09-14). `games2/CLAUDE.md` is loaded into every turn of six agents and the
  maintainer capped it at 20 KB when he split it; nothing measured that, and it
  was 20,648 bytes — over by 168 — with no one at fault, because a doc grows one
  correct line at a time. The same shape as the derived fixture above: a rule
  stated only in prose is a rule that decays. When it fails, a MEASUREMENT moves
  into the `docs/<topic>.md` that owns the subsystem (check the receipt is really
  there first) — never a rule.

- **Navigation/movement logic → `server/test/navigation.sim.test.ts`**, NOT
  the browser: the real brain (stepAutopilot) against the real body (unstick
  + stepMovement + auto-jump) on REAL worlds at ~1000× real time — ~100
  seeded trips × three frame cadences (16/133/400ms; the laggy rows catch
  the big-dt freeze and orbit classes) in ~2s inside `npm test`. On failure,
  print stepAutopilot's debug fields — full forensics, no browser.
- **Browser = graphics + glue only, ONE session**: `scripts/verify-smoke.mjs`
  runs everything browser-bound in a single Chromium + world load (~30s):
  loading overlay, badge, tap run, hold steering, keyboard cancel, jump anim,
  anim rates, in-place reconnect (last — it swaps the session), then one
  reload into the busiest spawn cluster for the monster and occluder blocks.
  Per-feature scripts remain for deep dives.
- **Headless-GL starvation preflight**: verify-smoke measures raw keyboard
  speed first and ABORTS ("HARNESS STARVED") if slow — software-GL at big
  viewports throttles the frame loop into slow motion that fakes "stuck
  player" bugs (cost an hour of ghost-chasing once). Keep e2e viewports
  small (480×320); `scripts/debug-speed.mjs` measures.
- **HUD / visual QA at DEVICE-WIDTH mobile geometry** (the maintainer plays
  normal mobile view): Playwright `{viewport:{width:393,height:851},
  isMobile:true, hasTouch:true}`; check light AND dark when touching themed
  surfaces. Movement-timing e2e stays on the small fast viewport — the
  starvation rule outranks realism.
- **A ONE-PIXEL BUG IS REPRODUCED ON HIS EXACT SCREEN, AND ON THE SCREEN**
  (maintainer law, 2026-09-03: "Please recreate my exact screen when testing
  off by 1 pixel bugs like this one"). Two halves, and both are load-bearing:
  - `{viewport:{width:393,height:851}, deviceScaleFactor:2.75, isMobile:true,
    hasTouch:true}` — 1080x2340 backing. **`deviceScaleFactor` is the half
    that decides the bug**: it sets `renderScale`, hence the camera zoom
    (`cameraZoom(1080, 2.75)` = 3 exactly at rest) and the ground texture's
    `ceil(1080/2.75)=393 (+2*512)` texels. Any other dpr changes the texel
    grid and the sub-pixel phase, so the artefact simply is not there to find
    — a default-dpr viewport at the same CSS size is a DIFFERENT screen.
  - Compare the SCREENSHOT, not the render texture. A ground-RT dump was
    clean through every scroll while the phone showed lines, because a
    sampling artefact lives in how the texture reaches the display, not in
    the texture. Dump the RT to localise a defect you have already seen on
    the screen; never to argue one away.
  - Shoot MOVING as well as at rest. At rest the zoom is the crisp integer;
    the speed zoom-out sheds up to `CAM_ZOOM_OUT` of it, so every frame he
    actually plays is at a fractional zoom where a NEAREST texel is 2 or 3
    device px. Any straight-edge artefact belongs to that state.
- Rule of thumb: no pixels/pointers/websockets/Phaser anims needed → it
  belongs in `server/test` (3s), not a browser (minutes).
- **A WORLD-READING TEST SKIPS WHEN THE TREE IS ABSENT, AND SKIPS BEFORE IT
  LISTENS.** The deploy's test job checks out no world tree (see THE DEPLOY
  GATE, above), so `maps2/worlds3/the_game` is missing there; a test that
  `readFileSync`s it after `gameServer.listen()` throws, the open server keeps
  the process alive, and `node --test` waits for the file forever — deploy run
  3279 (2026-09-09) sat 20 minutes on exactly that and was cancelled, which
  blocked every deploy behind it. The pattern is `if (!existsSync(path))
  return t.skip("the_game missing")` as the FIRST line, and `listen` inside
  the `try` whose `finally` shuts the server down.
