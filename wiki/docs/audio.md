# Sound and music in the wiki

Sound effects as events, the entity-page sound engine, and the music tabs and bench. Moved verbatim out of `wiki/README.md` (2026-09-09), which keeps the rules and points here; rewrite in place under the root doc law.

## Sound Effects are EVENTS, played by the game's own engine

The Sound Effects page is organized by **in-game event** (maintainer
2026-08-05) — "Footsteps · Grass", "Jump" — not by audio file. `buildSfx()`
in build.mjs derives the table from the same sources the composer's engine
compiles from: `sounds/bindings.json`, the `gameAudio.event("…")` call sites,
and the composer's own takeover tables **parsed out of
games2/composer/engine/api.ts** (EVENT_FOLEY, JUMP_VOICE, the FOOTSTEP_*
routing/trim/layer maps) with a drift sentinel that warns loudly on any
regex miss. A board request stands for a published `composer/events.json`
to replace the parsing.

- **Playback mirrors games2/composer/engine/oneshot.ts exactly** — take
  round-robin that never repeats, pitch 2^(semis/12)×rate with the jitter
  ranges pre-gentled (×0.35) at build, gain = mix + event trim + bus fader
  ± gentled jitter, per-layer lowpass, the 30 ms debounce. BufferSource on
  purpose: HTMLAudio pitch-preserves on rate change, exactly the wrong sound
  for the half-speed-authored voice takes (raw voice = ×2). Not mirrored,
  honestly: scale-snap, pan/distance, beat quantize — they need the running
  game. check-sfx.mjs asserts the computed rate/dB/lowpass per layer against
  the data.
- **An event's ▶ plays every layer at once** (grass = the grass set AND
  dirt underneath at −6 dB relative); each row's ▶ plays that sound alone.
- **Players see only events that make sound.** Silent events, "not fired
  yet" pills, stars, the add-a-sound form and the raw all-sounds library
  are Game-Master-only.
- **A BINDING is not a RECORDING** (maintainer 2026-08-06: "if I remove a
  sound from an event that doesn't mean I want to delete the sound … it just
  means I want to unbind it"). Two different verdicts, in two different
  places:
  - On an **event card**, one verdict row per attached sound — "this sound,
    for this event" — writing to `live/feedback/bindings.json` with
    `<eventId>#<sound>` ids. Its ✕ reads **"✕ unbind"** and detaches the sound
    from that one event; the recording is untouched. Take rows carry ▶ + name
    + length and nothing else: judging a recording is not this page's job.
  - In **All sounds**, the file's own stars/approve/✕ — and there ✕ really
    does retire the recording everywhere, as the tooltip and the section's
    intro both say out loud.
- **Stars on a recording** go to its OWNER: catalog takes →
  `feedback/sounds.json`, composer takes → `feedback/composer.json` (ids
  `composer/foley/<set>/<take>`). Binding verdicts go to the composer via
  `feedback/bindings.json`.
- **Add-a-sound requests** ride the normal save path into
  `live/tuning/sfx_requests.json` (`pixel-wiki-sfx-requests@1`, server key
  `tuning/sfx_requests`): a sound, pitch / volume dB / max random pitch, note.
  The composer agent consumes and deletes entries it acted on.
- **Assigning a sound is a LISTENING job** (maintainer 2026-08-06), so the
  picker is a real dialog (`openSoundPicker`), not a `<select>`: search, one
  row per sound with its length and whether the game already uses it, ▶ on
  every row, Prev/Next (or ↑/↓) that step AND play as they go, and pitch /
  volume / random-pitch sliders whose numbers ride along in the request
  (volume's normal value is **0 dB = exactly as recorded**). The generic
  `dialog input` rule is scoped to `:not(.sfx-picker)` — it is the sign-in
  dialog's full-width stacked field and it wrecked these rows.
- **The dialog names its target** (maintainer 2026-08-06): "Assign a sound to
  Drop", "Assign another sound to Footsteps · Dirt". Three screens into 117
  sounds, a bare "Assign a sound" no longer says what you are listening FOR.
- **The dialog's geometry is FIXED** (maintainer 2026-08-06: Next must be
  where it was after you press Next). A modal is centred, so anything below
  the list that changes height moves every control: the list's `height` is
  fixed, not a max (a 3-result search shrank it and dragged the buttons up),
  the empty state renders INSIDE the list, the transport row is `nowrap`, and
  the "Selected: …" line is gone.
- **Opening the picker must not raise the keyboard** — only tapping the search
  box may. `showModal()` focuses the first field, so the dialog carries
  `autofocus`+`tabindex="-1"` and, because that is not honoured everywhere,
  takes focus back by hand in the same task (no frame for the keyboard to
  slide up in). A desktop — `(hover: hover) and (pointer: fine)` — still
  focuses the search. The dialog's own focus ring is suppressed: it is a
  container, not a control.
- **One button, both places**: `assignSoundBtn()` renders "Assign a sound…" /
  "Assign another sound…" on event and entity cards alike. Its chain is an
  **inline SVG in `currentColor`**, not U+1F517 — that codepoint has emoji
  presentation, so a phone draws a colour picture next to monochrome text
  ("should not be a colored smiley").
- The entity card is titled for what it MAKES — "New sound effect event" — and
  its action `<select>` is styled as a wiki control (raw browser chrome
  ignored dark mode). Its width is capped in `em`, not `%`: a percentage cap
  against a shrink-to-fit flex parent collapsed the box and "Idle" rendered as
  "Idl".
- **One row per RECORDING, not per folder** (maintainer 2026-08-06: "you
  don't let me select the sound. You point to a group!"). A set is a folder of
  alternatives — `ui_tick` holds three clicks, `jump_voice` four grunts — so
  listing sets showed 128 rows for 183 real recordings and made take 2 of
  anything unreachable. Every take is its own row, labelled `flavour · take N`
  when its set has more than one. The request carries **`take`** (the exact
  file) beside the existing `sound` (the set id the composer already parses),
  so what gets bound is what was heard, and "in game" is computed per
  RECORDING from the event table's bound files — not "something in this folder
  is used".
- **…and one row per take is still not every generated sound.** The composer
  generates a **pool** per brief, scores it and copies only the winner(s) out
  as takes, so a set's rejected candidates were audio no page in this wiki
  could reach. They are listed as `flavour · alternative N`, right under the
  take they lost to, best-scoring first.
  - **Dedupe is by CONTENT HASH, never by path** (`fileHash` in build.mjs):
    promoting a candidate to a take is a plain file copy under a new name, so
    the paths never match and the bytes always do. Compare paths and every
    winner shows up twice.
  - They ship because the composer's score answers *"does this fit the brief
    it was generated for"*, a **different question** from *"is this the sound
    I want for my event"* — a candidate rejected as a grass footstep is a fine
    rustle for an item pickup, and only the Game Master can say so. Hence no
    quality badge on them either.
  - **Assigning one is a request to PROMOTE it.** The request carries the pool
    path in `take`, so the composer must copy that file out of `pool/` into
    the set and add it to `takes` in `foley.json` — wiring the `pool/` path
    directly would leave a bound sound the pipeline treats as a discard.
  - Gate: **`wiki/tools/check-everysound.mjs`** — the durable answer, checking
    no number anyone typed: it walks `games2/composer/foley/**` and
    `sounds/**`, hashes every audio file, and fails unless each one is listed
    in `data.json` or byte-identical to one that is.
- **Grouped by action, and it lists EVERY composer set** — wired or not
  (their ask, 2026-08-05: ~10 `<action>_<flavour>` alternatives per action,
  winner wired afterwards). `composerGroups()` derives the action rather than
  hardcoding it: a set's group is its longest underscore prefix that a sibling
  shares, singletons collect under "Other". Under a `HIT TAKEN` header the
  rows read `armor` / `bass` / `coat` — the flavour is what you choose
  between; the full name stays in the tooltip and the request.
- **Opening the picker silences EVERYTHING** (maintainer 2026-08-06). A modal
  `<dialog>` blocks the controls for every audible thing on the page, and
  three independent sources can be sounding: `sfxEngine` (the WebAudio
  auditions), the shared `#shared-audio` element (music beds and entity
  takes), and **the game itself behind the drawer** — whose "🔇 Mute the game"
  button exists only on the Sound Effects and Music pages while the picker
  also opens from monster and character cards. `openSoundPicker()` calls
  `stopAllAudio()` (both wiki players) and `setGameMuted(true)`.
  - **It restores only what IT muted**, the same contract the drawer keeps
    with the player's own switches (`wikipanel.ts`): if Mute was already
    pressed, closing the picker leaves the game quiet. Restore runs off the
    dialog's `close` event, so Cancel, Assign and **Escape** all behave alike.
  - `setGameMuted()` is the single place that flips it, and it re-labels every
    `.mute-game` button **by query, not through the button's own closure** —
    the picker mutes from outside that scope, and a stale label is how someone
    ends up unable to get their game sound back.
  - `route()` calls `stopAllAudio()` too; it used to pause only the `<audio>`
    element, so a long WebAudio audition survived navigating away.
  - Gate: **`wiki/tools/check-audiostop.mjs`** fakes admin at the network
    layer instead of logging in — all of this is pure client logic, and a real
    login makes the gate skip wherever the password is absent, exactly where a
    regression slips through. Verified to fail (9 assertions) without the stop
    call.
- **Sort: by action, or newest first** (maintainer 2026-08-06, "in a way I can
  still click next next next without the button moving"). A two-button toggle
  under the search box.
  - The date is the composer's own per-SET `generated_at` from `foley.json`,
    so a set's takes and its pool candidates share one date. **The sound
    catalog carries no timestamp anywhere** — not in `viewer_data.json`, not
    in any `metadata.json` — so those sort LAST under "Older — the original
    sound library" rather than being given an invented date. **File mtimes are
    not a substitute**: a fresh clone and the Docker build stamp every file
    alike.
  - Newest-first reuses the existing sticky group headers, grouping by DAY
    ("Today", "Yesterday", "3 days ago", then the date) — no per-row markup,
    so it cannot disturb the row layout.
  - **The transport bar cannot move**, the rule the dialog is built around:
    the list's height is fixed in CSS and the toggle is its own fixed-height
    row, so sorting, searching to zero results and stepping all leave it where
    it was. `check-audiostop.mjs` measures the Play button's y through a sort
    toggle, 8× Next, an empty search and a toggle back, and asserts a single
    distinct value.
- **Prev / Play / Next are thumb-sized** (maintainer 2026-08-06): 46px tall
  and sharing the row `flex: 1` rather than wearing the compact ghost-button
  padding, because you hammer Next/Play down 281 sounds hunting for the right
  one. Equal flex is safe here precisely because all three labels are fixed
  strings — the widths cannot shift under your finger as you step, which is
  the rule `.picker-bar` exists to keep.
- **THE EVENT TABLE MIRRORS THE ENGINE'S OWN RESOLUTION ORDER** — get this
  wrong and the page lies about the game (maintainer 2026-08-06: "the wiki is
  showing old sound mappings not the one playing in the game"). `api.ts` is
  silent-by-default and resolves an emitted event as:
  1. **`EVENT_ASSIGNMENTS`** — what the Game Master assigned in the wiki;
  2. the voice branch + **`EVENT_FOLEY`**;
  3. **`sounds/bindings.json`** — ONLY for the two ids in `BINDINGS_APPROVED`;
  4. otherwise **silence**.
  Falling through to bindings.json for *everything* hid every assigned sound
  and rendered unapproved library RECOMMENDATIONS as bound. Each event carries
  **`via`** (`assigned` / `foley` / `bindings` / absent = engine-driven) so
  the route is inspectable.
  - An assignment may name ONE recording (`composer/punch#take02`, or a
    separate `take`), and `pickTake()` resolves it the way the engine does —
    a take that is not there is **silence, never a neighbouring recording**,
    or a deleted take would quietly become a different sound.
  - An unapproved suggestion for an event the game DOES fire is still listed,
    as **"no sound yet"** with a note naming what the library offers and why
    nothing plays.
- **A NAME IN THE LIBRARY IS NOT A MOMENT IN THE GAME.** `sounds/bindings.json`
  carries rows nothing in the game emits — older spellings, and tools,
  containers and doors no code has yet — which rendered as ordinary empty
  cards indistinguishable from a live event waiting for a sound, where
  auditioning, picking and assigning buys you silence and no explanation
  (maintainer 2026-08-06: "Please remove … This is madness"). **An event earns
  a card by being FIRED or by having a sound BOUND.**
  - **Anything bound is always listed, even when nothing fires it** — that is
    the red "not fired yet" chip. Hiding it would strand a sound the Game
    Master assigned with no way to see or unbind it.
  - The build **prints the hidden list every run** (`sfx.hiddenDeadEvents`),
    so it doubles as a staleness report for the sounds agent, and the day one
    of them starts being emitted it reappears on the page by itself.
    `check-mapping.mjs` asserts no card is both unfired and unbound, and that
    nothing hidden is assigned.
  - `foleyEntry(…, "rotate")` binds EVERY url, so a rotate entry is
    multi-bound even where the wiki showed one primary take: `weather.thunder`
    read "1 take" while the game rotated all six.
  - **Read `games2/composer/assignments.json`, not the engine source.**
    games-audio publish that manifest (`pixel-composer-assignments@1`) and
    their gate fails if it drifts from `api.ts`, so it cannot go stale the way
    an api.ts regex can — a regex on `const assigned = EVENT_ASSIGNMENTS[name]`
    broke the moment they added per-character voices. The source parse is a
    fallback only, so an unbuilt manifest degrades to stale-but-present rather
    than to a page claiming silence.
  - **Per-character assignments**: the engine resolves `player.die@<uid>`
    ahead of the unscoped `player.die`, using this wiki's own spelling. **Die
    has a per-hero row beside Jump and Fall** — one shared card meant the boy
    could not be given his own cry. Each row shows what that hero ACTUALLY
    gets, falling back to the shared cry as the engine does and saying which
    it is (a row reading "no sound yet" over a playing shared cry is the same
    class of lie). The unscoped card is not listed separately.
  - Gate: **`wiki/tools/check-mapping.mjs`**. It checks `data.json` against
    the composer's manifest AND cross-checks that manifest against `api.ts`,
    so neither side can drift silently, and it fails on any bound event whose
    route isn't one the engine would actually take.

## The wiki's sound engine on entity pages

- **ONE PLAY BUTTON PER SEPARATELY-AUDIBLE THING** (maintainer 2026-08-06:
  "Why 3 play buttons and not 2?"). The **event's** ▶ is always there; a
  **layer's** ▶ only when the event has more than one sound (layered or in
  rotation); a **take's** ▶ only when its layer holds more than one recording.
  A lone recording's name and length sit on the layer's own line; which exact
  recording is bound (`take01` vs `cand07`) is Game-Master-only, as is the
  pipeline line ("assigned by the Game Master in the wiki", now `adminNote`).
  - `data-event` on each card is the stable hook for gates: the visible id
    pill is admin-only, so a check identifying cards by their first pill
    matched nothing in the player view and passed vacuously. Gate:
    `check-sfx.mjs` computes the expected button count from the DATA's own
    layer/take shape, so the rule holds for every card.
- **A creature's page shows what that creature sounds like** (maintainer
  2026-08-06: mapped sounds were invisible there, only new ones bindable).
  - **A three-part id whose middle segment is a real entity of that domain is
    SCOPED to that entity's page**, exactly like `player.jump@<uid>`. The
    entity assign card mints `<domain>.<entity id>.<action>` and the composer
    wires those verbatim (`monsters.forest_poring_2.walk` is Sprigling's
    footstep); routed generically they filed under "World", so a sound bound
    to a creature could never be found again. An id naming an entity that does
    not exist stays generic rather than scoping onto a page that isn't there.
  - **`sharedWith`**: `combat.monster_die` and both cross events fire off a
    monster's death but are not routed per creature, so every monster page
    shows them as full cards with the same per-recording unbind, marked
    **"every creature"** — ✕ there takes the sound off all of them. Chosen
    from the CALL SITES, not the names: `combat.hit_taken` (the player being
    hurt) and `combat.kick`/`punch` (his own swings) do not appear.
  - **The emitted-scan understands DYNAMIC names**: the game fires
    ``gameAudio.event(`monsters.${mv.kind}.${action}`)`` once per gait cycle,
    swing and growl, and a literal-only scan called every one of them "not
    fired yet". The static prefix before the first `${` is recorded as an
    emitted FAMILY (`isEmitted`); `check-sfx.mjs` fails on any unscoped
    `<domain>.<entity>.<action>`.
- **Unbind is PER RECORDING, not just per sound** (maintainer 2026-08-06: "I
  don't want to delete the sound, just unbind it"). Every take row in a
  multi-take layer carries its own `✕ unbind`, the layer row's button becomes
  `✕ unbind all`, and `bindingId(ev, layer, take)` keys those verdicts
  `<eventId>#<take file>` in the `bindings` feedback domain — still UNBIND,
  never delete. Only where there IS a choice (two ✕ for one action reads as
  two powers), and right-aligned by `margin-left:auto`, not a `.spacer`: at
  phone width the row wraps and a spacer strands the button on line 2, where
  it reads as belonging to the NEXT take.
- **One sound at a time**: `sfxEngine.stop()` runs BEFORE the fetch and bumps
  a generation counter, so a take whose decode is still in flight never starts
  playing after you have moved on.
- **Auditions try every format the take ships** (`audioCandidates`): ogg →
  m4a → wav, first one that decodes wins, and the picked url is what the play
  log records. The library asked for `.m4a` first and **Chromium ships no AAC
  decoder**, so every catalog sound failed to load while the composer's `.wav`
  sets played. Same order the game's own engine probes
  (`composer/engine/catalog.ts`).
- **Every take shows its length**, from the composer's `durations_s` or, for
  catalog takes, `wavDuration()` in build.mjs — a RIFF chunk walk (data bytes
  ÷ byteRate), zero dependencies because it runs in the Docker build too.
- **Three status chips, mutually exclusive by construction**: green **in
  game** (assigned AND fired by game code — what players hear), coral **no
  sound yet** (nothing assigned), red **not fired yet** (a sound is assigned
  but no game code triggers it). The gate asserts no card ever shows a
  contradictory pair. The engine's `bus` is plumbing and is no longer named in
  the UI — the layer pill reads `volume −26 dB` and explains itself on hover.
- **Events have a TYPE** (maintainer 2026-08-05): `scope` is either null
  (generic — listed under Sound Effects) or `{domain, id}` (entity-owned —
  listed on that entity's page). Jump and Fall are scoped per hero: the game
  routes the grunt by who you play, one voice each, never both at once. Entity
  pages render scoped events with `entitySoundsCard()` — the same cards,
  engine, stars and request form as the Sound Effects page — plus an "Assign a
  sound" card on every creature/hero/prop: pick one of the page's game ACTIONS
  (its animation states) and a sound; request id
  `<domain>.<id>.<action>/<stamp>`.
- **Players hear only what the game plays.** An event must have a sound AND be
  fired by game code (`emitted` — call sites scanned per LINE, because a
  whole-file comment strip once ate real code after an unmatched `/*`, and
  api.ts's doc header lists `audio.event("ui.confirm")` as an example).
  Engine-driven sounds with no `.event()` call — the ambience beds, the
  water-entry splash — are marked emitted by hand. **One sound is one sound**
  (maintainer 2026-08-05/06): the engine BINDS exactly what it plays
  (`foleyEntry`/`catalogStepEntry` slice steps, clicks and thunder to the
  approved primary take; only a jump VOICE really rotates) and
  `setLayer`/`catLayer` mirror that with `primary: true` — the layer's `takes`
  list IS the binding, pill "1 take". A set's other recordings are unbound:
  the admin's All sounds library only, plus a one-line admin note on the event
  (`spareTakes`). The old `round_robin:false` pin flag and the wiki's
  display-time slice workaround are both gone.
- The composer's foley takes are served at `/assets/composer/foley/…`
  (Dockerfile copies them; dev falls back to `games2/composer/foley`). The
  copy is the WHOLE folder, so `<set>/pool/` rides along — that is what makes
  the 91 alternatives audible in the deployed wiki, and why the foley layer is
  ~21 MB rather than ~13. `.dockerignore` has no composer rule; adding one
  there would silently 404 every alternative.

## Static Music and Dynamic Music — two tabs, one section

Maintainer 2026-08-23: *"I don't like 'Music bench' being it's own top section.
I feel this is more like 'tabs' under music. This is 'Dynamic Music' and what we
had before is 'Static Music'. Static Music should be preselected."*

His names and his order. **Static** is a finished track that plays start to end;
**Dynamic** is the suite/pool/phrase score, assembled while you play. They are
two kinds of the same thing, so they are two tabs of one section rather than
two entries in the nav.

`musicTab` is a module variable, not a stored preference: *preselected* is a
claim about **arriving**, so every fresh load opens on Static, while a tab
chosen mid-session survives the re-render a verdict causes. A player sees no tab
strip at all — there is nothing behind Dynamic for them — and `#/bench`, which
was a section for a day, still lands on the tab rather than dying.

The gate reloads before asserting the default. Changing the hash keeps the same
JS context, so without a reload the check would pass on a page that never opened
on Static.

**Both tabs lay out crumb → title → tabs.** Static rendered its own
`sectionHead` as its first child, so composing the strip in front of it put the
tabs *above the crumb* on Static and *below the title* on Dynamic (maintainer
2026-08-24). Both paths now compose the head themselves and hand `heading:
false` to the body. Gated by measured position rather than markup, including
that the strip does not shift when you switch.

## The Dynamic Music bench — auditioning the suite/pool/phrase score

Maintainer 2026-08-22, in full detail. A **suite** is one compatibility group:
everything in it shares key, tempo and phrase length, so any two pools can
switch on the beat or layer. Crossing **between** suites is deliberately
silence, never a musical transition. `#/bench`, admin only — it is a workbench.

### It shipped silent, and the gate was why

Maintainer 2026-08-22: *"I try to press on A but nothing happens … Can't get any
sound out from my speaker at all."* He was pressing the right button. The bench
could not have played a note.

Composer paths are published as `composer/music/…` and `stagingBase()` is the
**repo root**, so every one resolved to
`raw.githubusercontent/…/<sha>/composer/music/…` — **404**. The files are at
`…/<sha>/games2/composer/music/…` — **200**, `access-control-allow-origin: *`.
`composerRoot()` now appends `games2/`, which also fixes the composer's
situation beds on the Music page: same prefix, never playable either.

**The gate is the part worth remembering.** Its local override pointed at
`http://127.0.0.1:8903/games2/` — a base I chose *because it made the paths
resolve*. So it proved the audio decodes and proved nothing about where the
page looks. It uses the repo root now, exactly like production, and asserts on
the URLs actually fetched: every audio response `ok`, and every one under
`games2/composer/music/`.

**And a failure now says so.** A press shows `loading…` while it decodes — these
are 2 MB files off a CDN, so the first one has a real wait — and if it cannot
load, the reason appears under the transport (`HTTP 404`, a decode failure, the
filename). A silent button was the worst part of this: nothing on screen said
anything was wrong.

### Playback is booked, never triggered

*"Playback must be sample-accurate, or none of this works … Do NOT use `<audio>`
elements or call `play()` per phrase — that gaps and clicks at every join, and
I'd be judging the player instead of the music."*

One decode per take, cached; every phrase is a **slice** of that buffer handed
to the hardware clock as `src.start(when, offset, duration)`. The timer never
sounds anything — it only ever books the future. Measured by the gate:
consecutive phrases are booked with a **maximum gap of 0.000000 s**, and the
engine keeps **two in flight** (the one sounding and the next), because a
phrase here is 13–20 s and a 0.7 s look-ahead would race the decode of a
cross-take join.

Phrase N starts at `anchorS + N × phraseMs/1000` with **that take's own**
measured tempo — Boss Cathedral is 13.38 s on v02 and 13.65 s on v01. Nothing
schedules off the brief's number.

### The four switch modes, measured

| mode | measured |
| --- | --- |
| next beat | lands on a **whole** beat, booked with **0.000000 s** drift |
| next phrase | booked exactly at the end of the phrase sounding, **0.000000 s** |
| instant | 0.05 s from the press |
| suite cross | slider at 4 s → **4.6 s** = 0.6 s fade + 4 s silence |

**Two real bugs came out of measuring rather than reading.** Computing the beat
boundary and *then* awaiting a 2 MB decode in the same handler put the cut a
whole phrase late — "next beat" landed 62.7 beats out — because the scheduler
kept booking the old order while the await sat there; audio is warmed when a
bed is picked and again before the clock is read. And a cut left its stopped
source's recorded `end` untouched, so the scheduler believed two phrases were
still sounding and deferred the replacement.

### The layering slider had to say what it does

Maintainer 2026-08-22: *"I have no idea what the slider does."* It read
**"duck B −50%"** — a mixing-desk word, sitting on screen even with deck B
empty, next to nothing that explained it.

It now reads **"B plays 75% quieter under A"**, carries a line saying what it is
for (*"two beds at once — this is how far the second one sits under the first"*),
and when no second bed is loaded it says *"pick a bed on deck B to hear two at
once"* and steps back to 55% opacity instead of pretending to be live.

Gated on the gain, not the label: at the −75% default deck A is 1.000 and deck B
0.250; −100% silences B (0.001) and 0% matches A (1.000).

### The order is the instrument

What plays is a list of phrases, and a phrase may come from **any take** —
*"phrase 3 from v2 and phrase 5 from v4, since that's how I'd actually pick the
best ones"*. Reordering is **tap-to-pick, tap-to-place** as well as drag: this
is a phone-first page and HTML5 drag does not exist on touch. Shuffle, copy the
order as pasteable text, and reset sit on the panel title.

**The seam buttons live in the joins** of that order — 2 s of one phrase
straight into 2 s of the next, looped, so a join is judged in five seconds. A
join in the order *is* the pair, which is what makes "any two phrases" one tap.

### The numbers next to the buttons

`bars` (red when it is not a whole number — 6.70 means every join drops part of
a beat), the take's own bpm and phrase length, how many phrases are in the key
that was asked for, and **every phrase chip carrying its own measured key**,
tinted red when it is not that key. The live take is marked; so is one the
composer flagged unusable.

### Verdicts at three levels, without stopping the music

`live/feedback/composer-music.json`, `pixel-wiki-feedback@1`:

| level | id |
| --- | --- |
| track | `composer/music/<track_id>` |
| take | `composer/music/<track_id>__v03` |
| phrase | `composer/music/<track_id>__v03#5` (1-based, matching the screen) |

The verdict row repaints **itself** instead of re-routing — *"I must be able to
hit accept/reject without the music stopping, I need to judge in context"* —
and because the engine lives at module scope with no DOM in it, even committing
(which re-routes) leaves the audio running. Only navigating away silences it.
The phrase chip's "already judged" mark is re-stamped directly for the same
reason. Audition runs through the game's music bus at **−14 dB**; keys are
Swedish throughout, and B is H.

## Music comes from TWO places

The Music page listed only `music/` — the music agent's domain — so the five
situation beds the composer generated on 2026-08-05 were invisible
(maintainer 2026-08-06: "he did 5 new songs and you are listing nothing but
the old 2"). `buildComposerMusic()` now also reads
`games2/composer/music/tracks.json` (`composer-music@1`) and appends those
tracks with `source: "composer"`, their measured length/tempo/key/loop points
and their section names.

- **Existing is not routed.** A bed's `routed` flag says whether the GAME can
  currently reach it: `title` and `night` play today, the five context beds
  are generated but dormant (games2/CLAUDE.md — the maintainer picks what
  plays where before it is wired), so they chip "not routed yet" rather than
  implying the game uses them. `BED_ROLE` in build.mjs holds the one-line
  "when would this play", and a bed with no entry still LISTS — it just warns
  through the same drift sentinel the sfx table uses.
- **Their feedback belongs to the composer**, not the music agent:
  stars/verdicts on a bed go to `feedback/composer.json`, next to its foley.
- Served at `/assets/composer/music/…` — the same two mounts as foley (image
  copy + repo fallback), and the Dockerfile copies the folder. That is a
  deliberate ~18 MB second copy: the client bundles its own for the in-world
  score, but the wiki cannot reach those hashed bundle URLs, and a page that
  lists five tracks it cannot play is worse than the bytes.
- `playTake` prefers **ogg → m4a → mp3 → wav** (it asked for m4a first, which
  headless Chromium cannot decode at all) — the same order as the WebAudio
  auditions, so the page and the sound engine agree on formats.
