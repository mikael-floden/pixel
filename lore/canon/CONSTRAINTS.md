# Constraints — what the lore is not allowed to contradict

The red line is free. This file is not. Everything here is a fact about the
**repository as it actually is**, verified on 2026-09-12 (lore-assistant, the
day the canon was re-read against `the_game`), and the lore must bend around
it rather than the other way round.

Re-verify this file at the start of every lore run. Other agents change their
domains without telling anyone, and that is by design. (The previous
verification was 2026-07-31; in the six weeks between, the world was replaced
wholesale, combat and death shipped, and the soulstone count went 28 → 71.)

---

## The doctrine of loss

Read this first; it is why the lore does not break.

Other agents delete, rename and regenerate their entities continuously. In one
day the drop table went 225 → 221 → 108 rows; all 24 monster names were
re-authored at once; the world map was rewritten from scratch four times; on
2026-09-09 the entire world the chapters were written on (`the_island2`) was
deleted and `the_game` took its place. A lore layer written the ordinary way —
where each entity's story assumes the other entities keep existing — would be
broken within hours and would stay broken.

So the fiction was built to metabolise this. **Law IV (the Drift) makes churn
canon**: Nangijala re-remembers itself, and things going missing is the world's
native process, not an error in it. Practically:

| When this happens in the repo | The canonical reading | What the lore agent does |
|---|---|---|
| An entity is deleted | It went **Quiet** — nothing left holding its shape | Delete its entity file. Do **not** memorialise it in a chapter; the world does not keep records of what it lost, that is the whole point |
| An entity is renamed | Names **drift**; it is the same thing, re-told | Keep the file (ids are stable), refresh the name, leave the story |
| An entity appears | It **fell**, or was remembered hard enough to be | Write it in as new, no back-fill of history required |
| The world map is regenerated | A **Turn** | Nothing to fix — geography is described by relation only, never coordinate |
| The whole world is replaced (`the_island2` → `the_game`, 2026-09-09) | The biggest Turn there is | Re-verify §5. Chapters written by relation survived it; every compass word did not (paid for 2026-09-12 — see §5) |
| An entity's art changes | It was **misremembered**, and now it isn't | Re-read the sprite, rewrite to match. Art always wins |
| A whole mechanic lands (combat, death, shops) | The age moves | Chapters may need a pass; the five laws should not (combat and death landed; the laws held) |

**The rule that follows:** every piece of lore must survive the deletion of any
single entity it references. Chapters must never depend on one monster, one
item or one place existing. Entity files may reference each other freely — they
are cheap and disposable. Chapters are load-bearing and must stay general.

**Never write a chapter around a specific monster id.** Write it around a law,
and let the monster file reference the chapter. The same holds for a specific
*prop*: `the_age_of_coming` was written around a lighthouse, a windmill, an
aqueduct and a statue in the ice, none of which `the_game` places — a chapter
that names the furniture inherits the furniture's lifespan.

---

## 1. Naming and identity

- **Folder ids are the canon keys and never change.** `monsters/config/roster.json`
  states ids "keep the original prompt wording and never change"; the great
  rename of 2026-07-30 explicitly left every folder id intact because they are
  game keys and map spawn-zone keys. **All lore is keyed on folder id, never on
  display name.**
- **Display names are ≤12 characters** for monsters and items (measured: both
  rosters max out at exactly 12), and describe the art rather than the prompt.
  They have been rewritten wholesale at least once. Re-read
  `monsters/config/roster.json` and `items/config/roster.json` before quoting
  any name in prose; `build.py` reports the drift.
- **All 71 soulstones display as the single shared name "Soulstone"**
  (`items/config/types.json:shared_name`, enforced by sync). Never give an
  individual soulstone a proper name in player-facing prose.
- **NPCs are keyed by 8-hex folder id** (`characters2/npcs/<id>/`, display
  names in `characters2/metadata.json`, which is what `build.py` reads).
  maps2's `npcs.json` denormalises the display name and asserts it equal at
  build, so a rename fails loudly upstream before it can rot here.
- Never derive identity from any `prompt` field. They are generation prompts,
  they are frequently wrong, and one hero's `prompt` currently contains the
  *other* hero's text. `character.json:name` is PixelLab junk.

## 2. What is true in the game today (2026-09-12)

Shipped and canon — the lore must agree with these:

- **ONE world: `the_game`** (`maps2/worlds3/the_game/`, format
  `pixel-maps3/world@1`, 394×394 cells, a ground NAME per cell from
  `tiles/ground_types.json`). `the_island2`, the demos and `tiles2/` were
  deleted 2026-09-09 (maintainer: "we will never go back"); history in git.
  It is still an island in a sea — deep water rings it and is drawn as nothing
  on the minimap.
- **The Waking is where the game says it is.** The spawn cell is grass at
  level 0, and **the client itself draws the campfire on it** (`WorldScene`:
  the spawn campfire, an animated world object with its own fire light) — the
  fire is the game's, not a placed piece, and nothing else in the world is a
  fire anybody keeps (the world places braziers, torch posts, lantern posts and
  lit streetlamps as *lights*, and one hearth inside a house in the far
  settlement). **Dying returns you to it**: `revivePlayer` places the body at
  the spawn with full hp — the game's own statement of "what is left re-forms
  beside the nearest tended fire". The hours are prose; the game takes
  seconds. Never quote a duration.
- **The little stone house is there**: a one-room house (13 floor cells,
  parquet, a table and a wall hanging inside, windows on the walls) stands five
  cells from the fire, unnamed in maps2's data. An armourer (Thorne) stands at
  its door with wares he cannot sell (§3).
- **The meadow is a village green now.** Within twenty cells of the fire the
  world places two chess tables (Rannulf sits at one — the game's chess),
  lit streetlamps, a market stall, a maypole, a cart, waystones, a signpost, a
  scarecrow, a haystack and a beehive, and a second, bigger house across the
  grass — a hall with beds and barrels and two rooms with beds, cupboards,
  rugs and benches — with four people at its door. Eleven NPCs stand on the
  green. The chapters say the fires are down to a handful; they do not say the
  meadow is empty, and it is not. (`the_long_table` says the second house has
  four rooms and a hall and thirty chairs; the world's has a hall and two
  rooms and beds. Counts are as unstable as coordinates — §5.)
- **Nine named places, all caves**, `places.json` (`pixel-maps2/places@2`):
  `the_cave` "The Cave" (one mouth, 598 cells, floor at 0) plus Cave II–IV and
  Pit I–V — placeholder names that maps2's spec explicitly hands to lore to
  rewrite (§7). No house, summit or road is a named place yet. **The Cave is
  the hole under the mountain**: its mouth opens on the massif's face nearest
  the meadow and the four Hollowed kinds hold its floor and the lesser caves.
- **ONE mountain, and it is north of the meadow** (up-screen; §5 for what
  that did to the prose). Snow and ice on the cap (levels run to 46), black
  rock and lava ledges, grey-stone flanks, the caves in it and under it, the
  bog and the frogs at its foot. Beyond it, a second settlement on grey paving
  (a well, a fountain, a statue, a sundial, a letter box, two market stalls, ten
  NPCs) — unnamed, and nobody's in canon yet. Beach and sea lie the other way
  from the meadow.
- **Two in-world sentences ship today.** *"Northern lights dance over
  Nangijala."* and, on every arrival, *"<name> has arrived in Nangijala — a
  star crosses the sky."* The arrival line and the shooting star it announces
  are DISOWNED (maintainer 2026-08-01: added without permission, to be
  removed) — still shipped, still NOT canon. No lore may reference stars or
  falling-star arrival. Canon arrival is **the Waking**.
- **The world is shared and multiplayer**; server owns time and weather, so
  everyone sees the same sky. **Time has exactly four phases** — Night,
  Morning, Day, Evening. **Weather is a closed set of nine** — Clear sky,
  Cloudy at times, Mist, Drizzle, Rain, Heavy rain, Storm, Snowing, Windy. Lore
  may not invent a tenth.
- **Water is the player's sanctuary** (games2 law): no monster enters, swims
  or strikes there. Usable in prose as a fact people know.
- **"Wanderer" is the built-in fallback** for a nameless player and the
  art-free placeholder — not a title the fiction gives anybody.
- **Two playable heroes**, both human: `default_boy` ("Man") and `default_girl`
  ("Woman"). No classes, no factions. Their animation set — sword, bow, wand,
  channel, punch, kick, hurt, die — is the strongest existing statement of what
  a hero can do; in the shipped fight the swings are punch and kick.
- **193 NPCs exist and 33 STAND IN THE WORLD** (`npcs.json`, `AMBIENT` or
  `MERCHANT` with wares tags; 23 on the green, the roads and the cave field,
  10 in the far settlement). They are client-side decor: they never move,
  never speak, sell nothing. Of the living cast, placed today: Wendell (on the
  green, by the fire), Sigrun (twice — by the hall and at the market stall,
  maps2's to fix), Hearn (on the road below the cave mouth), Gunnar (the field
  over Pit III). NOT placed: Solveig, Bettany, Osric, Jehanne (asked of maps2
  2026-09-12). Write them as people of Nangijala, never as quest-givers.
- **57 monsters on the roster, every one placed** (87 spawn zones; maps2
  asserts the world holds the whole roster). **39 more are coming**: the
  maintainer approved 39 candidates in the wiki, their idle and attack clips
  are done (`monsters/candidates/<id>/`), and `live/tuning/monsters.json`
  already carries all 96 keys with empty loot tables for the new ones. They
  are NOT on `monsters/config/roster.json` yet, so no lore record can exist
  for them (the build would call it GONE). The day they land is a 39-record
  unit — the lore agent and the assistant split it by id.
- **The scenery domain is 709 pieces** (`scenery/<group>/<id>/scenery.json`,
  types TOWN / TREE / NATURE / MOUNTAIN_WALL / INDOOR / WINDOW / OTHER);
  `the_game` places 1,387 of 192 distinct pieces. Lore's key stays
  **`objects`** (ids are URLs), 3/709 covered.
- **Game art is lossless WebP**, sprites packed per state; nothing here
  depends on it beyond "look at the sprite before writing".

## 3. What is shipped, and what is not

Shipped 2026-09-12 — may be described as things a player does, in the
world's own words (release, crack, break the shape, go down, re-form):

> combat (tap a creature; unarmed swings; damage numbers) · creatures that
> roam, chase, fight and go down · hp · xp and levelling ("Thunderclap") · loot
> on the corpse sweep (junk and soulstones, per the live loot tables) · a
> private backpack · death (a ten-second fade, a press, the revive at the
> meadow fire) · fall damage · swimming · chess at the two boards on the green

NOT shipped — lore may be written *for* these, never as something a player
currently does:

> gold (items carry a `value`; nothing spends it — the counter is zero) ·
> shops (merchants carry wares tags and sell nothing) · equipment (the SWORD /
> BOW / WAND / ARMOR types exist in `types.json` with zero items) ·
> consumables · crafting · quests · dialogue · signs · NPCs that move or speak

Loot tables are consumed now — the corpse sweep rolls them — so a monster's
leavings are real game content; junk records may say what the creature drops.
The chapters describe the world, not the player's verbs, and are written to
stay true as the list above moves.

## 4. Economy invariants (enforced by code — breaking these fails a build)

- **Soulstone ↔ monster is strictly one-to-one, both directions**, enforced by
  `items/pipeline/drops.py` against **`live/tuning/monsters.json`** — the
  mapping lives THERE (maintainer-edited from the wiki's monster page; `items/`
  keeps no copy). 2026-09-12: 71 stones, 57 bound, **14 unbound** —
  blue_white_star_stone, bright_green_plate_stone, brown_woodgrain_stone,
  crimson_spiral_stone, dark_teal_plate_stone, deep_red_crack_stone,
  opal_bubble_stone, orange_lightning_stone, pale_green_core_stone,
  pale_moss_plate_stone, purple_gold_vein_stone, violet_knot_stone,
  white_gold_branch_stone, white_rune_frost_stone. Their records are written
  AS unbound (a stone in circulation with nothing behind it); binding one to a
  new creature answers the question without contradicting the text. Law V is
  written to make the one-to-one necessary rather than arbitrary. **The count
  is a measurement, not a law**: the items assistant claimed binding the 14
  to the 39 pending creatures the same day — run `python3
  items/pipeline/drops.py` for today's number, and rewrite a stone's record
  the day it binds (the items board says which).
- **31 junk items wait for the creature they were drawn for** (`waiting_for`
  in the live file: birds, insects, a spider, a bat, a scaled swimmer, a tribe
  that wears its kills, someone who smelts and hauls). The 39 candidates
  include a vulture, an eye bat, a spider queen, a cobra, an octopus, a glow
  grub — many of these will bind. Lore may hint; it must not assert.
- A junk item binds to a monster only when it is that creature's **body, kit
  or material** — never by rhyme or vibe.
- **Rarity ladder is five ranks** (common, uncommon, rare, epic, legendary);
  four are in use, **no legendary item exists yet**.

## 5. The world's physical bounds

- **THE COMPASS IS RETIRED (2026-09-12).** The game's north is up-screen
  (`vectorToDirection`: 90° is "north"; screen = ((x−y)·32, (x+y)·14)). On
  `the_island2` the cave lay east of the meadow and the chapters said so —
  "the eastern mountain", "the east road", "do not go east". On `the_game`
  the massif and the cave mouth are due north of the meadow and east is the
  sea, so every one of those lines pointed players the wrong way. All shipped
  text now names places by relation — **the mountain, under the mountain, the
  mountain road, the mountain circuit / line, across the grass, the far
  fires** — and no compass word may enter shipped text again (`GLOSSARY.md`
  "Words we do NOT use"). The build does not check this; you do.
- **One massif, north of the meadow**, the only high ground; snow and ice on
  top, black rock and lava on its ledges, grey stone below, and every cave in
  or under it. The Cave's single mouth opens on its near face. The second
  settlement is beyond it; the beaches and the sea are on the meadow's other
  sides.
- **The old generator's names died with `the_island2`**: the Trollstigen,
  Sunken Hollow, West Plateau, Mirror Lake, the lagoons, the tarn, the gorge
  and its four crossings are NOT in `the_game`'s data (`world3grow.py` keeps
  one comment about the Trollstigen switchbacks; that is a memory, not a
  place). None of them may be used as if they were places. The roadmap's
  "chapter set two" (the Trollstigen, the gorge crossings) is a maps2 request
  first, prose second.
- **Named places today are the nine caves** (§2), placeholder-named, and
  **lore owns the display names** (`maps2/spec/PLACES.md`: "may be rewritten
  — lore owns the vocabulary; never bind to it"). Rename by a request to
  maps2 with the id and the new name; never by editing `places.json` (§7).
  The `id` is the engine's and never moves.
- **Habitats are data and they win.** `spawns.json` places every creature
  (87 zones, elevation-banded), placement is measured against habitat
  capacity, not taste; when a creature moves, the lore follows it onto the new
  ground. `the_game` must hold every roster monster (maps2 build-asserted).
- **Counts are as unstable as coordinates.** Nine caves today, one mouth on
  The Cave and two on Cave III, thirteen rooms, two settlements, thirty-three
  people standing. Never write "the only" or "the one" about a map feature
  without checking the data, and prefer phrasing that survives the number
  changing.
- **Fifteen ground types** (`tiles/ground_types.json`): black_rock,
  brown_paving_stone, dark_mud, deep_water, grass, grey_paving_stone,
  grey_stone, ice, lava, light_beach, light_soil, parquet_floor, slime, snow,
  water. So: paved ground exists (grey in the far settlement, brown on the
  green), interior floors exist (parquet, in every house), lava and mud and
  slime exist as ground. There is still **no wood, no brick, no farmland, no
  jungle** as ground; haystacks, a scarecrow and a beehive say farming happens
  without a field to show for it. Lore requiring new terrain is a tiles
  request first, prose second.
- **The placed set dressing is the real visual canon**, and it changed: what
  `the_game` places is trees, stones, braziers, lilies and reeds, mushrooms,
  crystals, lit streetlamps, waystones, cairns, wayside shrines, cauldron
  camps, soulstone outcrops on the massif, one standing stone (far north), one
  shipwreck's prow on the near beach, one dragon's ribcage at the mountain's
  foot, one beacon on the shore below the meadow, and in the far settlement a
  statue, a sundial, a letter box and a fountain. **Not placed anywhere**:
  aqueducts, triumphal arches, windmills, telegraph poles, lighthouses,
  turrets, obelisks, the statue in the ice. The Age of Coming's thesis (every
  era's dead are here at once) still shows — a letter box and streetlamps
  beside cauldron camps and a standing stone — but its three portraits stand
  on furniture that has gone soft.

## 6. Text-rendering constraints (the wiki)

- **In-text links are DATA, authored as `[[domain/id|Shown]]`.** The build
  parses the mention syntax into segment arrays ({t} / {t, ref:{domain,id}});
  the wiki renders segments as text nodes + links. Raw `[[ ]]` never ships,
  and any other markup still renders as literal characters.
- **Two different texts per entity, and they must not be confused.**
  - `description` — the short line under the entity's name at the top of its
    page. Always visible, so it is a **layout budget**, not a style preference.
  - `lore` — the long read-more text, an array of paragraphs, shown only if the
    reader expands it. Hard cap 425 words (build-enforced), typical ~200.
- **`loreSlot()` reserves the height of the longest description in a domain**,
  so one long entry makes *every* page in that domain taller. Since our
  `description` **replaces** the domain's own, the rule that makes this
  provably safe is: **never exceed the longest description that domain already
  ships.** `build.py` measures that per domain from the live repo and refuses
  to write when it is exceeded — so the cap stays correct when other agents
  rewrite their copy. Budgets measured 2026-09-12: monsters 118, items 123,
  characters 161, objects 845, tiles 51 (grounds carry no prose; the fallback
  stands). Chapter summaries ≤200.
- **`wiki/site/data.json` is fully public and served statically.** Admin gating
  is client-side rendering only. **Nothing in `lore.json` is secret.** The red
  line and `revelations.json` are deliberately kept out of it — not because
  that hides them (the repo is public), but because they should not ship to
  players as content.

## 7. Ownership

Per `coordination/PROTOCOL.md`, one writer per file AT A TIME. **Two agents
write `lore/`** since 2026-09-12 — the lore agent and lore-assistant — each
only its own board file outside it. The procedure is PROTOCOL's "Two writers
per directory": claim the files on your board before editing, rebase before
every push, run `build.py` again on the rebased tree, and rebuild `lore.json`
from the filesystem — never merge it hunk by hunk.

We do **not** edit `monsters/config/roster.json`, `items/config/roster.json`,
`characters2/metadata.json`, `maps2/worlds3/the_game/places.json`,
`wiki/**` or `live/**`, even though those are where per-entity text and place
names live today. Instead `lore/lore.json` publishes the text and the wiki
picks it up, and a place name goes to maps2 as a request.

**Precedence: lore wins** (maintainer, 2026-07-31). Where this domain publishes
a `description` for an entity, it **replaces** the owning domain's — the lore
agent has full control over text. Where it does not, the domain's own text
stands, so partial coverage degrades gracefully and nothing ever goes blank.

That control is a responsibility, not a licence: a replacement must be at least
as good as what it replaces, must match the art, and must fit the layout budget
above. We still never *write* another domain's files — the substitution happens
at the wiki's read, so any agent can always see and keep its own copy.

## 8. The revelation protocol (v2)

`lore/revelations.json` is the GM's map of the red line: every beat of the
root story with status `hidden | hinted | revealed` and pointers to the texts
that do the telling. The build enforces honesty — a hinted/revealed beat must
cite published text, a hidden beat must cite nothing, and `lore.json` ships
**counts only** (no titles, no truths). The wiki's Game Master view fetches
the file directly, like `RED_LINE.md`.

Writing rule: check the beats before writing anything. Advancing a beat is a
deliberate act — never a side effect of a nice sentence.
