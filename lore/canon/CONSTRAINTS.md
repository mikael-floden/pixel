# Constraints — what the lore is not allowed to contradict

The red line is free. This file is not. Everything here is a fact about the
**repository as it actually is**, verified on 2026-07-31, and the lore must bend
around it rather than the other way round.

Re-verify this file at the start of every lore run. Other agents change their
domains without telling anyone, and that is by design.

---

## The doctrine of loss

Read this first; it is why the lore does not break.

Other agents delete, rename and regenerate their entities continuously. In one
day the drop table went 225 → 221 → 108 rows; all 24 monster names were
re-authored at once; the world map was rewritten from scratch four times. A
lore layer written the ordinary way — where each entity's story assumes the
other entities keep existing — would be broken within hours and would stay
broken.

So the fiction was built to metabolise this. **Law IV (the Drift) makes churn
canon**: Nangijala re-remembers itself, and things going missing is the world's
native process, not an error in it. Practically:

| When this happens in the repo | The canonical reading | What the lore agent does |
|---|---|---|
| An entity is deleted | It went **Quiet** — nothing left holding its shape | Delete its entity file. Do **not** memorialise it in a chapter; the world does not keep records of what it lost, that is the whole point |
| An entity is renamed | Names **drift**; it is the same thing, re-told | Keep the file (ids are stable), refresh the name, leave the story |
| An entity appears | It **fell**, or was remembered hard enough to be | Write it in as new, no back-fill of history required |
| The world map is regenerated | A **Turn** | Nothing to fix — §11 of the red line describes geography by relation only, never coordinate |
| An entity's art changes | It was **misremembered**, and now it isn't | Re-read the sprite, rewrite to match. Art always wins |
| A whole mechanic lands (combat, death, shops) | The age moves | Chapters may need a pass; the five laws should not |

**The rule that follows:** every piece of lore must survive the deletion of any
single entity it references. Chapters must never depend on one monster, one
item or one place existing. Entity files may reference each other freely — they
are cheap and disposable. Chapters are load-bearing and must stay general.

**Never write a chapter around a specific monster id.** Write it around a law,
and let the monster file reference the chapter.

---

## 1. Naming and identity

- **Folder ids are the canon keys and never change.** `monsters/config/roster.json`
  states ids "keep the original prompt wording and never change"; the great
  rename of 2026-07-30 explicitly left every folder id intact because they are
  game keys and map spawn-zone keys. **All lore is keyed on folder id, never on
  display name.**
- **Display names are ≤12 characters** for monsters, short for items, and
  describe the art rather than the prompt. They have been rewritten wholesale
  at least once. Re-read `monsters/config/roster.json` and
  `items/config/roster.json` before quoting any name in prose.
- **All 28 soulstones display as the single shared name "Soulstone"**
  (`items/config/types.json:shared_name`, enforced by sync). Never give an
  individual soulstone a proper name in player-facing prose.
- Never derive identity from any `prompt` field. They are generation prompts,
  they are frequently wrong, and one hero's `prompt` currently contains the
  *other* hero's text. `character.json:name` is PixelLab junk.

## 2. What is true in the game today

Shipped and canon — the lore must agree with these:

- **Arrival broadcasts a shooting star** to every client
  (`games2/server/src/rooms/WorldRoom.ts:502`). Wild unnamed stars fall during
  night. Verified in code.
- **A campfire burns at the spawn point** (`games2/client/src/scenes/WorldScene.ts:107`,
  `648`). It is the only hand-made object the game draws. Verified in code.
- **A one-room stone house stands on the meadow**, black roof, one door; the
  player spawns three cells in front of it. It is unnamed.
- **The aurora is a world event**, announced in-world as *"Northern lights dance
  over Nangijala."* This is the only in-world sentence a player currently reads.
- **The world is shared and multiplayer**; server owns time and weather, so
  everyone sees the same sky.
- **Time has exactly four phases** — Night, Morning, Day, Evening.
- **Weather is a closed set of nine** — Clear sky, Cloudy at times, Mist,
  Drizzle, Rain, Heavy rain, Storm, Snowing, Windy. Lore may not invent a tenth.
- **The player's default name is "Wanderer."**
- **Two playable heroes**, both human: `default_boy` ("Man") and `default_girl`
  ("Woman"). No classes, no factions. Their animation set — sword, bow, wand,
  channel, punch, kick, hurt, die — is the strongest existing statement of what
  a hero can do.

## 3. What is NOT in the game today

Lore may be written *for* these, but must never describe them as something a
player currently does:

> combat · damage · player death · HP loss · corpses · inventory · equipment ·
> gold (the counter is hardcoded to zero) · XP gain · levelling · shops ·
> merchants · crafting · quests · NPCs · dialogue · signs

Loot tables exist as data and **nothing consumes them**. The chapters are
written to be true now and still true after combat lands — they describe the
world, not the player's verbs.

## 4. Economy invariants (enforced by code — breaking these fails a build)

- **Soulstone ↔ monster is strictly one-to-one, both directions.** 24 monsters,
  24 bound stones, 4 spare. `items/pipeline/drops.py` *fails* on violation.
  Law V is written to make this necessary rather than arbitrary.
- The **four unbound soulstones** are waiting for creatures that do not exist
  yet: another ice creature, something misty, a treasure/greed creature, a fire
  boss. Lore may hint at these; it must not assert they exist.
- A junk item binds to a monster only when it is that creature's **body, kit or
  material** — never by rhyme or vibe.
- **Rarity ladder is five ranks**; no legendary item exists yet.

## 5. The world's physical bounds

- **Eight ground materials only**: saturated grass, snow, dirt, grey mountain
  stone, black volcanic rock, clear water, light sand, crystal ice. There is
  **no wood, no brick, no paved road, no lava terrain, no swamp, no jungle, no
  farmland, no interior floor.** Buildings are made of ground materials. Lore
  requiring new terrain is a tiles2 request first, prose second.
- **The mountain is north/up-screen; meadows and maze are south/near; beaches
  exist on the near shore only**; ocean rings everything.
- The named features that exist in the map generator — the **Trollstigen**, the
  **cave**, the **gorge**, **Sunken Hollow**, **West Plateau**, **Mirror Lake
  basin**, the **lagoons** and **tarn** — are code constants, not data. Their
  *names* have persisted; their *coordinates* have not. Use the names, never
  the positions.
- The props already drawable are the real visual canon and they say the world
  is **inhabited-then-abandoned**: aqueducts, triumphal arches, castle turrets,
  obelisks, standing stones, shrines, wells, windmills, telegraph poles,
  lighthouses, wrecked ships, a statue encased in ice, a creature frozen in ice.
  The Age of Coming (red line §4) exists to explain exactly this.

## 6. Text-rendering constraints (the wiki)

- **All wiki text renders as plain text nodes.** No markdown, no HTML, no
  wiki-link syntax — any markup ships as literal characters. Cross-references
  must be **data** (`{domain, id}` pairs), never inline syntax.
- **`loreSlot()` reserves the height of the longest blurb in a domain**, so one
  long entry inflates every page in that domain. House limit: **entity blurbs
  ≤200 characters, target 95–140.** Chapter summaries ≤200.
- **`wiki/site/data.json` is fully public and served statically.** Admin gating
  is client-side rendering only. **Nothing in `lore.json` is secret.** The red
  line is deliberately kept out of it — not because that hides it (the repo is
  public), but because it should not ship to players as content.

## 7. Ownership

Per `coordination/PROTOCOL.md`, one writer per file. The lore agent writes
**only** `lore/**` and `coordination/lore.json`.

We do **not** edit `monsters/config/roster.json`, `items/config/roster.json`,
`characters2/metadata.json`, `wiki/**` or `live/**`, even though those are where
per-entity text lives today. Instead `lore/lore.json` publishes the text and the
owning agent or the wiki picks it up. Precedence is theirs to choose; we propose
**domain-authored wins, lore fills gaps** so no agent's work is ever overwritten
by ours.
