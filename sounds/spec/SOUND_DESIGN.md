# Sound design bible — how our audio should FEEL

Bitrate and format are solved and irrelevant to quality. This doc is the hard
part: how to make audio that feels *good, realistic, welcoming, mystical*,
doesn't repeat, sits right against music, and covers what the game needs. It
is the north star for prompts (`config/sounds.json → ai_prompt` +
`prompt_directives`), for the `mix`/`variation` metadata the game consumes,
and for the catalog roadmap.

## 1. The anatomy of a satisfying one-shot

Feel lives in the **envelope and layering**, not the timbre.
- **Transient → body → tail.** Fast punchy attack (definition) + short body
  (weight) + clean tail (space). Pros stack 3–4 layers into one "sound"
  (coin = metallic ting + pitched-up reward + sparkle tail).
- **Pitch direction = emotion.** Up = reward/positive; down = loss/negative.
- **Harmony = valence.** Consonant intervals (P5, M3) for good events;
  dissonance for bad; suspended/unresolved for mystery.
- **Sub-bass on impacts** makes them *felt* — keep a little low-end thump on
  hits/booms.

## 2. Realism = imperfection + physics + space (keep clips DRY)

- Never identical twice; material resonance; real dynamics.
- **Ship clips dry and close-miked.** The *room* is applied at runtime
  (reverb zones per map region: cave = long tail, field = dry + air, hall =
  medium). Do NOT bake environment reverb into a one-shot — it can't be
  un-baked.
- Realistic events are **layered**: axe = swing-whoosh + wood-thock +
  splinter + tail.
- Runtime (game) owns: distance attenuation, low-pass **occlusion** behind
  walls, subtle doppler on fast movers.

## 3–4. Emotional palettes

**Welcoming** (town, home, friendly NPC): low-mid warmth, soft slow attacks,
major consonant harmony, organic timbres (wood, harp, warm strings, soft
bells), gentle room, highs gently rolled off. The biggest lever is
**ambience** (birds, hearth crackle, distant chatter) — a safe soundscape
disarms the player. Human/natural = safe; metallic/dissonant = threat.

**Mystical** (magic, ancient, otherworldly): the **uncanny** — non-natural or
naturally-processed-unfamiliar. Reverse-reverb swells, long shimmer tails,
detuned beating tones, crystal/glass/bell cores, breathy choral pads,
non-Western scales (whole-tone, Lydian), unresolved suspensions, glissandi.
Awe = organ + restraint + silence (Interstellar). Magic should bloom, not
zap.

## 5. Anti-repetition (footstep, attack, hit, got-hit)

The ear catches exact repeats instantly. Defence, most-effective first:
1. **Variants + no-immediate-repeat round-robin** — 4–6 samples/surface;
   never the same twice in a row.
2. **Pitch jitter ±1–2 semitones** per play (cheapest, biggest win).
3. **Gain jitter ±2–4 dB.**
4. **Timing/start-offset jitter**; alternate L/R foot with different samples.
5. **Layer randomization** — randomize base + detail layers independently
   (3×3 = 9 from 6 files).

Target: variants × jitter ≥ ~20 perceptually distinct results before a loop
is heard. This is a **playback contract**: the sounds domain ships variants
and declares per-sound jitter ranges in `variation`; the game implements
round-robin + jitter. (Note: the composer deliberately scales these ranges
down at playback — its GENTLENESS doctrine, `games2/composer/README.md` —
the ranges here are the producer's recommendation, not the final mix.)

## 6. Mix hierarchy (SFX vs music) — integrated loudness targets

| Bus        | Target LUFS | Notes |
|------------|-------------|-------|
| Dialogue   | −12         | King. Everything ducks under it. |
| UI         | −12         | Crisp, present, always audible. |
| Gameplay SFX | −12 to −16 | Above the music bed so feedback reads. |
| Music bed  | −18 to −22  | Sits UNDER; the emotional wash. |
| Ambience   | −26 to −30  | Subliminal. |

- **Side-chain ducking**: on a big SFX/stinger, dip music 3–6 dB for
  ~300 ms so the moment punches through.
- **EQ separation**: keep SFX bright at 2–5 kHz where the orchestra is thin;
  keep music warmth in the low-mids — never two elements fighting one band.
- Master ~−1 dBFS peak with headroom; don't slam to 0. One-shots normalize
  to −1 dBFS; *mix balance* is the per-category `mix.gain_db` the game
  applies on top (a coin should not be as loud as an explosion).
- (The composer sets the final bus levels by ear on top of these targets —
  its numbers are the shipped truth.)

## 7. Music direction

Music is its own domain now — `music/` (see its README for the standard).
The briefing principles that seeded it still apply to any brief:
**leitmotif** (one memorable theme per place/idea, recurring + transformed);
**restraint + texture** (minimal motifs that grow by addition; timbre that
evokes place — organ=cosmos, choir=sacred, low brass=dread, solo
woodwind=home; use silence); **adaptive structure** (vertical intensity
layers, horizontal transitions on gameplay events, short stingers).

## 8. Catalog roadmap

Tracked in `config/sounds.json → roadmap` — the backlog to promote into
`catalog`; the loop only generates what's in `catalog`. Priority order (item
1, the ambience loops — birds_day, crickets_night, wind, rain, ocean_waves,
river, fire_crackle, cave_drips, town_murmur, forest — has SHIPPED as the
`ambience` category):
1. ~~Ambience loops~~ (shipped).
2. **Footstep/attack/hit variants ×4–6** + surfaces: dirt, sand, snow, mud,
   water.
3. **Combat depth**: hit_flesh/armor/wood/stone, block, parry, crit,
   bow_shoot, arrow_impact, dodge, enemy_alert, enemy_attack_tell, death
   variants.
4. **Dialogue blip** (per-character text tick — outsized personality payoff).
5. **Stingers**: discovery, danger, boss_appear, victory, game_over.
6. **Farming/tools**: fishing_cast/reel/nibble/catch, harvest, crop_ready,
   tree_fall, craft, forge.
7. **World**: door_wood/metal open/close, teleport, sleep, wake,
   rooster_dawn, thunder, save_chime.

## How this maps to files

- Each sound's `ai_prompt` is written to hit a **feel** (the `feel` field),
  using the palettes above — material + intensity + emotional intent.
- `variation` per sound tells the game how many variants exist and the
  jitter ranges.
- `mix.gain_db` per category sets the balance one-shot normalization can't.
