"""Composer foley pipeline — the composer's OWN generated audio.

Charter (maintainer 2026-07-18): the composer has the SAME generation rights
as the sound/music agents (ELEVENLABS_API_KEY). When the producers' catalog
falls short in-game, the composer regenerates the assets itself inside its
own domain (sounds/foley/). Targets so far, both after maintainer
in-game QA: FOOTSTEPS (grass/sand/snow bad, stone/ice okeyish) and the UI
BUTTONS ("sound like a piano and not like buttons" — the ui_* sets are
tactile mechanical clicks by construction).

One run generates every requested set's takes, masters them (tight trim,
de-click fades, -1 dBFS peak — same recipe as the sound domain), and writes
`foley/foley.json`. The client bundles the WAVs via Vite import.meta.glob
(engine/foley.ts) — no server/asset-route changes needed.

Requires ELEVENLABS_API_KEY (Actions secret or local env). Self-contained on
purpose: domains keep their own pipeline copies (repo convention).

    python sounds/pipeline/foley/generate.py              # all sets
    python sounds/pipeline/foley/generate.py grass ui_tick # a subset
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import time
import wave
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

# sounds/pipeline/foley/ -> sounds/foley/. The GENERATOR lives under
# sounds/pipeline/ so it inherits publish.json's "^[^/]+/pipeline/" image
# exclusion; the LIBRARY it writes is served at /assets/sounds/foley/.
FOLEY_DIR = Path(__file__).resolve().parents[2] / "foley"
GEN_URL = "https://api.elevenlabs.io/v1/sound-generation"
MODEL_ID = "eleven_text_to_sound_v2"
SR = 48000
TAKES = 4
PROMPT_INFLUENCE = 0.45
MAX_PROMPT_CHARS = 450  # ElevenLabs sound-generation `text` hard limit

# Catalog-wide production directives — precise prompts are what separate
# production foley from a vague approximation (sounds/README.md lesson).
STYLE = (
    "high-fidelity close-miked foley recording, dry studio, single isolated "
    "sound effect, realistic, professional game audio, no music, no voice, "
    "no room reverb, no background noise"
)

# Take-to-take articulation so four generations read as natural variation of
# ONE source (one walker, one button), not four unrelated sounds.
GAIT_VARIANTS = [
    "heel-first, medium weight",
    "flat-footed, slightly lighter",
    "toe-first, soft settle",
    "medium weight, slightly faster",
]
IMPACT_VARIANTS = [
    "standard hit",
    "slightly softer",
    "slightly harder",
    "slightly quicker",
]
SETTLE_VARIANTS = [
    "standard take",
    "slightly slower",
    "slightly softer",
    "slightly grittier texture",
]
PRESS_VARIANTS = [
    "standard press",
    "slightly softer press",
    "slightly firmer press",
    "slightly quicker press",
]

# Ten different KINDS of vocal death, one per take, so the maintainer can pick
# a TYPE rather than a shade (his "the sound should also change type").
DEATH_TYPES = [
    "a short sharp cry cut off suddenly",
    "a long falling wail sinking downward",
    "a pained groan trailing away",
    "a sharp gasp as the breath is knocked out, then quiet",
    "a defeated sigh, giving up",
    "a strained grunt going down hard",
    "a soft whimper fading to nothing",
    "a startled shout, caught by surprise",
    "a slow shuddering exhale, the last breath",
    "a weak breathless cough",
]

# Each SET is one folder under foley/. Footstep set names match
# shared/SURFACES `sound` ids exactly; ui_* sets override the catalog's UI
# event sounds (engine/api.ts COMPOSER_EVENT_FOLEY). Maintainer QA
# 2026-07-18: the catalog UI clicks "sound like a piano, not like buttons"
# — these briefs are TACTILE by construction (and say so out loud, because
# the model loves drifting musical).
SETS: dict[str, dict] = {
    # ROUND 2 (maintainer QA 2026-07-18: black_mountain = the STONE set is
    # the good one; the rest "still not good enough"). What stone got right:
    # a COMPACT DISCRETE IMPACT — its takes trimmed to varied tight lengths,
    # while every disliked set sat at the full clip length (continuous
    # rustle/crunch texture instead of one step). Round-2 briefs copy stone's
    # "one compact impact + tiny character tail" formula, and max_ms
    # transient-tightening enforces it in post regardless of model rambling.
    # Positive + short (sand lesson). Grass = a soft muffled thud with a
    # gentle rustle of blades — soft, not a sharp crack, so the grain judge.
    "grass": {
        "brief": "a soft footstep on grass, a muffled thud with a soft rustle of grass blades",
        "style": "clean close-miked foley, natural, one isolated sound",
        "duration_s": 0.6,
        "variants": GAIT_VARIANTS,
        "max_ms": 600,
        "judge": "grain",
        "pool": 12,
    },
    # ROUND 2 (maintainer: round-1 sand "sounds like metal not sand" — the
    # shipped take had a crest of 18, a sharp metallic spike). Sand is a SOFT
    # granular crunch, no hard tap: the 'grain' judge caps crest (rejects
    # the metallic spike) and the brief bans every metal/click cue.
    # ROUND 4 (maintainer insight): NEGATIVE prompts backfire — repeating
    # "no metal, no crunch, no click" makes the model weight those very words
    # (like "don't draw a blue jacket" → blue jacket). PURELY POSITIVE and
    # SHORT now: describe only what sand is. Also a short positive `style`
    # override (the global STYLE carries its own negatives). Grain judge (a
    # SELECTION safeguard, prompt-independent) still gates metallic spikes.
    "sand": {
        "brief": "a single soft footstep in fine dry sand, a gentle grainy shuffle of loose grains",
        "style": "clean close-miked foley, natural, one isolated sound",
        "duration_s": 0.6,
        "variants": GAIT_VARIANTS,
        "max_ms": 700,
        "judge": "grain",
        "pool": 12,
    },
    "snow": {
        "brief": (
            "one single compact footstep in dry powder snow: a short muffled "
            "crunch of snow compacting under a boot, tight, exactly one step, "
            "no walking sequence, no ambience, no wind"
        ),
        "duration_s": 0.6,
        "variants": GAIT_VARIANTS,
        "max_ms": 600,
        "judge": "step",
        "pool": 9,
    },
    # LIKED (black_mountain verdict) — recipe frozen, do not regenerate
    # casually; if it ever must rerun, keep this brief verbatim.
    "stone": {
        "brief": (
            "a single footstep on a flat stone paving slab: a hard leather boot "
            "heel striking dense rock, compact dry tap with a faint grit scuff"
        ),
        "duration_s": 0.8,
        "variants": GAIT_VARIANTS,
    },
    # Positive + short (the sand lesson: negatives backfire). Ice = walking
    # on glass, brittle and crisp (maintainer's words).
    "ice": {
        "brief": "a single footstep on thin brittle ice, a crisp glassy crackle as the surface cracks under the boot, sharp and clear",
        "style": "clean close-miked foley, natural, one isolated sound",
        "duration_s": 0.5,
        "variants": GAIT_VARIANTS,
        "max_ms": 500,
        "judge": "step",
        "pool": 12,
    },
    # A VOCAL jump effort (maintainer 2026-07-19: "like Link in Ocarina of
    # Time — his voice, he moans" on jumping). This is the ONE set that must
    # ALLOW a voice, so it OVERRIDES the global STYLE (which bans "no voice").
    # No max_ms (a grunt's vowel IS the sound — transient-tightening would cut
    # it) and no judge (measurable gates can't grade a voice; ears decide via
    # /#foley). A small POSITIVE brief per the negative-prompt-backfire lesson.
    # ⭐ VOICE PLAYBACK LESSON (2026-07-25), CORRECTED 2026-08-06: these takes
    # play at RATE 2.0 in the engine (JUMP_VOICE in engine/api.ts) and that is
    # what gives the true normal voice — the maintainer's ear was right. The
    # REASON was wrong: nothing is "authored at half speed". The raw pcm_*
    # payload is multi-channel and _decode used to read it byte-blind as mono,
    # interleaving the channels into one stream at twice the length and an
    # octave down. See _fit_channels, which now collapses it at decode time.
    # THIS SET AND EVERY SET ABOVE PREDATE THAT FIX, so their files really are
    # 2x long and an octave low and the engine's rate 2.0 is still exactly
    # right for them. DO NOT "tidy up" JUMP_VOICE's rate. Sets generated AFTER
    # the fix are true-speed and must play at 1.0 — mixing the two rates up is
    # the one way to make this worse, so a post-fix voice set says so on its
    # own spec.
    # The avatar is female (maintainer 2026-07-19: round-1 came back a male
    # orc grunt — "she is a girl you know"). CAREFUL: "young girl / small
    # girl / little girl" wording gets HARD-BLOCKED by ElevenLabs moderation
    # (request_blocked_due_to_moderation, 403 — child-voice ToS). Say "young
    # WOMAN / female heroine" instead: still light, bright and high-pitched,
    # but an adult voice that passes moderation. Feminine in every clause
    # (the model reads gender from the whole phrase, positive per the lesson).
    "jump_voice": {
        "brief": (
            "a young woman's short light vocal effort as she jumps, a quick "
            "bright high 'hyah', an energetic female adventure heroine's voice"
        ),
        "style": "clean close-miked dry vocal, a single short isolated female grunt",
        "duration_s": 0.5,
        "variants": [
            "a short bright hyah",
            "a lighter quick hup",
            "a higher soft heh",
            "a quick light huh",
        ],
        "takes": 4,
        "pool": 8,
    },
    # The BOY's OWN jump voice (maintainer 2026-07-20: "new jump sound for the
    # boy … their own voice, not just pitched down"). CAREFUL, two lessons:
    # (1) round-1 jump_voice came back a deep ORC grunt — so lean YOUNG, LIGHT,
    # BRIGHT, HUMAN, energetic (never deep/gruff/monstrous; no "orc"). (2)
    # "boy / young boy / little boy" risks the same child-voice moderation
    # block that "girl" hit — say "young MAN / youthful", an adult male voice
    # that still reads youthful. Positive only (negatives backfire).
    "jump_voice_boy": {
        "brief": (
            "a young man's short bright vocal effort as he jumps, a quick light "
            "energetic 'hup', a youthful heroic adventurer's voice, clean and human"
        ),
        "style": "clean close-miked dry vocal, a single short isolated male voice",
        "duration_s": 0.5,
        "variants": [
            "a short bright hup",
            "a lighter quick heh",
            "a soft quick huh",
            "a quick energetic hyah",
        ],
        "takes": 4,
        "pool": 8,
    },
    "wood": {
        "brief": (
            "one single compact footstep on a thick wooden plank: a boot heel "
            "knock, hard like a tap on stone but hollow and woody, tight and "
            "dry, exactly one step, no walking sequence, no ambience"
        ),
        "duration_s": 0.6,
        "variants": GAIT_VARIANTS,
        "max_ms": 600,
        "judge": "step",
        "pool": 9,
    },
    "dirt": {
        "brief": (
            "one single compact footstep on hard-packed dry dirt: a dull firm "
            "boot thud with a tiny grit scuff, tight and dry, exactly one step, "
            "no walking sequence, no ambience"
        ),
        "duration_s": 0.6,
        "variants": GAIT_VARIANTS,
        "max_ms": 600,
        "judge": "step",
        "pool": 9,
    },
    "swamp": {
        "brief": (
            "one single compact squelching footstep in shallow mud: a short wet "
            "sucking squish of one boot press, tight, exactly one step, no "
            "walking sequence, no ambience, no water stream"
        ),
        "duration_s": 0.6,
        "variants": GAIT_VARIANTS,
        "max_ms": 700,
        "judge": "step",
        "pool": 9,
    },
    # WET footstep for the walkable SHORELINE band (maintainer 2026-07-18:
    # wet steps take over when walking/running on the wet transition tiles
    # next to water; swim-entry sounds are later scope). ROUND 2: round 1's
    # take sounded like a door — briefs now scream anti-door and candidates
    # are judged by similarity to the known-watery splash reference.
    # ROUND 3 (round 2's "squelch mud" framing didn't read as a wet
    # footstep either): classic puddle-step foley framing, and the pool
    # explores FOUR different wet framings (variants carry whole framings,
    # not gait articulations) — 3 candidates each, wetness-gated, most
    # splash-like ranked first.
    "water_step": {
        "brief": (
            "one single light wet footstep: a boot stepping into a shallow "
            "puddle of water, a quick splashy slap with a few small droplets, "
            "exactly one step, only water sounds, no door, no wood, no knock, "
            "no creak, no click, no mud suction, no stream, no rain, no "
            "ambience"
        ),
        "duration_s": 0.6,
        "variants": [
            "in a shallow rain puddle on a path",
            "on a wet sandy lake shore under a thin film of water",
            "on wet smooth rock, water splashing off the sole",
            "quick and light, barely ankle-deep clear water",
        ],
        "max_ms": 650,
        "judge": "wet",
        "ref": "sounds/movement/splash/splash__take01.wav",
        "pool": 12,
    },
    # ---- THE PLAYER'S OWN DEATH VOICE (maintainer 2026-08-06: "create the die
    # sound by using the male/female voice … the sound should also change type
    # … generate lots of different takes for both man and female, I don't know
    # which one will be best"). Round 6 already spent ten foley concepts on
    # player_die and lost all ten; his answer is that the moment belongs to the
    # character, not to a prop, which is the same instinct that made the jump
    # grunt work.
    #
    # "CHANGE TYPE" IS THE BRIEF: the ten variants below are ten different
    # KINDS of vocal death — a cry cut off, a falling wail, a groan, a knocked-
    # out gasp, a defeated sigh, a strained grunt, a whimper, a startled shout,
    # a last shuddering breath, a weak cough — not ten readings of one cry. With
    # no judge (measurable gates cannot grade a voice) the candidates ship in
    # generation order, so take01..take10 ARE variants 1..10 in the order
    # written here, and he can pick a TYPE by number in the wiki.
    #
    # TRUE SPEED. These are the first voice sets generated after the
    # _fit_channels decode fix, so the files are the real voice at the real
    # pitch: they audition correctly in the wiki at rate 1.0 and must be played
    # at 1.0. The jump sets predate the fix and keep their 2.0 — see the note
    # on jump_voice. Same moderation rule as the jump voices: "young WOMAN" /
    # "young MAN", never boy/girl (child-voice ToS block), and positive wording
    # throughout.
    "die_voice": {
        "brief": (
            "a young woman's final vocal cry as she is defeated and falls, one "
            "short isolated human voice, an adventure heroine's voice"
        ),
        "style": "clean close-miked dry vocal, a single isolated female voice",
        "duration_s": 1.2,
        "variants": DEATH_TYPES,
        "takes": 10,
        "pool": 10,
    },
    "die_voice_boy": {
        "brief": (
            "a young man's final vocal cry as he is defeated and falls, one "
            "short isolated human voice, a youthful heroic adventurer's voice"
        ),
        "style": "clean close-miked dry vocal, a single isolated male voice",
        "duration_s": 1.2,
        "variants": DEATH_TYPES,
        "takes": 10,
        "pool": 10,
    },
    # ---- world/weather (real sources, not disguises: the maintainer heard
    # straight through the slowed-explosion "thunder") ----
    # ROUND 8 (maintainer 2026-08-06). The previous set was briefed as
    # DISTANT ROLLING thunder "from a storm beyond the horizon" — 6-second
    # rolls, ~100% of their energy below 150 Hz — and he rejected all four in
    # the wiki. His words for what it actually has to be: "the exact high
    # loud thunder after a lightning strike CLOSE BY … synced to the white
    # flash … the sound needs to be immediate and loud", and "a group with
    # several sounds, but they should not be long".
    #
    # That is four separate requirements and each one is enforced somewhere:
    #   · CLOSE, not distant → the brief is a crack directly overhead, and
    #     `boom` floors mid_peak_db so a sub-150 Hz roll a phone speaker
    #     cannot reproduce is disqualified rather than merely ranked last.
    #   · SHORT → max_ms trims to 1.4 s measured FROM THE CRACK, so a
    #     candidate that rambles gets its crack cut out of the ramble.
    #   · IMMEDIATE → the crack must land at the very start of the file or
    #     the sync is lost no matter how well the engine times the call, so
    #     attack_ms is now a HARD gate (<= 60 ms), not a ranking preference.
    #   · SEVERAL SOUNDS → six takes, and the engine rotates them (the old
    #     set had four takes and the click profile played take01 every single
    #     strike, so he heard one thunder, forever).
    # Purely positive wording, including about the rain: the old brief said
    # "no rain, no wind" and he reported hearing rain — the negative-prompt
    # backfire, in the wild.
    "thunder": {
        "brief": (
            "an extremely close lightning strike directly overhead: one "
            "instant deafening thunder crack, a sharp explosive splitting "
            "snap with a hard short rumble right behind it"
        ),
        "style": (
            "high-fidelity outdoor storm recording, one single isolated close "
            "thunder crack, immediate and very loud"
        ),
        "duration_s": 2.5,
        "takes": 6,
        "variants": [
            "one sharp splitting crack right overhead",
            "a harder deeper detonation with more low-end punch",
            "a brighter tearing crack, fast and electric",
            "a heavy close blast with a short rolling tail",
            "a tight fast crack, almost a gunshot snap",
            "a wide powerful boom straight overhead",
        ],
        "max_ms": 1400,
        "judge": "boom",
        "pool": 18,
    },
    # ---- UI buttons. ROUND 3: "wooden button" briefs FAILED twice — wood
    # resonates, resonance is pitch, pitch reads as piano. The mechanisms
    # are now explicitly NON-RESONANT (switches, latches, mouse/keyboard),
    # and the strict `click` tonality gate auto-rejects any candidate that
    # rings — the pipeline can no longer ship a piano even if the model
    # produces one. ----
    "ui_tick": {
        "brief": (
            "a tiny dry mechanical click of a small plastic button, like a "
            "single quiet mouse click, one instant snap, no resonance, no "
            "ring, no echo, NOT musical, no chime, no piano, no tone, no "
            "wooden knock"
        ),
        "duration_s": 0.5,  # API minimum — 0.4 got a 400 (run 2)
        "variants": PRESS_VARIANTS,
        "max_ms": 250,
        "judge": "click",
        "pool": 9,
    },
    "ui_confirm": {
        "brief": (
            "a chunky mechanical latch click of a sturdy switch snapping on, "
            "like a heavy mechanical keyboard thock, one instant dry clack, "
            "no resonance, no ring, no echo, NOT musical, no chime, no "
            "piano, no tone, no wooden knock"
        ),
        "duration_s": 0.5,
        "variants": PRESS_VARIANTS,
        "max_ms": 350,
        "judge": "click",
        "pool": 9,
    },
    "ui_cancel": {
        "brief": (
            # Reworded (the previous "switch snapping off" phrasing hit an
            # unde codable API response twice in a row — set-specific).
            "a soft dull mechanical click of a button being released, lower "
            "and duller than a press click, one instant dry click, no "
            "resonance, no ring, no echo, NOT musical, no chime, no piano, "
            "no tone, no wooden knock"
        ),
        "duration_s": 0.5,
        "variants": PRESS_VARIANTS,
        "max_ms": 350,
        "judge": "click",
        "pool": 9,
    },
    # ---- ROUND 5 (maintainer 2026-08-05): CANDIDATES FOR THE WIKI ----------
    # Ten sets for the new assignable actions (combat, loot, the grave cross,
    # dying). NOTHING here plays in the game: the engine is silent-by-default
    # (engine/api.ts EVENT_ASSIGNMENTS) and these exist so the Game Master can
    # audition them in the wiki and assign winners. Briefs follow every
    # standing lesson: purely positive, WARM (bright = metal), one compact
    # isolated moment. The monster world is porings/soft creatures — squishy,
    # bouncy, never gory.
    "hit_taken": {
        "brief": (
            "a single dull body impact, a fist landing on a thick padded "
            "cloth jacket, one deep soft warm thump, low and muffled"
        ),
        "duration_s": 0.6,
        "variants": IMPACT_VARIANTS,
        "max_ms": 500,
        "judge": "grain",
        "pool": 10,
    },
    "kick": {
        "brief": (
            "a single fast martial-arts kick through the air, one short "
            "breathy whoosh of air ending in a light soft cloth snap"
        ),
        "duration_s": 0.6,
        "variants": IMPACT_VARIANTS,
        "max_ms": 500,
        "pool": 10,
    },
    "punch": {
        "brief": (
            "a single compact punch, knuckles landing one solid hit on a "
            "heavy leather training bag, one deep warm thud"
        ),
        "duration_s": 0.6,
        "variants": IMPACT_VARIANTS,
        "max_ms": 450,
        "judge": "grain",
        "pool": 10,
    },
    "monster_hit": {
        "brief": (
            "one deep muted squash, a heavy soft hand pressing fast into "
            "thick dough, a single low dull bassy thump, round and rubbery"
        ),
        "duration_s": 0.6,
        "variants": IMPACT_VARIANTS,
        "max_ms": 450,
        "judge": "grain",
        "pool": 10,
    },
    "monster_die": {
        "brief": (
            "a single soft squishy pop of a small round jelly creature "
            "bursting, one bouncy wet plop followed by a quick gentle puff "
            "of air, playful and round"
        ),
        "duration_s": 0.9,
        "variants": IMPACT_VARIANTS,
        "max_ms": 800,
        "judge": "grain",
        "pool": 10,
    },
    "player_die": {
        "brief": (
            "a body slumping and collapsing onto soft grassy ground, heavy "
            "cloth folding and settling, ending with one final soft muffled "
            "thump, slow and gentle"
        ),
        "duration_s": 1.2,
        "variants": SETTLE_VARIANTS,
        "pool": 8,
    },
    "cross_rise": {
        "brief": (
            "heavy damp garden soil shifting low and deep as a wooden post "
            "pushes slowly upward, a dull earthy rumble of soft dirt clumps, "
            "ending in one low muffled wooden settle"
        ),
        "duration_s": 1.2,
        "variants": SETTLE_VARIANTS,
        "pool": 8,
    },
    "cross_sink": {
        "brief": (
            "a small wooden post sinking slowly down into loose garden "
            "soil, dry earth sliding and closing over wood, ending soft and "
            "buried and muffled"
        ),
        "duration_s": 1.2,
        "variants": SETTLE_VARIANTS,
        "pool": 8,
    },
    "item_pickup": {
        "brief": (
            "one quick soft grab of a small cloth pouch off the ground, a "
            "low dull leather pat with one muted round wooden tap, warm and "
            "dark and satisfying"
        ),
        "duration_s": 0.6,
        "variants": IMPACT_VARIANTS,
        "max_ms": 450,
        "judge": "grain",
        "pool": 10,
    },
    "item_drop": {
        "brief": (
            "a small heavy beanbag landing on soft earth, one single low "
            "dull deep thump, muffled and dark, dead ground"
        ),
        "duration_s": 0.6,
        "variants": IMPACT_VARIANTS,
        "max_ms": 600,
        "judge": "grain",
        "pool": 10,
    },
}


# ---- ROUND 6 (maintainer 2026-08-05): "10 different sound ALTERNATIVES per
# action, not one" — each action gets sibling sets, each a genuinely DIFFERENT
# concept (material, weight, style: realistic foley / cartoon / retro-arcade),
# not articulation shades of one idea. One take each: the Game Master picks the
# winner by ear in the wiki, so my selection gates would only narrow variety —
# judges are deliberately OFF here. When an alternative WINS assignment, a
# follow-up run gives that one set its 4-take round-robin variation.
#
# ROUND 6 VERDICT (wiki, 2026-08-06): he kept ten of ninety-ish. Everything
# else was rejected and DELETED — takes, pool candidates and folders. Only the
# survivors are still briefed below, so a bare `generate.py` can never quietly
# resurrect a losing concept. DO NOT RE-BRIEF THESE, they have been heard and
# turned down:
#   · the `retro` 8-bit take of EVERY action — ten for ten rejected. The
#     arcade lane is closed; round 7 has none.
#   · hit_taken: slap whump crack wet hollow drum double
#   · kick: heavy whip double cloth low dummy snap
#   · punch: jab heavy smack clay miss knock glove blanket
#   · monster_hit: jelly bounce balloon squeak slosh leaves pillow
#   · monster_die: deflate poof pop squelch boing vanish
#   · player_die: ALL TEN (heartbeat bell sigh slump drumfall gong wind echo)
#     — the whole slow-solemn-fade lane failed, so round 7 leaves it.
#   · cross_rise: creak stone hum chime drumroll dig shimmer
#   · cross_sink: bury creak drumdown sand shimmer slide wind
#   · item_pickup: ALL TEN
#   · item_drop: sack block jingle blip leather book basket bloop
#   · level_up: fanfare chimes bells musicbox drums sparkle horn — bright
#     struck metal lost across the board.
# What he KEPT reads consistent: ORGANIC and PHYSICAL for impacts (gut,
# bamboo, splat, bubble, mudplop, roots, swallow) and WARM ACOUSTIC for the
# musical moment (choir, harp). Round 7 keeps that as a prior without
# collapsing into it — he asked for different vibes, so the spread is wide;
# it just spends none of the ten on arcade blips or bright bells.
# (suffix, brief, duration_s, max_ms or None)
ALTERNATIVES: dict[str, list[tuple]] = {
    "hit_taken": [
        ("gut", "one deep visceral body blow, a heavy boxing-bag hit with a low soft push of air", 0.7, 600),
    ],
    "kick": [
        ("bamboo", "one swing of a light bamboo stick through air, a clean airy swish with a faint woody whistle", 0.6, 500),
    ],
    "monster_hit": [
        ("splat", "a single juicy splat, a ripe tomato hitting a wooden board, wet and pulpy", 0.6, 500),
    ],
    "monster_die": [
        ("bubble", "one big fat bubble bursting in thick mud, a deep gloopy bloop", 0.8, 700),
        ("splat", "one heavy wet splat collapsing into a soft liquid slump, gloopy and thick", 1.0, None),
    ],
    "cross_rise": [
        ("roots", "thick roots and damp soil pulling softly apart, slow low earthy tears", 1.2, None),
    ],
    "cross_sink": [
        ("swallow", "soft wet earth swallowing something slowly, a low gulping settle into mud", 1.2, None),
    ],
    "item_drop": [
        ("mudplop", "a small stone landing in soft mud, one deep wet plop", 0.6, 500),
    ],
    # LEVEL UP (maintainer 2026-08-06). No base set — the alternatives ARE the
    # set. A level-up is a MUSICAL moment, so unlike the impact sets brightness
    # is not a fault here; struck metal still lost, warm voices/strings won.
    "level_up": [
        ("harp", "one quick harp glissando sweeping upward, ending on a soft shining chord", 1.8, None),
        ("choir", "a short warm angelic choir swell on an open ah vowel, rising and resolving brightly", 2.0, None),
    ],
}

# ---- ROUND 7 (maintainer 2026-08-06): "10 more level_up, taking_dmg, kick,
# punch and die sound effects. All different vibes." Ten fresh concepts per
# action, none repeating a round-6 brief (see the rejected list above) and none
# spent on arcade. The spread is deliberate — each action reaches across
# materials (wood, steel, cloth, water, snow, earth, stone), across weights,
# and for the two long ones across whole moods, so ten auditions are ten real
# choices rather than one idea shaded ten ways. Same contract as round 6: one
# take, no gates, played nowhere until he assigns it in the wiki.
ROUND7: dict[str, list[tuple]] = {
    # TAKING DAMAGE — the moment has to land as a body, not a prop. Ten
    # different things standing between the blow and the player.
    "hit_taken": [
        ("armor", "a hard blow landing on a steel breastplate, a dull metallic clang smothered by padding underneath", 0.7, 600),
        ("oof", "one short breathless adult male oof, the air knocked out of him in a single grunt, no words", 0.7, 600),
        ("coat", "a heavy impact into a thick winter coat worn over a body, deep and cloth-muffled", 0.6, 550),
        ("melon", "a ripe melon struck once with a flat palm, dense and hollow-wet", 0.6, 500),
        ("earth", "a body dropping hard onto damp packed soil, one dull earthy thud", 0.7, 600),
        ("rope", "a thick coiled ship rope dropped hard onto a wooden deck, one heavy fibrous slap", 0.6, 550),
        ("bass", "a single very low bass drum boom with a short soft skin slap on top", 0.7, 650),
        ("snow", "a heavy fist driven into deep packed snow, a muffled crunching compression", 0.7, 600),
        ("water", "a heavy blow landing in a barrel of water, a deep muted thud with a push of liquid", 0.7, 650),
        ("stagger", "one blunt impact followed immediately by boots scuffing and stumbling on grit", 0.9, None),
    ],
    # KICK — round 6 was nine shades of air. This time the boot mostly HITS
    # something, and the ten things it hits are the variety.
    "kick": [
        ("shield", "a boot slamming into a round wooden shield, a big hollow woody bang", 0.7, 600),
        ("gravel", "a hard kick scuffing through loose gravel, a gritty scrape with a spray of stones", 0.7, 600),
        ("boot", "a heavy leather boot striking a stuffed leather sack, a broad creaking thud", 0.6, 550),
        ("door", "a solid boot kick against a heavy plank door, a deep booming rattle in the frame", 0.8, 700),
        ("chain", "a kick landing on hanging chain mail, a soft thud wrapped in ringing metal links", 0.7, 600),
        ("punt", "a long powerful punt of a heavy leather ball, a big hollow pock", 0.6, 550),
        ("hay", "a boot driven into a tight hay bale, a dry rustling crunch", 0.7, 600),
        ("pot", "a clay pot kicked over and skidding once across stone, a hollow ceramic knock", 0.8, 700),
        ("greave", "a boot striking a plated steel greave, a bright metallic clank over a low thump", 0.6, 500),
        ("sandspray", "a kick sweeping through loose dry sand, a soft grainy hiss thrown forward", 0.7, 600),
    ],
    # PUNCH — a fist against ten different surfaces, from stone to flour.
    "punch": [
        ("barrel", "a fist striking a wooden barrel lid, a tight woody boom", 0.6, 500),
        ("wetcloth", "a punch into heavy soaked cloth, a dense wet slap", 0.6, 500),
        ("flour", "a fist buried into a sack of flour, a soft dusty pomf with a fine hiss", 0.6, 550),
        ("stonewall", "a bare knuckle striking a stone wall, a hard flat crack with no ring", 0.5, 400),
        ("plate", "a gauntlet punching a steel plate, a sharp metallic bang with a dull ring after", 0.6, 500),
        ("snowbank", "a fist punched into deep fresh snow, a crisp muffled crunch", 0.6, 550),
        ("water", "a fist punched down into a basin of water, a sharp liquid slap and splash", 0.6, 550),
        ("icecrack", "a fist breaking through a sheet of thin ice, a bright brittle shatter", 0.7, 600),
        ("hollowlog", "a fist thumping a hollow log, a deep woody knock with a short natural ring", 0.7, 600),
        ("canvas", "a punch into a taut canvas sail, a sharp drum-tight snap", 0.5, 450),
    ],
    # THE PLAYER DIES — round 6 spent all ten on the same slow solemn fade and
    # lost all ten, so none of these are a bell tolling in an empty field. Ten
    # different ways for a world to close: musical, elemental, mechanical.
    "player_die": [
        ("cello", "one low cello note sagging downward and dying away, mournful and warm", 1.6, None),
        ("clarinet", "a soft descending woodwind phrase, a clarinet sighing down to rest", 1.5, None),
        ("unravel", "a magical shimmer collapsing inward and thinning away, glassy and cold", 1.4, None),
        ("underwater", "sinking under water once, a muffled plunge and everything going quiet and low", 1.6, None),
        ("ember", "a fire dying out, a soft hiss and one last crackle fading to nothing", 1.6, None),
        ("stonelid", "a heavy stone lid sliding shut once, a low grinding close ending in silence", 1.4, None),
        ("breath", "one long slow adult exhale letting go and fading out, quiet and breathy, no words", 1.5, None),
        ("organ", "a low pipe organ chord fading out slowly in a stone hall, dark and solemn", 1.8, None),
        ("wings", "a rush of wings scattering away all at once, leaving a hollow quiet behind", 1.4, None),
        ("clockstop", "a clockwork mechanism winding down, ticks slowing unevenly and stopping", 1.6, None),
    ],
    # LEVEL UP — he kept the choir and the harp and turned down every struck
    # metal, so these ten stay acoustic and warm, and get their variety from
    # the INSTRUMENT rather than from the brightness.
    "level_up": [
        ("strings", "a warm string section swelling upward and resolving on a bright major chord", 2.0, None),
        ("lute", "a quick bright lute flourish climbing upward, plucked gut strings, folk and warm", 1.6, None),
        ("flute", "a light wooden flute trill rising and landing on one clear held note", 1.8, None),
        ("organ", "a small church organ blooming upward into a warm bright chord", 2.0, None),
        ("voices", "soft warm voices humming a short rising phrase together, no words", 2.0, None),
        ("whistle", "a cheerful human whistle climbing a short happy phrase", 1.6, None),
        ("accordion", "a bright accordion swell rising into a happy folk chord", 1.8, None),
        ("marimba", "a warm wooden marimba run climbing quickly upward, round and woody", 1.6, None),
        ("bowl", "a singing bowl blooming warm and wide with a slow rising shimmer", 2.0, None),
        ("handdrum", "a quick hand drum flourish rising to one warm open ring, earthy and live", 1.6, None),
    ],
}
for _action, _alts in ROUND7.items():
    ALTERNATIVES.setdefault(_action, []).extend(_alts)

# ---- ROUND 9 (maintainer 2026-08-06): "Generate more button click/press/
# release sounds. Need like 10 to pick from." Ten tactile MECHANISMS, one per
# set — the variety is in what physically makes the click (spring, plastic,
# metal catch, stone, leather, wood, cork, flint), not in shading one click ten
# ways. Nothing musical and nothing arcade: the catalog UI sounds were rejected
# for sounding "like a piano, not like buttons" (2026-07-18) and every `retro`
# alternative lost in round 6.
#
# TWO deliberate differences from the ui_tick/ui_confirm briefs above:
#   1. PURELY POSITIVE wording. Those two are the most negative briefs in this
#      file ("no resonance, no ring, no echo, NOT musical, no chime, no piano,
#      no tone, no wooden knock") — they predate the backfire lesson the sand
#      set taught and the old thunder brief confirmed in the wild. Naming the
#      thing you do not want is how you get it. The anti-piano job belongs to
#      the `click` GATE, which measures tonality and is prompt-independent.
#   2. A POOL of 3 with that gate on, unlike rounds 6-8's one-shot
#      alternatives. The gate cannot narrow variety here: variety lives ACROSS
#      the ten briefs, and the judge only picks among three renditions of ONE
#      concept.
#      CORRECTION, same day, after the takes landed: the reasoning above said
#      the gate expresses his complaint as a number. IT DOES NOT — replaying
#      his own kept/rejected UI verdicts through it shows it passes 7 of the 7
#      takes he threw away (see the warning on GATES["click"]). The pool is
#      still worth having, because three attempts beat one; the gate's verdict
#      on these ten is not worth reporting to him, and four of them measure
#      "failing" purely because a clasp and a cork ring by nature.
#
# PRESS vs RELEASE: the game's tactile pair wants a sharp DOWN and a duller UP,
# and `ui.release` has been silent since ui_cancel was rejected. So the ten
# span both halves on purpose — switch/latch/clasp/flint/pebble read as the
# down-stroke, leather/cork/woodpeg/keycap as the up. Which is which is HIS
# call in the wiki; nothing here is wired.
UI_CLICKS: list[tuple] = [
    ("switch", "a small toggle switch flicking over, one crisp mechanical snap", 250),
    ("keycap", "a mechanical keyboard key bottoming out, one firm plastic thock", 300),
    ("latch", "a small metal latch dropping into its catch, one tight clean clack", 250),
    ("pebble", "one small smooth pebble tapped once against another, a bright dry tick", 220),
    ("leather", "a stiff leather cover pressed down under a thumb, one soft creaking tap", 350),
    ("woodpeg", "a wooden peg pushed home into a hole in a plank, one warm dry knock", 300),
    ("clasp", "the metal clasp on a book snapping shut, one small bright click", 250),
    ("cork", "a cork stopper pressed into a bottle neck, one soft muted pop", 300),
    ("flint", "a piece of flint struck once against steel, one sharp gritty tick", 220),
    ("bead", "a wooden abacus bead sliding one notch along its wire, one small warm click", 250),
]
for _suffix, _brief, _trim in UI_CLICKS:
    SETS[f"ui_click_{_suffix}"] = {
        "brief": _brief,
        "style": "clean close-miked foley, dry studio, one isolated tactile click",
        "duration_s": 0.5,  # API minimum — 0.4 gets a 400 (run 2)
        "variants": ["standard take"],
        "takes": 1,
        "max_ms": _trim,
        "judge": "click",
        "pool": 3,
    }


# ---- ROUND 10 (maintainer 2026-08-06): "It feels like I have nothing to
# select from! Generate more!!!" He is right, and the audit says exactly where:
# item.pickup had ZERO candidates, item.drop / cross on / cross off /
# monster_hit had ONE each and monster_die two — because round 6 offered ten
# apiece and he rejected all but one, and rounds 7-9 refilled only the actions
# he named at the time. Ten fresh concepts for every thin action, plus ten more
# kick and ten more punch on top of round 7's, plus the button DOWN and button
# UP families he asked for by name.
# Same contract as every alternatives round: one take, no gates, played nowhere
# until he assigns it in the wiki. No arcade, nothing musical in the impacts,
# and no brief repeats a concept from rounds 6-7 (the rejected list lives above).
ROUND10: dict[str, list[tuple]] = {
    # PICKING AN ITEM UP — the empty one, so it gets the widest spread: what
    # the item is lifted OUT OF, and what it is made of.
    "item_pickup": [
        ("grass", "a small object plucked up out of grass, a soft leafy rustle and lift", 0.6, 550),
        ("gravel", "a small object lifted off gravel with a short stony scrape", 0.5, 450),
        ("chain", "a small chain lifted from the ground, links sliding together", 0.6, 500),
        ("paper", "a folded sheet of paper picked up, a crisp dry crinkle", 0.6, 500),
        ("glass", "a small glass vial lifted off a stone slab, one light clink", 0.5, 450),
        ("wet", "a small object lifted out of shallow water, a quick drip and suck", 0.6, 550),
        ("straw", "something pulled out of a straw basket, a dry fibrous shuffle", 0.6, 550),
        ("twig", "a dry twig snapped off and taken, one tiny crisp snap", 0.5, 400),
        ("purse", "a leather purse lifted, a soft creak with the contents shifting", 0.6, 550),
        ("sand", "a small object brushed up out of fine sand, a soft grainy sweep", 0.6, 550),
    ],
    # DROPPING ONE — what it lands ON, and how heavy it is.
    "item_drop": [
        ("clay", "a clay cup set down hard on stone, one dull round knock", 0.6, 500),
        ("earth", "a heavy pouch dropping onto packed earth, one deep dull thud", 0.6, 550),
        ("metalring", "a metal ring landing on stone, one bright roll and settle", 0.8, 700),
        ("puddle", "a small object dropped into a shallow puddle, a short flat splash", 0.6, 550),
        ("hay", "something dropped into a pile of loose straw, a soft dry rustle", 0.6, 550),
        ("slate", "a flat slate dropping onto slate, one hard clack", 0.5, 450),
        ("leaves", "something dropped into dry leaves, a papery crunch", 0.6, 550),
        ("rope", "a coil of rope dropping onto boards, a heavy soft flop", 0.6, 550),
        ("bounce", "a small hard object bouncing twice on a wooden floor and settling", 0.8, 700),
        ("pebbles", "a handful of small stones landing on gravel, a scattering patter", 0.7, 600),
    ],
    # THE GRAVE CROSS RISING at the death spot — earth giving way, something
    # heavy coming up through it. Deliberately not the rejected creak/hum/dig.
    "cross_rise": [
        ("earthpush", "packed soil pushing apart from below as something heavy rises through it", 1.2, None),
        ("rootsnap", "thin roots tearing one after another as something lifts free", 1.1, None),
        ("gravelshed", "grit and small stones cascading off something rising out of the ground", 1.1, None),
        ("breath", "a long slow cold draw of air rising upward, hollow and empty", 1.3, None),
        ("cloth", "heavy damp cloth drawn slowly upward, a soft dragging rasp", 1.2, None),
        ("iron", "an iron post rising up through soil, a low grinding metal scrape", 1.2, None),
        ("water", "water draining off something lifting out of wet ground", 1.2, None),
        ("settle", "a slow heavy rise ending in one firm settle into place", 1.1, None),
        ("drone", "a deep quiet drone rising and stopping clean", 1.3, None),
        ("crackle", "dry earth crust cracking open along a slow line", 1.1, None),
    ],
    # THE CROSS SINKING AWAY a minute later — the ground taking it back.
    "cross_sink": [
        ("mud", "thick mud closing over something sinking, a slow gloopy seal", 1.2, None),
        ("crumble", "dry soil crumbling inward and filling a hole", 1.1, None),
        ("drain", "water draining away down a hole, a low gurgle", 1.2, None),
        ("iron", "an iron post grinding downward into soil, a low metal scrape", 1.2, None),
        ("cloth", "heavy cloth sliding down and settling flat", 1.1, None),
        ("breathout", "a long slow cold exhale sinking downward and fading", 1.3, None),
        ("dronedown", "a deep quiet drone falling away and stopping", 1.3, None),
        ("gravelfill", "gravel pouring in to fill a gap in the ground", 1.1, None),
        ("thud", "a slow descent ending in one deep muffled thud", 1.1, None),
        ("hush", "everything going quiet at once, a soft drop in air pressure", 1.2, None),
    ],
    # TEN MORE KICKS, none repeating round 7's ten.
    "kick": [
        ("barrel", "a boot into an empty wooden barrel, a big hollow drum boom", 0.7, 650),
        ("crate", "a boot splintering a thin wooden crate slat, one dry crack", 0.6, 500),
        ("bucket", "a metal bucket kicked over and skidding, a clattering roll", 0.8, 700),
        ("sack", "a boot into a heavy grain sack, one dull deep flump", 0.6, 550),
        ("mud", "a kick through thick mud, a heavy wet squelch and spray", 0.7, 600),
        ("water", "a boot kicking through shallow water, a broad splash", 0.7, 600),
        ("snowbank", "a boot ploughing into deep snow, a muffled compressive crunch", 0.7, 600),
        ("rope", "a boot into a hanging coil of rope, a heavy fibrous thud", 0.6, 550),
        ("treetrunk", "a boot against a solid tree trunk, a dull woody thock with a shiver of leaves", 0.7, 600),
        ("leafpile", "a kick sweeping through a pile of dry leaves, a big scattering crunch", 0.7, 600),
    ],
    # TEN MORE PUNCHES, none repeating round 7's ten.
    "punch": [
        ("mud", "a fist driven into thick wet mud, a deep sucking splat", 0.6, 550),
        ("hay", "a fist into a tight hay bale, a dry compressed crunch", 0.6, 550),
        ("bread", "a fist into a big loaf of bread, a soft crusty crush", 0.6, 500),
        ("shield", "a bare fist on a wooden shield, a hollow woody bang", 0.6, 550),
        ("chainmail", "a fist against chain mail, a soft thud inside ringing links", 0.6, 550),
        ("cuirass", "a fist on a leather cuirass, a broad creaking slap", 0.6, 500),
        ("treetrunk", "a bare fist against a tree trunk, a dull woody knock", 0.5, 450),
        ("strawdummy", "a fist into a straw training dummy, a fibrous thwack", 0.6, 500),
        ("gravelbag", "a fist into a bag of gravel, a dense grinding crunch", 0.6, 550),
        ("chest", "a fist on a wooden chest lid, a tight boxy boom", 0.6, 550),
    ],
    # HITTING A MONSTER — soft strange bodies, not human ones.
    "monster_hit": [
        ("mudsmack", "a fist into wet clay mud, a thick wet smack", 0.6, 550),
        ("gourd", "a hollow dry gourd struck once, a woody pock", 0.6, 500),
        ("bristle", "a hit into stiff bristles, a coarse scratchy compression", 0.6, 550),
        ("sap", "a sticky wet impact with a tacky pull afterwards", 0.7, 600),
        ("shell", "a hard shell struck once, a bright hollow tap", 0.5, 450),
        ("fungus", "a big soft mushroom cap crushed, a wet muted pop", 0.6, 550),
        ("moss", "a hit into thick damp moss, a soft spongy compress", 0.6, 550),
        ("stonebody", "a fist on solid rock, a hard dead knock", 0.5, 450),
        ("seedpod", "a dry seed pod burst open, a crisp scattering crack", 0.6, 500),
        ("tar", "a heavy impact into thick tar, a slow sticky thud", 0.7, 650),
    ],
    # A MONSTER DYING — the body going away, ten ways.
    "monster_die": [
        ("crumble", "a body crumbling into dry dust and falling apart", 1.0, None),
        ("shellcrack", "a hard shell cracking open and collapsing inward", 0.9, None),
        ("drip", "a slow wet collapse dripping away to nothing", 1.1, None),
        ("hiss", "a long escaping hiss sinking away to silence", 1.0, None),
        ("slump", "a heavy wet slump settling flat and still", 0.9, None),
        ("shatter", "brittle crystal shattering and tinkling down", 1.0, None),
        ("sizzle", "a wet sizzle fading out, water dying on hot stone", 1.0, None),
        ("suck", "a soft inward suck of air and it is gone", 0.8, None),
        ("twigs", "a dry crunching collapse, a nest of twigs giving way", 0.9, None),
        ("gurgle", "a low wet gurgle sinking away", 1.0, None),
    ],
}
for _action, _alts in ROUND10.items():
    ALTERNATIVES.setdefault(_action, []).extend(_alts)

# BUTTON DOWN and BUTTON UP as their OWN families (maintainer 2026-08-06:
# "Didn't you create at least 10 button down and 10 button up?" — round 9's ten
# spanned both halves in one family, which is not the same as ten of each). Each
# pair below is the SAME mechanism heard from both ends, so a down and an up can
# be chosen from one material and actually sound like one button: the down is
# the sharp, decisive half; the up is the softer, duller release.
UI_DOWN: list[tuple] = [
    ("spring", "a stiff spring compressing to a hard stop, one tight metallic click", 250),
    ("plunger", "a plunger pushed firmly down, one sealed thunk", 300),
    ("tumbler", "a lock tumbler turning one notch, a precise mechanical clack", 250),
    ("dome", "a metal dome switch collapsing under a thumb, one crisp bright snap", 220),
    ("stone", "a small stone pressed down into its socket, one dry click", 250),
    ("stamp", "a rubber stamp pressed onto paper, one firm damp tap", 300),
    ("lever", "a small lever thrown down, one solid mechanical clunk", 300),
    ("shutter", "a camera shutter firing, one clean mechanical snip", 220),
    ("nail", "a nail tapped once into wood, one bright short tick", 220),
    ("clamp", "a small clamp closing tight, one compressed click", 250),
]
UI_UP: list[tuple] = [
    ("spring", "a compressed spring extending back, one soft muted release", 300),
    ("plunger", "a plunger lifting off with a soft airy unseal", 300),
    ("tumbler", "a lock tumbler settling back, one low soft tick", 300),
    ("dome", "a metal dome popping back up, one light dull tap", 250),
    ("stone", "a small stone lifted out of its socket, a soft dry scrape", 300),
    ("stamp", "a rubber stamp peeled up off paper, a soft tacky lift", 350),
    ("lever", "a small lever returning to rest, one muffled wooden clunk", 350),
    ("shutter", "a camera shutter closing back, one soft mechanical settle", 300),
    ("felt", "a felt-padded key rising back, an almost silent muted thud", 350),
    ("clamp", "a small clamp releasing, one soft rebound tap", 300),
]
for _fam, _list in (("ui_down", UI_DOWN), ("ui_up", UI_UP)):
    for _suffix, _brief, _trim in _list:
        SETS[f"{_fam}_{_suffix}"] = {
            "brief": _brief,
            "style": "clean close-miked foley, dry studio, one isolated tactile click",
            "duration_s": 0.5,  # API minimum
            "variants": ["standard take"],
            "takes": 1,
            "max_ms": _trim,
        }

# ---- ROUND 11 (maintainer 2026-08-06): "Can't find a single good die and only
# found one good for kick/punch." Ten more of each, and the FIRST round to
# render through the fixed _generate — every previous take in this library came
# back at half rate with nothing above 12 kHz, which is the dull, transient-
# slurred "game from the 90ths" character he is hearing. The concepts below are
# new, but the bigger change is that they should finally arrive full-band.
ROUND11: dict[str, list[tuple]] = {
    # DYING — round 6 spent ten on a solemn fade and round 7 ten on ways for a
    # world to close, and none landed. These ten are PHYSICAL: what a body and
    # its gear actually do when it goes down. (His own idea, the character's
    # VOICE, is the die_voice/die_voice_boy sets — twenty takes of it.)
    "player_die": [
        ("bodyfall", "a body hitting the ground hard and going still, weight and cloth together", 1.2, None),
        ("armorfall", "a person in armour collapsing, metal plates clattering to a stop", 1.4, None),
        ("swordfall", "a dropped sword ringing once on stone and settling still", 1.4, None),
        ("glassfall", "a pane shattering and the shards settling down to silence", 1.4, None),
        ("lantern", "a lantern dropping and its flame going out with a soft puff", 1.3, None),
        ("hearth", "a fire collapsing into embers, a soft crumble and a last hiss", 1.5, None),
        ("doorslam", "a heavy door slamming shut and the echo dying away", 1.4, None),
        ("rockslide", "a small rockslide tumbling down and stopping dead", 1.4, None),
        ("pages", "loose pages fluttering down and falling still", 1.4, None),
        ("chainslack", "a chain running out, snapping taut, then going slack", 1.3, None),
    ],
    "kick": [
        ("anvil", "a boot against a solid iron anvil, a hard dead clank with no give", 0.6, 550),
        ("cart", "a boot into a wooden cart wheel, a hollow spoked rattle", 0.8, 700),
        ("pumpkin", "a boot bursting a pumpkin, a wet hollow crunch", 0.7, 600),
        ("tent", "a boot into taut canvas tent cloth, a deep drum-tight thud", 0.6, 550),
        ("bell", "a boot against a hanging bronze bell, a dull clang with a long hum", 0.9, 800),
        ("firewood", "a boot into a stack of firewood, a clattering woody tumble", 0.8, 700),
        ("rug", "a boot into a tightly rolled rug, a dense soft whump", 0.6, 550),
        ("gate", "a boot on an iron gate, a rattling metallic bang", 0.8, 700),
        ("bush", "a boot crashing through a dense bush, a thrashing leafy burst", 0.7, 650),
        ("earthmound", "a boot into a mound of loose earth, a heavy soft burst of soil", 0.7, 600),
    ],
    "punch": [
        ("cheese", "a fist into a big wheel of cheese, a dense waxy crush", 0.6, 550),
        ("plank", "a fist snapping a thin wooden plank, one sharp woody crack", 0.6, 500),
        ("curtain", "a fist through a heavy velvet curtain, a muffled soft burst", 0.6, 550),
        ("anvil", "a bare fist landing on an iron anvil, a hard dead ring", 0.6, 500),
        ("waterskin", "a fist on a full waterskin, a taut liquid slap", 0.6, 550),
        ("plaster", "a fist punching through a plaster wall, a dry crumbling break", 0.7, 600),
        ("drum", "a fist on a big taut drum head, a deep resonant boom", 0.7, 650),
        ("sandbank", "a fist into a bank of wet sand, a dense packed thud", 0.6, 550),
        ("helmet", "a fist on an iron helmet, a bright ringing bonk", 0.7, 600),
        ("dough", "a fist into a big mass of dough, a soft airy squelch", 0.6, 550),
    ],
}
for _action, _alts in ROUND11.items():
    ALTERNATIVES.setdefault(_action, []).extend(_alts)

# ---- ROUND 12 (maintainer 2026-08-06): "a sound effect for each monster you
# assume make a certain sound when they're idling … when they walk/jump forward
# … in 'angry idle'/in combat … and when they attack." Four per creature across
# the whole 24-monster roster, named `mon_<roster id>_<state>` so the wiki's
# picker groups all four under one header per monster, and matching the game's
# own animation states — WorldScene now emits monsters.<kind>.{idle,walk,angry,
# attack}, which is what the sound card on each monster page assigns to.
#
# The brief for a creature is written from WHAT IT IS, not from a template: a
# blob has no lungs and no feet, a mammoth has both, a golem is rock walking on
# rock, and the stump is wood. Vocal states override the global STYLE (which
# bans voice) exactly as the jump grunts do; WALK is foley and keeps a max_ms
# trim so it stays one footfall rather than a stride of them.
# (id, idle, walk, angry, attack)
MONSTERS: list[tuple] = [
    ("forest_poring", "a small soft gel blob settling, a faint wet wobble and squish",
     "a small gel blob hopping once onto soft moss, a light wet plop",
     "a small gel blob quivering fast and tightening, an agitated wet trembling",
     "a small gel blob lunging with a sharp wet slap"),
    ("forest_poring_2", "a little leafy sprout-blob rustling gently in place",
     "a leafy sprout-blob hopping once, a soft papery crunch and settle",
     "a leafy sprout-blob shaking its leaves fast and angrily",
     "a leafy sprout-blob whipping forward, a quick leafy thwack"),
    ("ice_poring", "a small frozen gel blob creaking faintly, tiny ice crystals ticking",
     "a frozen gel blob hopping once onto packed snow, a crisp crunch",
     "a frozen gel blob cracking and grinding its ice angrily",
     "a frozen gel blob striking, a brittle icy crack and shatter"),
    ("lava_poring", "a molten gel blob bubbling softly, a low lazy magma glop",
     "a molten blob hopping once onto hot stone, a thick wet sizzle",
     "a molten blob boiling up fast and spitting, an agitated hiss",
     "a molten blob lashing out, a hot wet splat with a sharp sizzle"),
    ("water_poring", "a water blob sloshing gently in place, soft liquid settling",
     "a water blob hopping once, a round wet plop and splash",
     "a water blob churning fast, agitated sloshing and bubbling",
     "a water blob slamming forward, a big flat water slap"),
    ("butterfly_dragon", "a large winged creature breathing softly, slow leathery wing flutter",
     "one deep beat of big leathery wings pushing air downward",
     "a winged creature hissing and beating its wings fast, agitated",
     "a winged dragon lunging with a sharp hiss and a hard wing snap"),
    ("mystical_frog", "a big frog croaking low and slow, one wet resonant burp",
     "a big frog landing from a hop onto wet ground, a soft splat",
     "a big frog croaking fast and swelling, an agitated throaty rattle",
     "a big frog lunging with a snapping wet gulp"),
    ("hedgehog", "a small spiny animal snuffling softly, quills shifting with a dry rustle",
     "small quick paws pattering over dry leaves, one light scuffle",
     "a small spiny animal huffing and rattling its quills fast, angry",
     "a small spiny animal lunging with a sharp squeal and a quill stab"),
    ("white_rabbit", "a small animal breathing quickly, soft fur shifting, a faint nose twitch",
     "a rabbit thumping once as it lands from a hop on soft earth",
     "a small animal snarling and thumping the ground fast, agitated",
     "a small fanged animal lunging with a sharp shriek and a bite snap"),
    ("malformed_creature", "a pale sickly creature breathing wetly and unevenly, a faint rattle",
     "an uneven dragging step of a malformed body over dirt, a scuffing lurch",
     "a malformed creature snarling low and wet, agitated and building",
     "a malformed creature lunging with a wet ragged shriek"),
    ("masked_shadow_creature", "a shadowy figure breathing shallow and hollow, cloth stirring faintly",
     "a soft gliding footfall of a shadow figure, cloth and a whisper of air",
     "a shadow figure hissing low through a mask, rising and menacing",
     "a shadow figure striking, a sharp hollow rasp and a fast cloth snap"),
    ("night_beast", "a large predator breathing deep and slow in the dark, a faint bone click",
     "a heavy padded paw stepping down, a soft thud with a dry bone rattle",
     "a large predator growling low and rising, dangerous and building",
     "a large predator lunging with a roaring snarl and a jaw snap"),
    ("lava_salamander", "a big reptile breathing hot and slow, a soft ember crackle",
     "a heavy reptile foot on hot stone, a scraping step with a faint sizzle",
     "a big fire reptile hissing hard, embers popping angrily",
     "a big fire reptile lunging with a roaring hiss and a burst of flame"),
    ("lava_salamander_2", "a pale reptile breathing slow and rasping, scales shifting",
     "a heavy pale reptile foot scraping over gravel, one dragging step",
     "a pale reptile rasping and snapping, agitated and rising",
     "a pale reptile lunging with a hard rasping snarl and a jaw snap"),
    ("ice_crystal_golem", "a crystal body ticking and creaking faintly as ice settles",
     "a heavy crystal foot planting on frozen ground, a hard crunch",
     "a crystal golem grinding and cracking its facets, building pressure",
     "a crystal golem striking, a bright shattering crack of ice"),
    ("stone_turtle", "a huge shelled creature breathing slow and deep, a faint stone grind",
     "a heavy turtle foot planting, a dull stone thud with a shell shift",
     "a huge shelled creature huffing hard, stone grinding angrily",
     "a huge shelled creature slamming its shell forward, a heavy stone crack"),
    ("tree_stump", "an old tree stump creaking faintly, dry wood settling",
     "a wooden stump hopping once onto soil, a hollow woody thump",
     "an old stump groaning and splitting, wood straining angrily",
     "a tree stump swinging a branch, a hard woody crack and whoosh"),
    ("stone_golem", "a mossy stone figure settling, a low grind with a soft moss rustle",
     "a huge stone foot planting on rock, a deep grinding thud",
     "a stone golem grinding its joints, low and building and angry",
     "a stone golem slamming a rock fist down, a heavy grinding crash"),
    ("diablo", "an ash demon breathing hot and low, embers ticking softly",
     "a cloven hoof striking scorched ground, a hard step with an ember hiss",
     "an ash demon snarling low with a rising crackle of fire, menacing",
     "an ash demon striking with a roaring snarl and a burst of flame"),
    ("diablo_2", "a fire demon breathing deep, flames guttering softly",
     "a heavy cloven hoof on hot stone, one hard step with a flame flare",
     "a fire demon growling with fire building and roaring, angry",
     "a fire demon striking with a deep roar and a hard flame burst"),
    ("snow_demon", "a frost wraith breathing out cold, a thin hollow wind and ice ticking",
     "a light step over deep snow, a muffled crunch with a cold gust",
     "a frost wraith shrieking softly and rising, cold and hateful",
     "a frost wraith striking with a piercing icy shriek and a frozen crack"),
    ("dark_donkey", "a dark beast of burden snorting and huffing softly, harness leather creaking",
     "one heavy hoof striking packed earth, a solid dull clop",
     "a dark mule braying low and angry, snorting hard and stamping",
     "a dark mule kicking out with a harsh bray and a heavy hoof crack"),
    ("saber_toothed_tiger", "a big cat breathing deep and slow, a low resting rumble",
     "a big cat paw padding down soft and heavy, a muffled thud",
     "a big cat growling low and rising into a snarl, dangerous",
     "a big cat lunging with a roaring snarl and a heavy fanged snap"),
    ("mammoth", "an enormous woolly beast breathing deep and slow, a faint low rumble",
     "one enormous foot planting on hard ground, a deep booming thud",
     "an enormous beast trumpeting low and angry, huffing hard",
     "an enormous beast slamming its tusks forward with a trumpeting roar"),
]
VOCAL_STYLE = "clean close-miked creature vocalisation, one isolated animal sound, dry"
STEP_STYLE = "clean close-miked foley, natural, one isolated sound"
for _id, _idle, _walk, _angry, _attack in MONSTERS:
    for _state, _brief, _dur, _trim, _style in (
        ("idle", _idle, 0.9, None, VOCAL_STYLE),
        ("walk", _walk, 0.6, 600, STEP_STYLE),
        ("angry", _angry, 1.1, None, VOCAL_STYLE),
        ("attack", _attack, 0.8, None, VOCAL_STYLE),
    ):
        _spec: dict = {
            "brief": _brief,
            "style": _style,
            "duration_s": _dur,
            "variants": ["standard take"],
            "takes": 1,
            "pool": 1,
        }
        if _trim:
            _spec["max_ms"] = _trim
        SETS[f"mon_{_id}_{_state}"] = _spec

# ---- ROUND 13 (maintainer 2026-08-06): "Can you generate 20 level up sounds".
# Twenty, and the variety is in the SHAPE and the MOOD — not in twenty more
# instruments. Round 7 already gave him ten warm acoustic level-ups (strings,
# lute, flute, organ, voices, whistle, accordion, marimba, bowl, handdrum) and
# every one of them was the same gesture: a phrase RISING and RESOLVING
# BRIGHTLY. Ten timbres of one idea. He kept none of them and asked again, so
# the timbre was not what was missing.
#
# So each brief below fixes a different ARRIVAL: a two-note call answered from
# far off, a single tone blooming with no melody at all, a flourish that stops
# dead on its top note, a sweep that lands DOWN instead of up, a shimmer that
# decays instead of holding, a tender resolve that is not triumphant. Two are
# not music at all — the reward as an OBJECT (a chest latch, a quench) — which
# twelve musical takes cannot be compared against until one exists.
#
# Held from the keep list: warm and ACOUSTIC (he kept harp + choir), and NO
# bright struck metal — bells, chimes, glockenspiel and gong lost every time
# they were tried, so nothing here is struck metal ringing out.
LEVEL_UP_R13: list[tuple] = [
    # Sacred / radiant — the lane his two keepers (harp, choir) came from,
    # given three colours it has not had rather than a fourth choir.
    ("hymn", "low men's voices holding one solemn note, then opening upward together into a bright wide chord in a stone cathedral", 2.2, None),
    ("glassbloom", "a single glass harmonica tone blooming out of silence, swelling wide and pure and holding, no melody", 2.4, None),
    ("sunrise", "a wide warm orchestral swell, soft strings underneath opening out into one clear sustained horn", 2.4, None),
    # Folk / celebratory — the pastoral world's own music, and the only
    # rhythmic entries in the round.
    ("fiddle", "a quick folk fiddle flourish dancing upward and stopping dead on the top note, bright and confident", 1.4, None),
    ("tambourine", "a bright tambourine shake bursting into a short round of happy hand claps, then silence", 1.5, None),
    ("panpipes", "a breathy pan pipe call of two notes, answered a moment later by the same two notes higher and softer", 2.0, None),
    ("hurdygurdy", "a hurdy-gurdy drone brightening and blooming into one warm major chord, earthy and folk", 1.8, None),
    # Plucked / intimate — harp's cousins, deliberately sparse. A level-up
    # does not have to be loud to feel earned.
    ("kalimba", "a few soft kalimba notes climbing gently, the last one left alone to ring out and fade", 2.0, None),
    ("dulcimer", "a hammered dulcimer cascade tumbling quickly upward and shimmering away into nothing", 1.8, None),
    ("koto", "a koto swept fast upward then landing hard on one low warm note that rings and settles", 1.8, None),
    ("nylon", "gentle nylon guitar harmonics arpeggiating slowly upward, unhurried and tender, not triumphant", 2.0, None),
    # Wind / breath — air moving, from a toy-simple phrase to a horn heard
    # across a valley.
    ("ocarina", "three clear round ocarina notes rising simply, the last one held steady and warm", 1.6, None),
    ("horn", "a warm hunting horn calling two lifting notes from far across open country, wide natural air around it", 2.2, None),
    ("reed", "a soft double reed swelling slowly from nothing into a warm blooming held tone, earthy, no melody", 2.0, None),
    # Elemental / magical — the level-up as something HAPPENING to you rather
    # than something played for you.
    ("emberrise", "a soft warm whoosh of air rising upward and blooming into a gentle shimmering ring", 1.8, None),
    ("waterbloom", "water swelling upward and opening into a bright sparkling resolve, liquid and clean", 1.8, None),
    ("growth", "leaves and stems unfurling and growing fast, a green organic rustle settling onto one soft warm chord", 2.0, None),
    ("windgift", "a warm gust of wind rushing past and lifting away into one bright clear held tone", 1.8, None),
    # Diegetic — no music at all. The reward as a physical event, so there is
    # finally something to compare the eighteen musical takes against.
    ("chestlatch", "a heavy iron chest latch releasing with a solid clunk and the wooden lid lifting open, a soft warm tone glowing underneath", 2.0, None),
    ("forgequench", "red hot steel plunged into water, a fierce hiss settling down into one low warm ring", 2.0, None),
]
ALTERNATIVES.setdefault("level_up", []).extend(LEVEL_UP_R13)

# ---- ROUND 14 (maintainer 2026-08-06): "more sounds for the cross on. I'm
# happy with cross off, but need something similar to cross off to put on cross
# on. It sounds like something is coming up from the earth. almost as the earth
# cracks in a way."
#
# READ THE SOUND HE KEPT, not the category. cross_off is monster_die_twigs —
# "a dry crunching collapse, a nest of twigs giving way" — and he plays it at
# PITCH 1.85, nearly double speed. So what he actually likes is DRY, BRITTLE,
# FAST and CRISP. Every existing cross_rise_* brief is the opposite: "heavy
# damp garden soil", "thick roots and DAMP soil", "packed soil pushing apart",
# "thick mud". Eleven damp risers is why none of them is his cross_on.
#
# So: no mud, no damp, no wet anywhere in this round. The ground is dry and it
# CRACKS. The variety is in what cracks (baked earth, clay, slate, shale, frost,
# bark, husk, ash, terracotta, sand crust) and in how much weight is underneath
# — a rise needs something heavy pushing, or it is just debris.
#
# Named cross_on_* rather than cross_rise_* so the wiki groups them under the
# event he actually reads (CROSS ON), separate from the eleven damp ones.
# Short, because he will pitch them up: 0.9-1.3 s renders to roughly half that
# at the 1.85 he already likes.
CROSS_ON_R14: list[tuple] = [
    ("earthcrack", "dry hard-baked earth splitting open, one sharp tearing crack running away along the ground", 1.0, None),
    ("crustsplit", "a dry crust of soil breaking apart as something heavy pushes up from underneath", 1.1, None),
    ("stoneheave", "a flat stone slab cracking and tilting up out of dry ground, grit showering off it", 1.2, None),
    ("claysnap", "sun-dried clay ground snapping apart into hard plates", 0.9, None),
    ("rootburst", "dry roots snapping fast one after another as something bursts upward through them", 1.0, None),
    ("gravelspill", "dry gravel thrown upward and raining back down onto stone", 1.1, None),
    ("timberrise", "a wooden post shouldering up through dry ground, a woody groan under a sharp crack", 1.2, None),
    ("frostheave", "frozen ground cracking and lifting, brittle ice splintering inside the soil", 1.1, None),
    ("slateshatter", "thin slate splitting upward into sharp brittle plates", 0.9, None),
    ("barkpush", "dry bark splitting apart as something forces its way out through it", 1.0, None),
    ("driftwood", "dry driftwood cracking free and lifting out of packed sand", 1.1, None),
    ("husksplit", "a big dry husk splitting open and something pushing out of it", 1.0, None),
    ("sticksnap", "a fast run of dry sticks snapping upward one after another", 0.9, None),
    ("shale", "layered shale cracking and sliding apart as the ground opens", 1.1, None),
    ("groundgroan", "the ground opening with a sharp surface crack over a deep low groan underneath", 1.3, None),
    ("ashcrust", "a dry ash crust cracking and lifting, fine powder sifting down off it", 1.1, None),
    ("terracotta", "a fired clay tile cracking and rising, a hard bright ceramic snap", 0.9, None),
    ("thornrise", "dry thorny brush tearing upward and pulling free of the ground", 1.0, None),
    ("sandcrust", "a sun-baked sand crust breaking upward, dry grains sheeting off the edges", 1.1, None),
    ("boneyard", "dry ground opening with a hard brittle crack and a heavy slow push rising under it", 1.3, None),
]
for _suffix, _brief, _dur, _trim in CROSS_ON_R14:
    SETS[f"cross_on_{_suffix}"] = {
        "brief": _brief,
        "style": "clean close-miked foley, natural, one isolated sound, dry",
        "duration_s": _dur,
        "variants": ["standard take"],
        "takes": 1,
        "pool": 1,
    }

# ---- ROUND 15 (maintainer 2026-08-06): "I need 30 new sounds. Same cross on.
# Maybe a little dirt or grass or something. It's coming up from the ground.
# Not to extreme. This sound is played after each enemy kill and is important."
#
# THE REPETITION IS THE BRIEF. This fires on EVERY kill, so it is heard more
# than any other one-shot in the game — and a sound you hear a hundred times an
# hour has to be modest or it turns into a headache. Round 14 chased the dry
# CRACK of his cross_off and delivered sharp brittle transients; "not to
# extreme" is him telling me that a hard crack per kill is too much. So:
#   - SOFT and SHORT (0.5-0.9 s). No dramatic snap, no big spike, nothing that
#     demands attention. It should read as texture, not as an event.
#   - DIRT AND GRASS, which he asked for by name — loose topsoil, turf, grass,
#     moss, leaf litter, straw, grit. Ground material, moving a little.
#   - STILL A RISE. Something pushes up and the ground gives way over it.
#   - Not the damp mud of the old cross_rise_* sets, and not round 14's
#     brittle cracks either: this sits between them, which is where he pointed.
CROSS_ON_R15: list[tuple] = [
    ("sod", "a square of turf lifting free, fine roots parting softly under it", 0.8, None),
    ("grasspart", "dry grass parting and springing back as something rises through it", 0.7, None),
    ("dirtshrug", "loose dry dirt shrugging upward and sliding off in a small heap", 0.7, None),
    ("turflift", "a patch of grassy turf easing up and settling back down, soft and low", 0.8, None),
    ("mossgive", "a soft pad of moss giving way and lifting, damp fibres letting go quietly", 0.8, None),
    ("leaflitter", "dry leaf litter stirring and sliding aside as the ground lifts under it", 0.7, None),
    ("pineneedles", "a soft bed of dry pine needles shifting apart from below", 0.7, None),
    ("strawpush", "loose straw pushed gently upward and spilling off to the sides", 0.7, None),
    ("barkchips", "dry bark chips shifting and tumbling off a small rising mound", 0.8, None),
    ("pebbleshift", "small pebbles rolling quietly off soil that is nudging upward", 0.8, None),
    ("topsoil", "dry topsoil breaking apart softly in fine crumbs as something lifts", 0.7, None),
    ("clod", "a clod of dry earth breaking loose and rolling gently away", 0.8, None),
    ("rootlift", "fine roots stretching and letting go one by one, small and soft", 0.9, None),
    ("grit", "dry grit sliding off a low mound and pattering down", 0.6, None),
    ("loam", "soft dark loam parting quietly from underneath, earthy and low", 0.8, None),
    ("thatch", "dry thatch and stalks lifting apart with a light papery rustle", 0.7, None),
    ("chaff", "light dry chaff pushed up and drifting off, airy and thin", 0.6, None),
    ("fernpush", "a low fern pushed up from beneath, fronds brushing and settling", 0.8, None),
    ("peat", "dry crumbling peat opening softly, fibrous and muted", 0.8, None),
    ("sandsift", "dry sand sifting off a small rise, a soft grainy whisper", 0.6, None),
    ("gravelnudge", "fine gravel nudged upward and trickling back down, small and unhurried", 0.7, None),
    ("twigmat", "a mat of small dry twigs lifting and crackling faintly, gentle not sharp", 0.7, None),
    ("cloverpull", "low clover and its shallow roots pulling softly out of soft ground", 0.8, None),
    ("dustpuff", "a soft puff of dry dust escaping as the ground opens a little", 0.6, None),
    ("stonelip", "a small flat stone tipping up at one edge, grit sliding off it", 0.7, None),
    ("earthsigh", "soil settling with a soft low exhale as something lifts beneath it", 0.9, None),
    ("crumbfall", "small crumbs of dry soil breaking away and falling back down", 0.6, None),
    ("weedroot", "a shallow weed and its root easing up out of loose dirt", 0.8, None),
    ("moundgive", "a small dry sandy mound giving way softly from below", 0.7, None),
    ("heather", "dry heather and low scrub brushing apart as the ground rises under it", 0.8, None),
]
for _suffix, _brief, _dur, _trim in CROSS_ON_R15:
    SETS[f"cross_on_{_suffix}"] = {
        "brief": _brief,
        # "not to extreme" lives in the style too — it is the one instruction
        # that has to survive every one of the thirty briefs.
        "style": "clean close-miked foley, natural, one isolated sound, dry, soft and understated, gentle",
        "duration_s": _dur,
        "variants": ["standard take"],
        "takes": 1,
        "pool": 1,
    }

# ---- ROUND 16 (maintainer 2026-08-06): "Generate 20 girl die in different
# styles and 20 die boy (also different styles)."
#
# The SAME twenty styles for both voices, deliberately. He is choosing a death
# cry for each hero and the useful comparison is like-for-like: die_girl_wail
# next to die_boy_wail tells him whether he wants a wail at all, and then which
# voice sells it. Twenty unrelated ideas per gender would make that impossible.
#
# The variety is the PERFORMANCE, not the timbre — a gasp, a defiant shout, a
# resigned sigh and a comic squeak are four different deaths, and which one the
# game wants is a tone decision only he can make. So the list spans quiet to
# loud and dignified to cartoon rather than clustering on "scream".
#
# Wording is deliberately restrained (collapses / gives out / falls), because
# the generator's moderation refuses graphic phrasing outright — a refused
# brief costs the whole take. Adults only, for the same reason: child-voice
# wording is blocked (learned when die_voice_boy was first written).
DIE_STYLES: list[tuple] = [
    ("gasp", "a sharp startled gasp, then nothing", 1.0),
    ("cryout", "one short cry, cut off abruptly", 1.0),
    ("wail", "a long falling wail fading away to nothing", 2.2),
    ("groan", "a low pained groan sinking away", 1.6),
    ("whimper", "a small broken whimper trailing off", 1.4),
    ("defiant", "a defiant shout that breaks and stops short", 1.4),
    ("yelp", "a startled high yelp, very brief", 0.8),
    ("winded", "all the air driven out at once in a voiceless huff", 1.0),
    ("sigh", "a long resigned sigh, letting go", 2.0),
    ("sob", "one choked sob, swallowed halfway", 1.2),
    ("scream", "a short scream falling in pitch as it fades", 1.6),
    ("softoh", "a quiet surprised oh, almost gentle", 1.0),
    ("grunt", "one hard grunt and then silence", 0.8),
    ("rattle", "a slow rattling exhale, the last breath going out", 2.0),
    ("inhale", "a sharp inhale caught in the throat, then silence", 1.0),
    ("operatic", "a theatrical operatic falling cry, grand and drawn out", 2.2),
    ("comic", "a comic exaggerated cartoon squeak of defeat", 0.9),
    ("stoic", "one short controlled grunt, no drama at all", 0.8),
    ("moan", "a drawn out weary moan giving way", 1.8),
    ("call", "a wordless call out to someone, fading as it goes", 2.0),
]
DIE_VOICES = [
    ("girl", "a young woman"),
    ("boy", "an adult man"),
]
for _who, _person in DIE_VOICES:
    for _suffix, _perf, _dur in DIE_STYLES:
        SETS[f"die_{_who}_{_suffix}"] = {
            "brief": f"{_person} collapsing: {_perf}",
            "style": "clean close-miked human vocalisation, one isolated voice, dry, no words, no music",
            "duration_s": _dur,
            "variants": ["standard take"],
            "takes": 1,
            "pool": 1,
        }

# Sets whose EVERY take the Game Master rejected in the wiki (2026-08-06).
# The takes and folders are deleted; the briefs stay only as the record of
# what was tried, and a bare `generate.py` skips them so nobody resurrects a
# sound he already turned down by running the pipeline with no arguments.
# Naming one on the command line still generates it — that is the deliberate
# act. `thunder` is NOT here on purpose: its set was rejected too, but
# lightning has no wiki-assignable event, so regenerating that set is the
# only route back and a plain run should still attempt it.
REJECTED_SETS = {
    "hit_taken", "kick", "punch", "monster_hit", "monster_die", "player_die",
    "cross_rise", "cross_sink", "item_pickup", "item_drop", "sand", "ui_cancel",
}

for _action, _alts in ALTERNATIVES.items():
    for _suffix, _brief, _dur, _trim in _alts:
        _spec: dict = {
            "brief": _brief,
            "style": "clean close-miked foley, natural, one isolated sound",
            "duration_s": _dur,
            "variants": ["standard take"],
            "takes": 1,
            "pool": 1,
        }
        if _trim:
            _spec["max_ms"] = _trim
        SETS[f"{_action}_{_suffix}"] = _spec


# ---- minimal decode + mastering (port of the sound domain's recipe) ----

def _ffmpeg_decode(raw: bytes) -> np.ndarray:
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg needed to decode compressed audio")
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(SR),
         "-f", "s16le", "pipe:1"],
        input=raw, capture_output=True,
    )
    if p.returncode != 0:
        # Surface WHAT the API actually sent (ui_cancel failed twice on a
        # payload ffmpeg rejects — the head bytes identify json errors etc).
        raise RuntimeError(
            f"ffmpeg decode failed (rc={p.returncode}, {len(raw)} bytes, "
            f"head={raw[:60]!r}, stderr={p.stderr[:120]!r})"
        )
    return np.frombuffer(p.stdout, dtype="<i2").astype(np.float32) / 32768.0


def _decode(raw: bytes, fmt: str) -> np.ndarray:
    # SNIFF the actual payload — never trust the requested format. Run 2
    # requested pcm_48000 in the BODY (the API wants it as a query param),
    # got mp3 back, and the byte-blind pcm decode turned every take into
    # identical-length garbage noise. Container magic wins over `fmt`.
    is_mp3 = raw[:3] == b"ID3" or (len(raw) > 1 and raw[0] == 0xFF and (raw[1] & 0xE0) == 0xE0)
    if raw[:4] == b"RIFF" or is_mp3:
        x = _ffmpeg_decode(raw)
    elif fmt.startswith("pcm_"):
        x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        # A raw pcm payload carries NO header, so its rate is whatever we asked
        # for in the query string — resample anything that is not our own SR,
        # or the take plays sharp and short (pcm_44100 read as 48 kHz is 8.9%
        # sharp, which is inside any sane length tolerance and would pass
        # silently as "honest").
        rate = int(fmt.split("_")[1])
        if rate != SR and x.size:
            n = int(round(x.size * SR / rate))
            x = np.interp(np.linspace(0, x.size - 1, n), np.arange(x.size), x).astype(np.float32)
    else:
        x = _ffmpeg_decode(raw)
    if x.size < SR * 0.05:
        raise RuntimeError(f"decoded audio too short ({x.size} samples) — bad payload?")
    return x


def _features(x: np.ndarray) -> dict:
    """Objective QA features (round 3: the composer can't listen, so it
    MEASURES). tonality = normalized autocorrelation peak in the 80-2000 Hz
    pitch band over 250ms after the main peak — a piano-like ring scores
    high, real foley scores low. tail_ratio = energy after 400ms / total —
    a texture bed scores high, a discrete impact scores low."""
    n = x.size
    ax = np.abs(x)
    peak = float(np.max(ax)) or 1e-9
    rms = float(np.sqrt(np.mean(x ** 2))) or 1e-9
    peak_idx = int(np.argmax(ax))
    i400 = int(SR * 0.4)
    tail_ratio = float(np.sum(x[i400:] ** 2) / (np.sum(x ** 2) + 1e-12)) if n > i400 else 0.0
    seg = x[peak_idx : peak_idx + int(SR * 0.25)].astype(np.float64)
    tonality = 0.0
    if seg.size > int(SR / 80):
        seg = seg - seg.mean()
        f = np.fft.rfft(seg, 2 * seg.size)
        ac = np.fft.irfft(f * np.conj(f))[: seg.size]
        if ac[0] > 0:
            lo, hi = int(SR / 2000), min(int(SR / 80), seg.size - 1)
            if hi > lo + 1:
                tonality = float(np.max(ac[lo:hi]) / ac[0])
    spec = np.abs(np.fft.rfft(x))
    freqs = np.fft.rfftfreq(n, 1 / SR)
    centroid = float(np.sum(spec * freqs) / (np.sum(spec) + 1e-12))
    # Small-speaker audibility: the first thunder set measured 100% of its
    # energy BELOW 150 Hz — physically silent on phone/laptop speakers at
    # any gain (maintainer heard rain, never thunder). Whole-clip energy
    # fraction misjudges a short crack against a long roll, so measure the
    # LOUDEST 300ms of the 150-4000 Hz band instead: was there ever a
    # moment a small speaker could reproduce?
    power = spec ** 2
    mid = float(np.sum(power[(freqs >= 150) & (freqs < 4000)]) / (np.sum(power) + 1e-12))
    fspec = np.fft.rfft(x)
    fspec[(freqs < 150) | (freqs >= 4000)] = 0
    band = np.fft.irfft(fspec, n)
    win = max(1, int(SR * 0.3))
    csum = np.concatenate(([0.0], np.cumsum(band.astype(np.float64) ** 2)))
    win_rms = np.sqrt(np.max(csum[win:] - csum[:-win]) / win) if n > win else float(np.sqrt(np.mean(band ** 2)))
    mid_peak_db = 20 * np.log10(max(win_rms, 1e-9))
    return {
        "mid_peak_db": round(float(mid_peak_db), 1),
        "duration_s": round(n / SR, 3),
        "attack_ms": round(peak_idx / SR * 1000, 1),
        "tail_ratio": round(tail_ratio, 3),
        "tonality": round(tonality, 3),
        "crest": round(peak / rms, 2),
        "centroid_hz": round(centroid),
        "mid_ratio": round(mid, 3),
    }


# Acceptance gates per judge kind: {feature: (min, max, penalty_weight)}.
# CALIBRATED ON THE HUMAN-APPROVED REFERENCE: all four liked stone takes
# must PASS the step gates (measured tonality up to 0.93 — a hard tap on
# rock IS slightly pitched, and the maintainer likes it; the enemy of a
# footstep is the texture BED: high tail_ratio, low crest). For clicks the
# enemy IS tonality ("piano"), so the gate kills flagrant ring and the
# ranking prefers the least tonal candidate.
GATES: dict[str, dict[str, tuple[float, float, float]]] = {
    "step": {
        "tail_ratio": (0.0, 0.30, 40),
        "crest": (6.0, 99.0, 2),
        "tonality": (0.0, 0.95, 30),
    },
    # ⚠️ THE CLICK GATE DOES NOT PREDICT THE MAINTAINER'S UI VERDICTS.
    # Measured 2026-08-06 against every UI take he has ruled on, by playing
    # his own kept/rejected lists back through this feature:
    #   KEPT     0.238 0.276 0.429 (ui_tick) · 0.239 0.252 (ui_confirm)
    #   REJECTED 0.000 0.268 0.340 0.352 (ui_cancel) · 0.250 0.251
    #            (ui_confirm) · 0.397 (ui_tick)
    # The two ranges OVERLAP almost entirely. This gate would have PASSED
    # SEVEN OF SEVEN takes he threw away — including ui_cancel take01, which
    # measures a perfect 0.000 and which he rejected anyway — while FAILING
    # ui_tick take04, which he kept. Zero discriminating power on the only
    # judgement that matters.
    # This is the same lesson the `grain` gate learned about metal: tonality
    # measures a real thing (piano-like ring) that simply is not what makes a
    # click good or bad to him. So DO NOT use it to pick a UI candidate for
    # him, and do not report its verdict as a quality signal — a pool + this
    # judge gives the model more attempts and a deterministic tie-break, and
    # that is ALL it gives. The ear decides; it always did.
    "click": {
        "tonality": (0.0, 0.40, 60),
        "tail_ratio": (0.0, 0.15, 40),
        "crest": (5.0, 99.0, 2),
    },
    # Big atmospheric booms (thunder): MUST carry small-speaker-audible
    # mid-band energy, and the crack should land promptly (synced to the
    # lightning flash).
    "boom": {
        "mid_peak_db": (-28.0, 0.0, 3),
        "crest": (2.5, 99.0, 1),
        # ROUND 8: the crack has to land WITH the white flash, so a late
        # peak is a disqualification and not a ranking nudge. _tighten
        # anchors the cut 30 ms before the loudest sample and _master trims
        # in further, so a healthy candidate measures a handful of ms here;
        # anything past 60 ms means the loudest moment is NOT the crack
        # (a swell, a second rumble) and the sync would be lost.
        "attack_ms": (0.0, 60.0, 5),
    },
    # Granular steps (sand/gravel): the enemy is a sharp metallic SPIKE.
    # Sand is a SOFT crunch — low crest (a spike reads as a metallic tick;
    # the round-1 sand primary measured crest 18, spikier than a hard stone
    # tap) and no ring. High-frequency energy is FINE (grains hiss).
    # 'grain' = soft dull surfaces (sand/grass). THE metal fix (maintainer:
    # "why do we get metal steps all the time"): metal = BRIGHTNESS, not
    # spikiness/ring. Every approved footstep is warm (<2000 Hz centroid);
    # every 'metal' one measured 8000-12000 Hz. So a hard brightness cap.
    # Tonality relaxed — it does NOT predict metal (the loved jump sound is
    # 0.96 tonal but warm at 1235 Hz, and sounds perfect).
    # Only TWO real failure modes (learned the hard way): BRIGHT = metal,
    # and NO-TRANSIENT = tonal hum. Tonality itself does NOT predict quality
    # — the loved jump sound is 0.96 tonal AND warm AND has a thud, and it's
    # perfect. So: cap brightness, floor the transient, ignore tonality.
    "grain": {
        "centroid_hz": (0.0, 4000.0, 0.04),  # bright = tinny/metal
        "crest": (4.0, 16.0, 4),  # floor rejects transient-less hums; a real footfall thuds
        "tail_ratio": (0.0, 0.65, 10),
    },
    # Wet steps: candidates must be WETNESS-class (band-profile distance to
    # the known-watery splash reference — dry foley measures ~1.5-2.0, wet
    # ~0.7-0.9; 'door vs splash' inside the wet class is NOT measurable and
    # falls to the brief + the maintainer's ear on /#foley).
    "wet": {
        "ref_dist": (0.0, 1.1, 15),
        "tail_ratio": (0.0, 0.5, 20),
        "crest": (4.0, 99.0, 1),
    },
}

# Ranking among candidates (lower = better), per judge kind. Steps rank by
# dryness — NOT by low tonality, or crisp liked-style toks would lose to
# mushy thuds. Clicks rank hard by low tonality: the anti-piano selector.
RANK = {
    "step": lambda f: f["tail_ratio"] * 5 + f["tonality"] * 1,
    "click": lambda f: f["tonality"] * 10 + f["tail_ratio"] * 5,
    # Booms: strongest audible mid-band moment wins; early peak preferred
    # (the crack must land with the flash).
    "boom": lambda f: -f["mid_peak_db"] * 0.2 + f["attack_ms"] / 500,
    # Wet: most reference-like candidate wins.
    "wet": lambda f: f.get("ref_dist", 9.9) * 3,
    # Grain: softest (lowest crest) + least ringy wins — the anti-metal sort.
    "grain": lambda f: f["centroid_hz"] / 800 + abs(f["crest"] - 7) * 0.5,
}


def _judge(feat: dict, gates: dict[str, tuple[float, float, float]], kind: str) -> tuple[bool, float]:
    ok = True
    penalty = 0.0
    for key, (lo, hi, w) in gates.items():
        v = feat.get(key)
        if v is None:
            continue
        if v < lo:
            ok = False
            penalty += (lo - v) * w
        elif v > hi:
            ok = False
            penalty += (v - hi) * w
    return ok, penalty + RANK[kind](feat)


OCTAVE_BANDS = [(150, 300), (300, 600), (600, 1200), (1200, 2400), (2400, 4800), (4800, 9600)]


def _band_profile(x: np.ndarray) -> np.ndarray:
    """Log-energy per octave band, normalized — a compact spectral character
    fingerprint. Used to judge a candidate by SIMILARITY TO A REFERENCE
    sound (the wet-step lesson: 'door vs splash' is not separable by simple
    scalar features, but distance to a known-watery reference is)."""
    spec = np.abs(np.fft.rfft(x.astype(np.float64))) ** 2
    freqs = np.fft.rfftfreq(x.size, 1 / SR)
    e = np.array([spec[(freqs >= a) & (freqs < b)].sum() for a, b in OCTAVE_BANDS])
    e = np.log10(e + 1e-12)
    return e - e.mean()


def _ref_distance(x: np.ndarray, ref_profile: np.ndarray) -> float:
    return float(np.mean(np.abs(_band_profile(x) - ref_profile)))


def _load_ref_profile(repo_rel: str) -> np.ndarray:
    repo_root = FOLEY_DIR.parent.parent          # sounds/foley → repo root
    with wave.open(str(repo_root / repo_rel)) as w:
        raw = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
        x = raw.astype(np.float32) / 32768.0
        if w.getnchannels() == 2:
            x = x.reshape(-1, 2).mean(axis=1)
    return _band_profile(x)


def _tighten(x: np.ndarray, max_ms: float | None) -> np.ndarray:
    """Transient-anchored cut: keep from just before the strongest onset to
    max_ms after it. Round 2's enforcement of the stone-set lesson — a
    footstep is ONE discrete impact; if the model pads the clip with
    continuous texture, cut the step out of it instead of shipping the bed."""
    if max_ms is None or x.size == 0:
        return x
    # Anchor on the strongest peak with a short fixed pre-roll — threshold
    # onset-hunting latches onto the background texture floor instead.
    peak_idx = int(np.argmax(np.abs(x)))
    start = max(0, peak_idx - int(SR * 0.030))
    end = min(x.size, start + int(SR * max_ms / 1000))
    return x[start:end]


def _master(x: np.ndarray) -> np.ndarray:
    if x.size == 0:
        return x
    peak = float(np.max(np.abs(x))) or 1.0
    lead = np.where(np.abs(x) >= peak * 10 ** (-45 / 20))[0]
    tail = np.where(np.abs(x) >= peak * 10 ** (-60 / 20))[0]
    if lead.size and tail.size:
        x = x[max(0, lead[0] - int(SR * 0.006)):min(x.size, tail[-1] + int(SR * 0.04) + 1)]
    n_in = min(int(SR * 0.003), x.size // 2)
    n_out = min(int(SR * 0.015), x.size // 2)
    x = x.copy()
    if n_in:
        x[:n_in] *= np.sin(np.linspace(0, np.pi / 2, n_in)) ** 2
    if n_out:
        x[-n_out:] *= np.cos(np.linspace(0, np.pi / 2, n_out)) ** 2
    peak = float(np.max(np.abs(x))) or 1.0
    return np.clip(x * (10 ** (-1 / 20) / peak), -1.0, 1.0)


def _write_wav(x: np.ndarray, path: Path) -> float:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(np.int16(x * 32767).tobytes())
    return round(x.size / SR, 3)


def _fit_channels(x: np.ndarray, duration_s: float, fmt: str) -> np.ndarray:
    """Collapse a multi-channel raw-PCM payload that _decode read byte-blind.

    The pcm_* response has NO header, so _decode interprets the bytes as one
    mono stream. When the API actually sends STEREO, that read INTERLEAVES L
    and R into a single signal: exactly twice as long, every frequency an
    octave down, and nothing above half the true Nyquist. Measured across every
    set whose length is not cut in post, the decoded audio is 2.00x the
    duration we asked for — every single time — while `ui_tick`, the one set
    that fell back to the mp3 path (ffmpeg, `-ac 1`), is the only one carrying
    real energy above 12 kHz.

    THIS IS WHAT THE "vocal takes are authored at HALF SPEED, play them at RATE
    2.0" note was really seeing. It is not the model's authoring; it is this
    decode. The maintainer's ear was right (2.0 does give the true voice) and
    the diagnosis was wrong, which is why the compensation lived in the ENGINE
    and only for voices, while every other set quietly shipped an octave low.

    We do not have to be certain WHICH explanation is true, and that is the
    nice part: if the payload is stereo, averaging adjacent samples is the mono
    downmix; if it really were half-speed mono, averaging adjacent samples is
    decimation by two with anti-aliasing — i.e. exactly the rate-2.0 the
    maintainer approved. Both readings want the same operation. And we never
    have to GUESS the channel count, because we know what length we asked for.

    Only the raw-pcm branch can be wrong this way; ffmpeg paths already forced
    mono. Anything that is not a clean 2x or 4x is left alone and reported.
    """
    if not fmt.startswith("pcm_") or x.size == 0:
        return x
    ratio = (x.size / SR) / max(duration_s, 1e-6)
    k = int(round(ratio))
    if k < 2:
        return x
    if k not in (2, 4) or abs(ratio - k) > 0.25:
        print(f"  NOTE: decoded {ratio:.2f}x the requested length — not a clean "
              f"channel count, leaving the payload alone")
        return x
    n = (x.size // k) * k
    return x[:n].reshape(-1, k).mean(axis=1).astype(np.float32)


def _generate(session: requests.Session, prompt: str, duration_s: float) -> np.ndarray:
    """Fetch one candidate, PREFERRING whatever format comes back at full rate.

    THE 90s SOUND, DIAGNOSED (maintainer 2026-08-06: "some sounds you have
    generated are so extremely bad, like a game from the 90ths"). Every set in
    the library measures essentially ZERO energy above 12 kHz — dull, no top
    end, soft transients — with exactly one exception, `ui_tick`, which is the
    one set that fell back to the mp3 path and decodes through ffmpeg. And
    every un-trimmed set came back at exactly 2.00x the length we asked for.
    One payload is honest and full-band; the other arrives at half the rate we
    read it at, which halves the bandwidth and slurs every transient. That is
    the whole complaint, and it is not the model's fault.

    We do not have to know WHY the raw stream is half-rate (multi-channel
    interleave, a lower-rate payload than the query string asked for, a tier
    cap) because the length tells us it happened: we know what duration we
    requested. So take the first format whose decoded length MATCHES, and only
    fall back to collapsing a wrong-length stream if no format is honest —
    a correctly decoded 128k mp3 beats a decimated raw one, because decimation
    cannot restore a top octave that was never in the payload.
    """
    # output_format goes in the QUERY STRING — in the body the API silently
    # ignores it and returns mp3 (run 2's garbage-audio bug).
    duration_s = max(0.5, min(22.0, duration_s))  # API-enforced bounds; 0.4 → 400
    salvage: tuple[np.ndarray, float, str] | None = None
    r = None
    # Best first: lossless, then the highest-bitrate compressed fallback. The
    # ladder exists because ONE of these may come back honest while the others
    # do not, and which one that is depends on the account tier — measured
    # 2026-08-06, the 128k mp3 was the first honest format and it cliffs hard at
    # 16 kHz, so a lossless rung that turns out to be honest is a real gain.
    for fmt in (f"pcm_{SR}", "pcm_44100", "mp3_44100_192", "mp3_44100_128"):
        r = session.post(
            GEN_URL,
            params={"output_format": fmt},
            json={
                "text": prompt,
                "duration_seconds": duration_s,
                "prompt_influence": PROMPT_INFLUENCE,
                "loop": False,
                "model_id": MODEL_ID,
            },
            timeout=120,
        )
        if r.ok:
            x = _decode(r.content, fmt)
            ratio = (x.size / SR) / duration_s
            if 0.7 <= ratio <= 1.4:
                print(f"  format {fmt} (length {ratio:.2f}x)")
                return x  # honest, full-rate audio — this is what we want
            if salvage is None:
                salvage = (x, ratio, fmt)
            continue
        if r.status_code not in (400, 402, 403):  # format/tier issues → fallback
            r.raise_for_status()
    if salvage is not None:
        x, ratio, fmt = salvage
        print(f"  NOTE: every format returned {ratio:.2f}x the requested length "
              f"— collapsing the {fmt} stream (pitch and timing restored, "
              f"bandwidth is whatever the payload actually held)")
        return _fit_channels(x, duration_s, fmt)
    # Nothing usable: surface the API's reason (a 401 killed 95 sets of one
    # round while the workflow still reported success).
    raise RuntimeError(f"API {r.status_code if r is not None else '?'} for both formats: "
                       f"{r.text[:200] if r is not None else ''}")


def main() -> int:
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        print("ELEVENLABS_API_KEY not set — refusing to run (no low-fi fallbacks).")
        return 1
    wanted = sys.argv[1:] or [n for n in SETS if n not in REJECTED_SETS]
    session = requests.Session()
    session.headers.update({"xi-api-key": key})

    manifest_path = FOLEY_DIR / "foley.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    done: list[str] = []
    failed: list[str] = []
    for name in wanted:
        spec = SETS.get(name)
        if not spec:
            print(f"unknown set {name!r} (have: {', '.join(SETS)})")
            continue
        # One bad set must not zero out the whole run (run 2: ui_tick's 400
        # threw away nine already-generated sets) — isolate per set, commit
        # whatever succeeded.
        try:
            out_dir = FOLEY_DIR / name
            out_dir.mkdir(parents=True, exist_ok=True)
            variants = spec["variants"]
            n_takes = spec.get("takes", TAKES)
            # Round 3: generate a candidate POOL, measure every candidate,
            # ship only the best n_takes. Blind generation → selection.
            pool_n = max(n_takes, spec.get("pool", n_takes))
            gates = GATES.get(spec.get("judge", ""))
            ref_profile = _load_ref_profile(spec["ref"]) if "ref" in spec else None
            cands: list[tuple[bool, float, np.ndarray, dict]] = []
            for i in range(pool_n):
                # A set may override the shared STYLE with its own (positive,
                # per the maintainer's negative-prompt-backfire insight).
                style = spec.get("style", STYLE)
                prompt = f"{spec['brief']}, {variants[i % len(variants)]}. {style}"
                if len(prompt) > MAX_PROMPT_CHARS:
                    # The API rejects >450 chars (text_too_long). Drop the
                    # shared STYLE suffix — the brief carries the intent.
                    prompt = f"{spec['brief']}, {variants[i % len(variants)]}."[:MAX_PROMPT_CHARS]
                    if i == 0:
                        print(f"  NOTE: {name} prompt trimmed to fit {MAX_PROMPT_CHARS} chars")
                # Candidate-level isolation: one corrupt payload must not
                # kill the whole set (ui_cancel died twice on candidate 1).
                try:
                    x = _master(_tighten(_generate(session, prompt, spec["duration_s"]), spec.get("max_ms")))
                except Exception as ce:  # noqa: BLE001
                    print(f"{name} cand {i + 1}/{pool_n}: GENERATION FAILED — {ce}")
                    time.sleep(0.6)
                    continue
                feat = _features(x)
                if ref_profile is not None:
                    feat["ref_dist"] = round(_ref_distance(x, ref_profile), 2)
                ok, score = _judge(feat, gates, spec["judge"]) if gates else (True, 0.0)
                cands.append((ok, score, x, feat))
                print(f"{name} cand {i + 1}/{pool_n}: {'PASS ' if ok else 'REJECT'} {feat}")
                time.sleep(0.4)  # be polite to the API
            if not cands:
                raise RuntimeError("every candidate failed to generate")
            cands.sort(key=lambda c: (not c[0], c[1]))
            chosen = cands[:n_takes]
            passed = sum(1 for c in chosen if c[0])
            if passed < n_takes:
                print(f"  WARNING: only {passed}/{n_takes} shipped takes pass the {spec.get('judge')} gates")
            takes = []
            for i, (_ok, _score, x, feat) in enumerate(chosen):
                path = out_dir / f"{name}__take{i + 1:02d}.wav"
                dur = _write_wav(x, path)
                takes.append({"file": f"{name}/{path.name}", "duration_seconds": dur, "features": feat})
            # Keep the WHOLE pool (sorted best-first) for the human audition
            # page (/#foley): the maintainer listens and names winners, the
            # composer promotes them — measurable gates can't judge material
            # realism, ears can.
            pool_meta = []
            if pool_n > n_takes:
                pool_dir = out_dir / "pool"
                pool_dir.mkdir(exist_ok=True)
                for old in pool_dir.glob("*.wav"):
                    old.unlink()
                for j, (ok_j, score_j, x_j, feat_j) in enumerate(cands):
                    ppath = pool_dir / f"{name}__cand{j + 1:02d}.wav"
                    _write_wav(x_j, ppath)
                    pool_meta.append({
                        "file": f"{name}/pool/{ppath.name}",
                        "passed_gates": ok_j,
                        "rank": round(score_j, 2),
                        "features": feat_j,
                    })
            manifest[name] = {
                "takes": [t["file"] for t in takes],
                "durations_s": [t["duration_seconds"] for t in takes],
                "features": [t["features"] for t in takes],
                "qa": {"judge": spec.get("judge"), "pool": pool_n, "passed_gates": passed, "of": n_takes},
                "pool_candidates": pool_meta,
                "brief": spec["brief"],
                "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "model_id": MODEL_ID,
            }
            manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
            done.append(name)
        except Exception as e:  # noqa: BLE001 — isolate, report, continue
            print(f"FAILED set {name}: {e}")
            failed.append(name)
    print(f"generated: {', '.join(done) or 'none'}; failed: {', '.join(failed) or 'none'}")
    print(f"manifest → {manifest_path}")
    # A RUN THAT MOSTLY FAILED MUST GO RED. `0 if done else 1` meant one
    # surviving set out of a hundred still reported SUCCESS — which is exactly
    # what happened on 2026-08-06: the API key began returning 401 seven sets
    # into a 102-set round, 95 sets failed, the workflow went green, the bot
    # committed the seven and dispatched a deploy, and the only way to notice
    # was to count folders by hand. Whatever succeeded is still committed (a
    # partial round is worth keeping), but the exit code now tells the truth.
    if failed:
        share = len(failed) / max(1, len(done) + len(failed))
        print(f"FAILED {len(failed)}/{len(done) + len(failed)} sets ({share:.0%})")
        if share > 0.10:
            print("more than a tenth of the run failed — exiting non-zero so the run goes RED")
            return 1
    return 0 if done else 1


if __name__ == "__main__":
    raise SystemExit(main())
