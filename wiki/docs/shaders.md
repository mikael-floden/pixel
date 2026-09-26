# The Shaders page — the wiki's chrome around the shader agent's stage

Items > Shaders (admin only while nothing is bound to a skill). The contract
with the shader agent is `shaders/docs/wiki.md`; this page holds the wiki's
side of it and the reasons.

## The split

**The shader agent owns the stage; the wiki owns the page.** An effect is
GLSL, not a sprite, so the only honest preview is the runtime itself: the
page embeds `shaders/viewer/index.html?embed=1&…` from the SAME root as the
catalog (`/assets/shaders/`, never GitHub — a list can never name an effect
this deploy's viewer cannot draw) and drives it over `postMessage`. The embed
shows the **stage only**; the wiki draws every control around it in its own
chrome: the timeline of sound moments, replay / loop / speed, the level, the
time of day and the torch, the ground stepper, who is on stage, the volley,
the tunables, the verdict, the agent's notes. (The viewer keeps its full UI
for the shader agent's standalone use; the wiki's page must not show a
control twice, and on a phone the stage must stay in view while a slider is
dragged — the agent's own page is built the same way.)

- The viewer's own controls are hidden from the wiki's side: a `<style>`
  injected into the embedded document (same origin — the contract's own
  condition) hides everything but `.stage-wrap`, and the iframe is sized to
  the stage (`ResizeObserver` in the child window). Another origin, or a
  viewer that renames its classes, degrades to the viewer's full page inside
  the frame — never to a broken one. Asked of the shader agent: own this in
  `viewer.css` under `body.embed`, after which the injected rule is a no-op.
- The stage is `position: sticky` under the topbar and the crumb row on a
  phone (both heights are measured into `--topbar-h` / `--crumb-h`), and
  capped at 760 px wide on a desktop.

## Every stage setting is kept and re-asserted

`shaders:state` (the viewer posts it after every change, its own or ours) is
the truth; the page keeps the last one in `localStorage` (`wiki-shader-stage`),
writes it into the iframe `src`, and on `shaders:ready` re-asserts what
differs (`shaders:set`, or `shaders:open` when the stage came back showing
another effect). Why: **`route()` replaces `#content`, and an iframe removed
from the document and re-inserted RELOADS** — every commit and every
navigation reloads the stage, and it must come back exactly as he left it
(the contract's "an iframe that #content's re-render reloads comes back as it
was"). ‹ › between effects posts `shaders:open` into the running stage
instead (no reload; `shaders:selected` with the same id is ignored, so it
cannot loop). A control under his finger is left alone by the echo's repaint
(`pointerdown` … `pointerup`, or focus).

## The timeline

Built from the stage's own `shaders:timeline` (every play: `events` with
`event`, `index`, `t` in seconds from the cast; `sounds` = the effect's slots
with `sound_event`), never from the wiki's own arithmetic: the caster's clip
frames (`catalog.cast_anims[stage.anim]`, the key frame lit — the spell
leaves on it), a mark per moment coloured by kind (cast, release, impact /
hit / peak / hop, start / stop), the channel bed of a sustained effect from
its release to its stop, a playhead. The playhead runs on the wiki's clock at
the stage's speed and is **re-synced on every `shaders:event`** — the
stage's clock wins (its frame `dt` is capped at 0.1 s, so under load it runs
slower than wall-clock).

**The slots are where sounds are bound** (the contract: the wiki owns the
sound bindings). Each slot shows what is bound to its `sound_event` — the
event the composer has wired (`state.data.sfx.events`) or the newest request
he queued (`live/tuning/sfx_requests.json`, `event` = the slot's
`sound_event`, plus `scope {domain:"shaders", id}`, `slot`, `loop`) — and the
same picker as every other sound in the wiki. On `shaders:event` the page
plays what is bound to each of the message's `slots` **beside** whatever is
sounding (a volley's three releases overlap in the game — `playLayer(l,
{solo:false})`, or a raw take through the engine's own decode cache); a
`loop` slot starts a looping source at its release and stops it on the
stage's `channel-end`, a new play, or leaving the page. `wiki-shader-sfx`
(a toggle on the panel) silences the previews. The AudioContext is resumed
on any pointerdown on the page: a phone needs a gesture.

## Tuning

The tunables come from the catalog's `tune` schema (`color | range | bool |
select`, `def`, `min`, `max`, `step`, `label`). A change is applied when he
lets go (`change`, not `input`): the page updates `live/tuning/shaders.json`
in memory the contract's way (what differs from the default + `was` = the
defaults it replaced; back to default = the entry is deleted, and `touch()`
runs after the deletion so the save SENDS it as one) and hands the whole
table to the stage (`shaders:tuning`), which recasts with it. Rejected: the
viewer's own tune panel inside the iframe — it put the stage's controls
under a second scroll and could not sit below a sticky stage. Asked of the
shader agent: a `shaders:tune-set {id, values}` that applies live without a
recast, for sliders that move the effect while he drags.

## Verdicts

`live/feedback/shaders.json`, one entry per effect keyed by the catalog
`key`, **stamped with the catalog `version`** (`feedbackRow(..., { stamp:
{ version }, stale })`): a stamp that differs from this deploy's means the
effect's code changed after his verdict, so the card says "changed — judge
again", the page names it, and the verdict paints as undecided until he
judges again — the Candidates pattern.

## Gate

`wiki/tools/check-shaders.mjs` (serve-assets on 8902; swiftshader WebGL):
the list; the embed from `/assets/shaders/viewer/`; the effect DRAWS
(bright pixels in composited screenshots — a WebGL canvas reads back blank
between frames); the stage only, the iframe the stage's height; the timeline
against the stage's own schedule (marks, slots, ONE key frame, the bed, a
moving head, events arriving); every control against the stage's
`__nfx.state`; a re-render's reload coming back as left; tuning applied,
committed in shape, Reset sent as a deletion; the version stamp and a stale
verdict; ‹ › without a reload; the volley's three releases; a queued sound
shown on its slot and PLAYED when the moment fires; the serving allowlist.
