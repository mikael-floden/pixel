# Welcome, UI/HUD agent — onboarding from the game agent

You own Nangijala's UI/HUD layer. The authoritative docs are
`games2/CLAUDE.md` (Mobile/PWA + HUD sections) and `games2/UI_AGENT.md` (the
file-ownership split — it is current where this file is historical). This
file is the game agent's handoff of TECHNIQUE: how the maintainer reviews,
and the extraction/registration recipes that survive every UI generation.

## 1. Ownership

See `games2/UI_AGENT.md` — it is the live split. Art domains (`tiles2/`,
`maps2/`, `characters2/`, `scenery/`) are read-only, always. UI concept art
comes from the MAINTAINER directly as uploads; extracting it is yours.

## 2. How the maintainer works (this is most of the job)

- He iterates in rounds of annotated screenshots. Colour code: RED = remove /
  wrong, BLUE = restore / keep-this, GREEN = keep, arrows = "should extend
  here". A single blue dot can be a coordinate (e.g. a rotation pivot).
- Apply marks LITERALLY — pixel-for-pixel: register his screenshot to the
  asset (§4) and apply each marked cell. Don't improvise beyond the marks;
  don't "improve" nearby pixels. (Block-snapping a mask to "make it look
  like pixel art again" was rejected flat: "The before looks much better, so
  keep the before.")
- His reposted images accumulate JPEG artifacts ("Each time I repost an
  image the graphics get more and more jpeg artifacts") — prefer the FIRST
  upload of any asset as pixel source, and keep your own extracted
  intermediates.
- AI-regenerated reference images are NOT pixel ground truth ("pixels and
  shapes will not align correctly"). Use them for intent and for borrowed
  FILL pixels, registered locally (per-band, small offsets), never as a
  global overlay.
- Always send verification crops back (SendUserFile) — he reviews from his
  phone. Crop tight to what changed; downscale big screenshots.

## 3. Golden rules (violations get caught immediately)

- PIXEL ART SCALES NEAREST-NEIGHBOUR ONLY. Everywhere.
  `image-rendering:pixelated` on every img/canvas,
  `imageSmoothingEnabled=false` in canvas code, NEAREST in preview scripts.
  Box-averaging is allowed ONLY when baking an asset DOWN to its final
  display resolution.
- Uploads are blurry upscales. ALWAYS find the native pixel grid first
  (measure block size, or register against a known-native sibling asset),
  box-downscale to native, THEN key/extract. Keying at upload resolution
  gives ragged edges ("Your way of extracting the graphics makes it look
  terrible!").
- Keying: use hue-axis channels, not distance-to-colour alone. Magenta bg:
  alpha from `min(r,b)-g`, then unmix `art=(px-(1-a)*MAG)/a`. Teal bg:
  beware DARK pixels and DARK GREEN — both look "teal" to naive tests
  (`g-r` alone eats vines; add `b > g-25`-style guards). Decontaminate edge
  pixels by masked averaging (average art pixels only, then downscale).
- Always drop floating components (largest-connected-component keep) and
  check the result on BOTH white and dark backdrops — halos hide on dark.
- Buttons/slots keep a crisp 1px black border by construction (paint the
  mask boundary), soft alpha elsewhere; a rotating sprite keeps SOFT
  averaged alpha or rotation shreds it.
- Never hand-fix individual pixels when re-extraction is possible: "I want
  you to reextract the image and not try to fix individual pixels."

## 4. Registering his annotated screenshots

The recipe that works every round: detect the saturated mark colours
(`r>190,g<95,b<95` etc.), mask them out, then grid-search scale (0.05 steps)
× integer offsets minimizing masked L1 against the target asset/frame. His
phone screenshots land anywhere from 5.6× to 11.6× — never assume. Residual
~3/channel = good registration; ~10+ = wrong scale or a JPEG re-post.
Then box-downscale the mark masks to asset cells (threshold ~45% coverage)
and apply red/blue per cell.

## 5. Historical: the frame/plate/sprite-clock pipeline (RETIRED)

The 2026-07-30 wiki-style remake deleted the runtime frame system
(`frame2.ts`), the plate/slot/UI-kit assets, the sprite clock hand, and the
uiZoom compensation machinery (`uiscale.ts` survives only for `loading.ts` +
the reconnect toast — never divide new CSS by `--ml-uizoom`). The extraction
recipes above are what carries over; the asset-specific contracts (frame
cut-lines, clock pivot, plate slices, the z-stack) live in this file's git
history if that art ever returns.

## 6. QA — non-negotiable workflow

- HUD / visual QA runs at DEVICE-WIDTH mobile geometry: Playwright
  `{viewport:{width:393,height:851}, isMobile:true, hasTouch:true}`, light
  AND dark themes (the maintainer plays normal mobile view since the
  remake). The desktop-site squeeze (viewport 980×2123, screen 393×851)
  still matters for the CANVAS (WorldScene.zoomFor) and the wiki drawer's
  iframe scaling — check it when touching those.
- Dev stack: `(npm run dev > log &) && sleep 9` — it dies between Bash calls
  sometimes. Chromium at /opt/pw-browsers, `playwright-core`,
  `--no-sandbox`, run from games2/.
- Before any push: `npm test` (includes check-surfaces), `npm run
  typecheck`, `node scripts/verify-smoke.mjs` (its jump-anim check is
  occasionally flaky — rerun once before suspecting yourself). NEVER push
  red.

## 7. Process

Always push to `main` (rebase on reject — other agents push constantly).
Push → auto-deploy to nangijala.online. Commit messages: what + WHY with the
maintainer's quoted reasoning — the git log is the project's memory. Update
`games2/CLAUDE.md` / `games2/UI_AGENT.md` when you learn a rule the hard
way; those files are why this handoff is possible.

Read the maintainer's marks carefully, verify with his phone geometry, and
never let a red test past you.
