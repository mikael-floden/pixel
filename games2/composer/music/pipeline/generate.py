#!/usr/bin/env python3
"""Generate the composer's OWN score (ElevenLabs Music, music_v1).

ALL OF THE GAME'S AUDIO IS THIS AGENT'S (maintainer 2026-08-08: "You have the
entire responsibility for much music and sound right now") — sounds/, music/
and games2/composer/ alike. The line that used to sit here, "this does NOT
touch the music/ domain (another agent owns that)", is why the DAY BED, the
most-heard music in the game, was left out of the sequenceable rewrite. Do not
reintroduce that hedge. Tracks here are committed under games2/composer/music/
and bundled by Vite (engine/contextMusic.ts).

THE SEVEN BEDS — one per thing the player can be doing:

    title      the character-select login theme
    adventure  the default overworld exploring bed (heard the most)
    town       village / market / farmland
    cave       underground
    home       at the spawn bonfire — safe, you belong here
    battle     monsters closing in
    night      the mystical night overworld bed

HOW THIS RUNS (and why it is not just one POST):

  1. /v1/music/plan first — a COMPOSITION PLAN (ordered sections with exact
     durations + per-section style). Composing FROM a plan gives structural
     control a flat prompt cannot, and hands us the section timeline for free.
     Falls back to the raw prompt if the endpoint says no.
  2. Several CANDIDATES per track, ranked by MEASURED quality (master.measure)
     — the same pool-and-gate approach that finally produced good foley. A
     model take is a roll of the dice; picking by ear-proxy metrics beats
     accepting the first roll.
  3. The winner is MASTERED (master.py): loudness-matched to a shared target so
     beds cross-fade without a volume jump, true-peak safe, dead air trimmed,
     and its best LOOP POINTS measured.
  4. Delivered as .ogg (opus) + .m4a (AAC) — every browser covered, ~40%
     smaller than the mp3 it replaces. Everything measured lands in tracks.json.

Run:  python games2/composer/music/pipeline/generate.py <track|new|all> [seconds]
        new = the five context beds (town cave home battle adventure)
Needs ELEVENLABS_API_KEY (a GitHub secret in composer-theme.yml).

CAREFUL — two ways to get a hard rejection, both learned the hard way:
  * NAMING REAL IP OR ARTISTS is a ToS block (400 bad_prompt). Describe the
    STYLE and the FEELING only, never "sounds like <game/composer/studio>".
  * NEGATIVE PROMPTS BACKFIRE ("no metal, no crunch") — the generator weights
    the very words you forbid. Say what you DO want.
"""

from __future__ import annotations

import json
import os
import sys
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import master as M

API_ROOT = "https://api.elevenlabs.io/v1"
PLAN_URL = f"{API_ROOT}/music/plan"
MUSIC_URL = f"{API_ROOT}/music"
SUB_URL = f"{API_ROOT}/user/subscription"
MODEL_ID = "music_v1"
MUSIC_DIR = Path(__file__).resolve().parents[1]
TRACKS_JSON = MUSIC_DIR / "tracks.json"
# Every generation ever made, never overwritten — his swap-it-back library.
POOL_DIR = MUSIC_DIR / "pool"

# Leave this many credits for the sound/music agents (shared account).
CREDIT_FLOOR = 20_000

TRACKS: dict[str, dict] = {
    # ---- the character-select login theme (APPROVED — do not re-roll casually)
    "title": {
        "out": "title",
        "seconds": 95,
        "bpm": 92,
        "prompt": (
            "A sweeping, nostalgic orchestral fantasy game title theme — a grand "
            "adventure about to begin and the warmth of coming home, at once. It "
            "OPENS IMMEDIATELY with the main melody already singing in the first "
            "two seconds — no silent or ambient lead-in, no abrupt start. A proud, "
            "hopeful, memorable folk melody on tin whistle, flute and fiddle, "
            "answered by warm strings and a noble French horn; harp, piano and "
            "light glimmering bells underneath. Pastoral hearth-and-home warmth "
            "with the uplifting swell of a great journey — cinematic and heartfelt, "
            "with gentle FORWARD MOMENTUM and a light walking pulse, NOT a slow "
            "lullaby. Builds to a hopeful, soaring climax, then settles for a "
            "seamless loop. Warm, magical, timeless, adventurous. Around 92 BPM, "
            "major key, rich orchestration, no heavy percussion, no vocals with "
            "words, no sound effects. A title screen that makes you want to set "
            "out on an adventure."
        ),
    },
    # ---- the night overworld bed (APPROVED)
    "night": {
        "out": "night",
        "seconds": 95,
        "bpm": 62,
        "prompt": (
            "A mysterious, enchanted nocturnal theme for a moonlit magical forest "
            "at night — glowing wisps and fireflies drifting between vast ancient "
            "trees, hushed and dreamlike. Soft ethereal choir pads, gentle celesta "
            "and glass-bell shimmers, a slow distant harp, and a lone soft flute or "
            "ocarina breathing a simple, haunting, memorable melody over warm low "
            "strings. Wonder tinged with mystery and a little magic — calm, "
            "spacious, slightly otherworldly, NEVER scary or dissonant. Slow and "
            "floating, tender, a seamless gentle loop that never fatigues. "
            "Minor-tinged but hopeful, around 62 BPM, very soft dynamics, no heavy "
            "percussion, no vocals with words, no sound effects. The feeling of "
            "wandering a glowing enchanted forest under the stars."
        ),
    },
    # ---- THE FIVE NEW CONTEXT BEDS ------------------------------------------
    # The default. Heard more than everything else combined, so the bar is
    # "beautiful on the two-hundredth loop", not "impressive once".
    "adventure": {
        "out": "adventure",
        "seconds": 120,
        "bpm": 96,
        "prompt": (
            "A wide-open orchestral fantasy exploring theme for travelling across "
            "a beautiful green world — rolling meadows, distant blue mountains, the "
            "road ahead. It STARTS PLAYING AT ONCE with a warm string bed and a "
            "walking pulse already moving. A curious, hopeful flute and tin-whistle "
            "melody trades phrases with a noble horn; harp and plucked strings keep "
            "a light travelling rhythm; soft cellos underneath. The feeling is "
            "WONDER AND FORWARD MOTION — the joy of seeing what is over the next "
            "hill — bright, generous, uncomplicated, never tense and never grand or "
            "triumphant (this is the journey, not the arrival). It breathes: it "
            "rises gently, then opens out and lets the strings carry alone, so it "
            "stays fresh for hours on repeat. Around 96 BPM, major key, light "
            "brushed percussion only, spacious mix, seamless loop. Instrumental."
        ),
    },
    # A place with PEOPLE in it. The contrast against the empty overworld is the
    # whole point — busier, closer-miked, sociable.
    "town": {
        "out": "town",
        "seconds": 105,
        "bpm": 108,
        "prompt": (
            "A warm, bustling medieval fantasy village theme — a market square on a "
            "sunny morning, stalls and neighbours and cheerful business. It OPENS "
            "STRAIGHT INTO the tune. A lively, sociable folk melody on fiddle and "
            "pennywhistle over a strummed lute or acoustic guitar, with accordion "
            "and hammered dulcimer answering, a bouncing plucked bass line and light "
            "hand percussion — tambourine, soft frame drum, the odd wooden clack. "
            "Round-dance rhythm, gently swung, communal and welcoming — the sound of "
            "belonging somewhere friendly. Cheerful and homely, never grand, never "
            "orchestral-epic, never comic. Keeps a relaxed pace so it can play for a "
            "long while without tiring. Around 108 BPM, major key, warm acoustic "
            "recording, seamless loop. Instrumental."
        ),
    },
    # Space is the instrument here. The risk is generating "horror"; the brief
    # steers to AWE (a vast cathedral of stone) and stays consonant.
    "cave": {
        "out": "cave",
        "seconds": 110,
        "bpm": 58,
        "prompt": (
            "A vast, hushed underground theme for enormous echoing caverns deep "
            "under a mountain — cathedral spaces of wet stone, still black pools, "
            "faint glimmering crystal. It BEGINS IMMEDIATELY on a deep sustained "
            "low string drone. Very sparse and patient: single soft marimba and "
            "prepared-piano notes falling into a long natural reverb like drips into "
            "water, a distant breathy bass flute, slow low cello swells, occasional "
            "far-off soft bowed metal shimmer. Enormous, ancient and solemn, full of "
            "AWE AND QUIET WONDER at how big and old it is — mysterious but calm and "
            "consonant, safe rather than frightening, never harsh or dissonant, no "
            "stingers, no sudden loud hits. Silence and space are as important as "
            "the notes. Around 58 BPM, minor-tinged modal, very soft dynamics, deep "
            "warm low end, gentle unfatiguing highs, seamless loop. Instrumental."
        ),
    },
    # SAME CAVE, A BIT LESS SLOW (maintainer 2026-08-06: "I liked it, but it
    # was just a bit to slow. But the feeling and everything was perfect. Try
    # generate a new one with a very similar prompt.").
    #
    # So this is `cave` with the smallest edit that can move the tempo, and it
    # is a SEPARATE track rather than an overwrite — the one he liked stays on
    # disk so he can A/B them in the wiki and keep whichever wins.
    #
    # Three changes, nothing else touched:
    #   1. 58 -> 74 BPM. `cave` asked 58 and MEASURED 55.57, so the model
    #      undershoots here; 74 should land near 70, which is "a bit" faster
    #      rather than a different piece.
    #   2. "Very sparse and patient" -> sparse WITH GENTLE FORWARD MOTION.
    #      Leaving "patient" in would have the prompt fighting the BPM — the
    #      words that make a take slow are not only the number.
    #   3. "Silence and space are as important as the notes" keeps its first
    #      half but gains a steady quiet pulse, for the same reason.
    # Everything about the FEELING — cathedral of wet stone, awe and quiet
    # wonder, consonant and safe rather than frightening — is verbatim, because
    # that is the part he said was perfect.
    "cave2": {
        "out": "cave2",
        "seconds": 110,
        "bpm": 74,
        "prompt": (
            "A vast, hushed underground theme for enormous echoing caverns deep "
            "under a mountain — cathedral spaces of wet stone, still black pools, "
            "faint glimmering crystal. It BEGINS IMMEDIATELY on a deep sustained "
            "low string drone. Sparse and unhurried but with a gentle forward "
            "motion, a quiet steady pulse underneath that keeps it walking: soft "
            "marimba and prepared-piano notes falling into a long natural reverb "
            "like drips into water, a distant breathy bass flute, slow low cello "
            "swells, occasional far-off soft bowed metal shimmer. Enormous, ancient "
            "and solemn, full of AWE AND QUIET WONDER at how big and old it is — "
            "mysterious but calm and consonant, safe rather than frightening, never "
            "harsh or dissonant, no stingers, no sudden loud hits. Space matters as "
            "much as the notes, over a pulse you can feel. Around 74 BPM, "
            "minor-tinged modal, very soft dynamics, deep warm low end, gentle "
            "unfatiguing highs, seamless loop. Instrumental."
        ),
    },
    # TWO MORE CAVE VARIATIONS (maintainer 2026-08-06: "Try to generate two
    # more variations. Still not happy.") — and deliberately NOT two rolls of
    # the same dice, because that is what cave2 already was.
    #
    # THE MEASURED PROBLEM: this brief undershoots the tempo it asks for, and
    # got worse the harder it was pushed. cave asked 58 and measured 55.57
    # (-4%); cave2 asked 74 and measured 61.52 (-17%). So asking for a bigger
    # number is ONE lever and clearly a weak one on its own.
    #
    # THE OTHER LEVER: "too slow" from a listener is usually EVENT DENSITY, not
    # BPM. A sparse take drowned in long reverb reads as slow at any tempo,
    # because almost nothing happens per bar. cave and cave2 both say "sparse"
    # and "space matters as much as the notes" — that wording is probably doing
    # more of the damage than the 58.
    #
    # So cave3 attacks the tempo and cave4 attacks the density, and whichever
    # he prefers tells us which lever actually mattered. Both keep the FEELING
    # verbatim — cathedral of wet stone, awe and quiet wonder, consonant and
    # safe rather than frightening — because that part was never the problem.
    #
    # cave3: TEMPO. Ask 92 to land near 75 given the -17% undershoot, and make
    # the pulse explicit and continuous rather than a hint.
    "cave3": {
        "out": "cave3",
        "seconds": 110,
        "bpm": 92,
        "prompt": (
            "A vast, hushed underground theme for enormous echoing caverns deep "
            "under a mountain — cathedral spaces of wet stone, still black pools, "
            "faint glimmering crystal. It BEGINS IMMEDIATELY on a deep sustained "
            "low string drone with a clear steady pulse already moving under it. "
            "Flowing and continuous, never static: soft marimba and prepared-piano "
            "notes falling steadily into a long natural reverb like drips into "
            "water, a distant breathy bass flute carrying a walking melody, slow low "
            "cello swells, occasional far-off soft bowed metal shimmer. Enormous, "
            "ancient and solemn, full of AWE AND QUIET WONDER at how big and old it "
            "is — mysterious but calm and consonant, safe rather than frightening, "
            "never harsh or dissonant, no stingers, no sudden loud hits. Keep it "
            "MOVING at a comfortable walking tempo, around 92 BPM, minor-tinged "
            "modal, very soft dynamics, deep warm low end, gentle unfatiguing highs, "
            "seamless loop. Instrumental."
        ),
    },
    # cave4: DENSITY. Tempo stays near the original he liked — the difference is
    # that something is always sounding: a continuous soft ostinato instead of
    # isolated notes in space. If this is the one he keeps, the lesson is that
    # "slow" meant empty, and the BPM was never the problem.
    "cave4": {
        "out": "cave4",
        "seconds": 110,
        "bpm": 68,
        "prompt": (
            "A vast, hushed underground theme for enormous echoing caverns deep "
            "under a mountain — cathedral spaces of wet stone, still black pools, "
            "faint glimmering crystal. It BEGINS IMMEDIATELY on a deep sustained "
            "low string drone under a soft repeating marimba ostinato that runs "
            "gently and continuously through the whole piece, like steady drips into "
            "a pool — there is always something quietly moving. Over it: prepared "
            "piano answering the pattern, a distant breathy bass flute melody, slow "
            "low cello swells, occasional far-off soft bowed metal shimmer, all in a "
            "long natural reverb. Enormous, ancient and solemn, full of AWE AND "
            "QUIET WONDER at how big and old it is — mysterious but calm and "
            "consonant, safe rather than frightening, never harsh or dissonant, no "
            "stingers, no sudden loud hits. Around 68 BPM, minor-tinged modal, very "
            "soft dynamics, deep warm low end, gentle unfatiguing highs, seamless "
            "loop. Instrumental."
        ),
    },
    # ---- BATTLE LAYERS (maintainer 2026-08-06) --------------------------------
    # "a battle-track for each music-track - designed to be played on top of the
    # music (with the music volume lowered by maybe 75-85%) … if the player
    # attacks another monster right away we just fade right back into the action
    # (so now the battle-track doesn't have to be restarted)."
    #
    # THE ONE DECISION THAT MAKES THIS WORK: these are LAYERS, not tracks. A
    # battle track is a finished piece and two finished pieces played together
    # is mud, whatever the tempo. A layer is deliberately INCOMPLETE — it brings
    # rhythm and drive and NO harmony of its own, so there is nothing to argue
    # with the bed's chords underneath it. Concretely, every brief below bans
    # chord progressions and melodies and asks for percussion plus a pulse on
    # the TONIC AND FIFTH only, which are consonant against nearly every chord a
    # piece in that key will play.
    #
    # THREE THINGS ARE MATCHED, all measured rather than guessed (master.py's
    # detect_key + estimate_tempo already produce them for every bed):
    #   1. KEY, exactly. Day is D major, night is A minor — from the measured
    #      `musical.root/mode` of the real files.
    #   2. TEMPO, as a SIMPLE MULTIPLE. Doubling reads as "the same music, but
    #      urgent" and stays phase-locked to the bed's beat grid: day 76 -> 152,
    #      night's true pulse 123 (the estimator reports 61.52, half of the raw
    #      123.05) -> 123 itself, which is already fight tempo.
    #   3. THE MIDRANGE IS LEFT OPEN. The bed's melody lives around 300 Hz-3 kHz;
    #      a layer that fills it buries the tune it is supposed to be part of.
    #      So the layers live LOW (drums, pulse) and HIGH (shakers, metal), and
    #      say so in the brief.
    #
    # The rest — ducking the bed 75-85%, holding the layer looping at zero gain
    # so re-engaging is a gain change and not a restart, fading back out over a
    # few seconds — is engine work, not generation, and is NOT being wired: he
    # asked to hear these in the wiki before committing to anything.
    "battle_day": {
        "out": "battle_day",
        "seconds": 90,
        "bpm": 152,
        "prompt": (
            "A driving PERCUSSION-AND-PULSE LAYER meant to be played ON TOP of an "
            "existing calm daytime folk theme, not a piece on its own. In D MAJOR, "
            "152 BPM, straight and steady. It BEGINS IMMEDIATELY at full energy. "
            "Frame drums, low toms, tight hand percussion, shakers, tambourine and "
            "claps carrying an urgent galloping rhythm, over a pulsing low D drone "
            "and short rhythmic stabs that use ONLY the notes D and A. Sudden "
            "danger in a sunlit valley — brave and heroic rather than dark, "
            "adventurous, propulsive, exciting. NO melody, NO chord progression, no "
            "sustained chords, nothing tuneful — the tune is already playing "
            "underneath this. Keep the MIDDLE OF THE SPECTRUM OPEN and uncluttered: "
            "energy belongs in the deep low end and the bright percussive top. "
            "Consistent intensity all the way through, no build, no drop, no "
            "ending, seamless loop. Instrumental."
        ),
    },
    "battle_night": {
        "out": "battle_night",
        "seconds": 90,
        "bpm": 123,
        "prompt": (
            "A driving PERCUSSION-AND-PULSE LAYER meant to be played ON TOP of an "
            "existing slow mystical night theme, not a piece on its own. In A "
            "MINOR, 123 BPM, straight and steady. It BEGINS IMMEDIATELY at full "
            "energy. Taut skin drums, low toms, a deep heartbeat kick, metallic "
            "rattles and shakers driving an urgent rhythm, over a pulsing bowed "
            "double-bass ostinato and short rhythmic stabs that use ONLY the notes "
            "A and E. Danger under moonlight — tense, dark and thrilling but noble "
            "rather than horrifying, never harsh or screeching. NO melody, NO chord "
            "progression, no sustained chords, nothing tuneful — the tune is "
            "already playing underneath this. Keep the MIDDLE OF THE SPECTRUM OPEN "
            "and uncluttered: energy belongs in the deep low end and the bright "
            "percussive top. Consistent intensity all the way through, no build, no "
            "drop, no ending, seamless loop. Instrumental."
        ),
    },
    # ---- THE SUMMIT (maintainer 2026-08-08: "3 music tracks that would sound
    # good to play on top of the mountain … for now I just want the songs in the
    # wiki"). Zones come later from the maps agent; nothing is routed.
    #
    # Three different ANSWERS to "what does a summit feel like", not three rolls
    # of one idea — that is the mistake cave2 was. Standing on top of a mountain
    # can be awe at the view, loneliness in thin air, or the reward for the
    # climb, and which one this game wants is his call, not mine. So: one bed per
    # reading, each committed to its own emotion rather than hedging between
    # them.
    #
    # THE CAVE LESSON IS APPLIED THROUGHOUT. `cave` and `cave2` undershot their
    # tempo badly (-4%, -17%) because the prompt said "very sparse and patient"
    # and "silence and space are as important as the notes" — wording that drags
    # whatever number follows it. cave3 and cave4 hit their asked tempo exactly
    # once that came out. So every brief below names the MOTION it wants, and
    # `summit_wind` in particular — the one that could easily become another
    # slow drone — is told it has a steady quiet pulse.
    "summit_vista": {
        "out": "summit_vista",
        "seconds": 110,
        "bpm": 76,
        "prompt": (
            "A wide, breathtaking orchestral theme for standing on a mountain "
            "summit and seeing an entire world laid out below — valleys, rivers, "
            "distant sea, clouds beneath your feet. It OPENS IMMEDIATELY on warm "
            "sustained strings already wide and moving. A long, patient, soaring "
            "melody on solo horn answered by high strings, with harp and light "
            "glimmering bells far underneath and a deep warm bass holding the "
            "ground. Enormous DISTANCE and clean thin air — spacious, luminous, "
            "full of AWE at how much of the world is visible from here. Majestic "
            "and moving without ever becoming a fanfare or a battle. It keeps a "
            "gentle, unhurried FORWARD DRIFT the whole way, like slow cloud "
            "shadow crossing the land. Around 76 BPM, major key with a wistful "
            "edge, rich but airy orchestration, seamless loop. Instrumental."
        ),
    },
    "summit_wind": {
        "out": "summit_wind",
        "seconds": 110,
        "bpm": 66,
        "prompt": (
            "A lonely, exposed theme for the bare top of a high mountain — cold "
            "thin air, wind over stone, nobody for miles. It BEGINS IMMEDIATELY "
            "on a soft low drone with a steady quiet pulse already moving under "
            "it, so it breathes rather than hangs still. A single reedy low flute "
            "or duduk carries a simple, aching, memorable melody; airy high "
            "strings and a distant wordless female voice answer it; a slow "
            "shimmer of struck metal far away, and a low heartbeat underneath. "
            "SOLITUDE AND HEIGHT — beautiful and a little melancholy, humbling, "
            "calm and safe rather than frightening, never harsh. Sparse but "
            "always moving. Around 66 BPM, minor-tinged modal, very soft "
            "dynamics, deep warm low end, seamless loop. Instrumental."
        ),
    },
    "summit_triumph": {
        "out": "summit_triumph",
        "seconds": 105,
        "bpm": 100,
        "prompt": (
            "A warm, noble folk-orchestral theme for having CLIMBED the mountain "
            "and standing on top of it — the reward at the end of a long ascent. "
            "It STARTS STRAIGHT INTO the tune with a walking pulse already going. "
            "A proud, hummable melody on French horn and tin whistle, answered by "
            "fiddle and warm strings, over strummed lute, plucked bass and light "
            "frame-drum and tambourine keeping a steady confident stride. The "
            "feeling is EARNED JOY and open sky — heroic and generous but human "
            "and pastoral, a hard climb behind you rather than a battle won. "
            "Rises to one glad open peak, then settles back and keeps walking so "
            "it loops without ever sounding like an ending. Around 100 BPM, major "
            "key, bright and unfatiguing, seamless loop. Instrumental."
        ),
    },
    # ---- SEQUENCEABLE REMAKES of every bed the game actually plays
    # (maintainer 2026-08-08, after the Hyrule Field conversation): same music,
    # same quality bar, but written as interchangeable phrases so the score can
    # be RE-ORDERED at run time instead of looping. Generated ALONGSIDE the
    # originals — title and night are approved and cave4 is his own pick, and a
    # roll of the dice must not be able to lose any of them.
    "title_seq": {
        "out": "title_seq",
        "seconds": 209,
        "bpm": 92,
        # 8 bars at 92 BPM = 20.9 s. TEN phrases: the select screen is a shorter
        # exposure than a bed you live in, but it is the first thing anyone
        # hears, so it still gets real material.
        "phrase_ms": 20870,
        "harmony": "the same warm four-chord cycle in a major key under every phrase",
        "foregrounds": [
            "solo tin whistle carries the melody",
            "warm strings carry the melody",
            "noble French horn carries the melody",
            "harp and piano carry it lightly",
            "fiddle carries the melody",
            "strings and horn together, fuller",
        ],
        "prompt": (
                        "A sweeping, nostalgic orchestral fantasy title theme — a grand adventure"
            " about to begin and the warmth of coming home at once. Proud, hopeful, m"
            "emorable folk melodies on tin whistle, flute and fiddle over warm string"
            "s and a noble horn, with harp and light bells underneath. Pastoral warmt"
            "h with a light walking pulse. Around 92 BPM, major key, rich but airy or"
            "chestration, no heavy percussion. Instrumental. STRUCTURE MATTERS AS MUC"
            "H AS THE TUNE HERE. Write it as a set of INTERCHANGEABLE 8-BAR PHRASES t"
            "hat can be played in ANY ORDER: one key and one tempo from first bar to "
            "last with no modulation and no tempo change, the SAME repeating chord cy"
            "cle under every phrase, and each phrase starting cleanly on the downbeat"
            " and resolving by its final bar so any phrase can follow any other. The "
            "variety is in the FOREGROUND — which instrument carries the line and how"
            " busy it is — never in the harmony. No intro, no build, no climax, no en"
            "ding, no fade in or out: every phrase is equally at home first or last. "
        ),
    },
    "night_seq": {
        "out": "night_seq",
        "seconds": 248,
        "bpm": 62,
        # 4 bars at 62 BPM = 15.5 s. SIXTEEN phrases = 4.1 min before any phrase
        # can return, and with a shuffled bag the order differs every cycle.
        # This is a bed the player lives in for hours.
        "phrase_ms": 15484,
        "harmony": "the same slow minor-tinged chord cycle under every phrase",
        "foregrounds": [
            "lone soft flute breathes the melody",
            "ocarina breathes the melody",
            "ethereal wordless choir pad carries it",
            "celesta and glass bells carry it",
            "distant harp carries it",
            "warm low strings alone, very sparse",
            "solo cello sings the line over the pad",
            "celesta and harp trade the line",
        ],
        "prompt": (
                        "A mysterious, enchanted nocturnal theme for a moonlit magical forest — g"
            "lowing wisps drifting between vast ancient trees, hushed and dreamlike. "
            "Soft ethereal choir pads, celesta and glass-bell shimmers, slow distant "
            "harp, a lone flute or ocarina over warm low strings. Wonder tinged with "
            "mystery, calm and never frightening. Around 62 BPM, very soft dynamics. "
            "Instrumental. STRUCTURE MATTERS AS MUCH AS THE TUNE HERE. Write it as a "
            "set of INTERCHANGEABLE 8-BAR PHRASES that can be played in ANY ORDER: on"
            "e key and one tempo from first bar to last with no modulation and no tem"
            "po change, the SAME repeating chord cycle under every phrase, and each p"
            "hrase starting cleanly on the downbeat and resolving by its final bar so"
            " any phrase can follow any other. The variety is in the FOREGROUND — whi"
            "ch instrument carries the line and how busy it is — never in the harmony"
            ". No intro, no build, no climax, no ending, no fade in or out: every phr"
            "ase is equally at home first or last. "
        ),
    },
    "battle_seq": {
        "out": "battle_seq",
        "seconds": 106,
        "bpm": 144,
        # 8 bars at 144 BPM = 13.3 s. EIGHT phrases, deliberately fewer: fights
        # are short and bursty, and hearing a phrase again mid-fight reads as
        # intensity rather than fatigue.
        "phrase_ms": 13333,
        "harmony": "the same driving minor chord cycle under every phrase",
        "foregrounds": [
            "low strings drive the ostinato",
            "brass stabs carry the line",
            "taiko and low toms carry it, strings holding",
            "high strings carry the line",
            "full ensemble together",
            "percussion and bass alone, tense",
        ],
        "prompt": (
                        "An urgent, driving orchestral combat theme — monsters closing in, a figh"
            "t you can win. Relentless low string ostinato, brass stabs, taiko and lo"
            "w toms, taut high strings. Heroic and thrilling rather than horrifying, "
            "never harsh or screeching. Around 144 BPM, minor key. Instrumental. STRU"
            "CTURE MATTERS AS MUCH AS THE TUNE HERE. Write it as a set of INTERCHANGE"
            "ABLE 8-BAR PHRASES that can be played in ANY ORDER: one key and one temp"
            "o from first bar to last with no modulation and no tempo change, the SAM"
            "E repeating chord cycle under every phrase, and each phrase starting cle"
            "anly on the downbeat and resolving by its final bar so any phrase can fo"
            "llow any other. The variety is in the FOREGROUND — which instrument carr"
            "ies the line and how busy it is — never in the harmony. No intro, no bui"
            "ld, no climax, no ending, no fade in or out: every phrase is equally at "
            "home first or last. "
        ),
    },
    "cave_seq": {
        "out": "cave_seq",
        "seconds": 226,
        "bpm": 68,
        # 4 bars at 68 BPM = 14.1 s. SIXTEEN phrases — the cave is somewhere he
        # stands still and listens.
        "phrase_ms": 14118,
        "harmony": "the same slow modal chord cycle under every phrase",
        "foregrounds": [
            "marimba ostinato carries it, prepared piano answering",
            "breathy bass flute carries the line",
            "low cello swells carry it",
            "prepared piano alone over the drone",
            "soft bowed metal shimmer above the ostinato",
            "marimba and flute together",
            "prepared piano and marimba interlock",
            "bass flute and cello together, low",
        ],
        "prompt": (
                        "A vast, hushed underground theme for enormous echoing caverns — cathedra"
            "l spaces of wet stone, still black pools, faint glimmering crystal, over"
            " a deep sustained low drone with a soft repeating marimba ostinato that "
            "never stops moving. Enormous, ancient and solemn, full of awe and quiet "
            "wonder — consonant and safe rather than frightening. Around 68 BPM, mino"
            "r-tinged modal, deep warm low end. Instrumental. STRUCTURE MATTERS AS MU"
            "CH AS THE TUNE HERE. Write it as a set of INTERCHANGEABLE 8-BAR PHRASES "
            "that can be played in ANY ORDER: one key and one tempo from first bar to"
            " last with no modulation and no tempo change, the SAME repeating chord c"
            "ycle under every phrase, and each phrase starting cleanly on the downbea"
            "t and resolving by its final bar so any phrase can follow any other. The"
            " variety is in the FOREGROUND — which instrument carries the line and ho"
            "w busy it is — never in the harmony. No intro, no build, no climax, no e"
            "nding, no fade in or out: every phrase is equally at home first or last."
            " "
        ),
    },
    "summit_seq": {
        "out": "summit_seq",
        "seconds": 230,
        "bpm": 100,
        # SIX bars at 100 BPM = 14.4 s, not eight: 16 x 19.2 s would be 307 s
        # and the API caps one generation at 300 s. Shorter bars buy the
        # sixteenth phrase.
        "phrase_ms": 14400,
        "harmony": "the same bright major chord cycle under every phrase",
        "foregrounds": [
            "French horn carries the melody",
            "tin whistle carries the melody",
            "fiddle carries the melody",
            "warm strings carry it, wide",
            "strummed lute and plucked bass carry it lightly",
            "horn and strings together",
            "whistle and fiddle trade the phrase",
            "horn alone, distant and wide",
        ],
        "prompt": (
                        "A warm, noble folk-orchestral theme for standing on a mountain top after"
            " a long climb — earned joy and open sky. A proud, hummable melody on Fre"
            "nch horn and tin whistle answered by fiddle and warm strings, over strum"
            "med lute, plucked bass and light frame drum keeping a confident stride. "
            "Heroic and generous but human and pastoral. Around 100 BPM, major key, b"
            "right and unfatiguing. Instrumental. STRUCTURE MATTERS AS MUCH AS THE TU"
            "NE HERE. Write it as a set of INTERCHANGEABLE 8-BAR PHRASES that can be "
            "played in ANY ORDER: one key and one tempo from first bar to last with n"
            "o modulation and no tempo change, the SAME repeating chord cycle under e"
            "very phrase, and each phrase starting cleanly on the downbeat and resolv"
            "ing by its final bar so any phrase can follow any other. The variety is "
            "in the FOREGROUND — which instrument carries the line and how busy it is"
            " — never in the harmony. No intro, no build, no climax, no ending, no fa"
            "de in or out: every phrase is equally at home first or last. "
        ),
    },
    # THE DAY BED — the most-heard music in the game, and the one I wrongly left
    # alone as "another agent's domain" (maintainer 2026-08-08: "You have the
    # entire responsibility for much music and sound right now"). It replaces
    # music/nangijala_cherry_valley, so it matches that track's MEASURED key and
    # tempo — D major, 76 BPM — rather than inventing new ones: a like-for-like
    # swap he can A/B, not a different piece wearing the same slot.
    "day_seq": {
        "out": "day_seq",
        "seconds": 303,
        "bpm": 76,
        # SIX bars at 76 BPM = 18.9 s. Eight would be 25.3 s, past the 12-20 s
        # band where a phrase is an idea rather than a section.
        "phrase_ms": 18947,
        "harmony": "the same warm four-chord cycle in D major under every phrase",
        "foregrounds": [
            "flute carries the melody",
            "tin whistle carries the melody",
            "fiddle carries the melody",
            "warm horn carries the melody",
            "strummed lute and harp carry it lightly",
            "strings carry it alone, wide and calm",
            "whistle and fiddle trade the phrase",
            "harp and plucked bass alone, sparse",
        ],
        "prompt": (
            "A wide-open pastoral fantasy overworld theme for a beautiful green home "
            "valley — meadows, cherry orchards, a village somewhere over the hill, th"
            "e road ahead. It STARTS PLAYING AT ONCE with warm strings and a light wa"
            "lking pulse already moving. A calm, hopeful, hummable melody carried by "
            "flute, tin whistle and fiddle, answered by a warm horn, over strummed lu"
            "te, harp and soft plucked bass. The feeling is BELONGING AND GENTLE MOTI"
            "ON — the joy of a place you know well on a good morning. Beautiful and g"
            "enerous and completely unfatiguing: this is the music the player hears m"
            "ore than any other, so it must still be lovely on the two hundredth pass"
            ". Never grand, never tense, never triumphant. Around 76 BPM, D MAJOR, li"
            "ght brushed percussion only, spacious mix. Instrumental. STRUCTURE MATTE"
            "RS AS MUCH AS THE TUNE HERE. Write it as a set of INTERCHANGEABLE 6-BAR "
            "PHRASES that can be played in ANY ORDER: one key and one tempo from firs"
            "t bar to last with no modulation and no tempo change, the SAME repeating"
            " chord cycle under every phrase, and each phrase starting cleanly on the"
            " downbeat and resolving by its final bar so any phrase can follow any ot"
            "her. The variety is in the FOREGROUND — which instrument carries the lin"
            "e and how busy it is — never in the harmony. No intro, no build, no clim"
            "ax, no ending, no fade in or out: every phrase is equally at home first "
            "or last."
        ),
    },
    # The emotional centre: the spawn bonfire, where the player is safe. Small
    # and intimate on purpose — the smallest music in the game.
    "home": {
        "out": "home",
        "seconds": 100,
        "bpm": 68,
        "prompt": (
            "A tender, intimate fireside theme — sitting by a warm campfire at dusk "
            "among friends, nothing to fear, exactly where you belong. It STARTS "
            "GENTLY BUT IMMEDIATELY on a solo fingerpicked acoustic guitar or harp. "
            "A simple, tender, deeply memorable folk melody you could hum, carried "
            "by a warm solo cello and answered by soft piano and a distant "
            "pennywhistle, with a quiet music-box glimmer far underneath. Small and "
            "close and human — a few instruments in one room, never a big "
            "orchestra. The feeling is SAFETY, REST AND COMING HOME: nostalgic, "
            "affectionate, a little bittersweet, deeply comforting, hopeful rather "
            "than sad. Slow, unhurried, no percussion at all. Around 68 BPM, major "
            "key with warm gentle harmony, very soft dynamics, seamless loop. "
            "Instrumental."
        ),
    },
    # Urgent, but HEROIC — the player should feel capable, not hunted. Also the
    # one bed allowed real percussion and brass.
    "battle": {
        "out": "battle",
        "seconds": 90,
        "bpm": 142,
        "prompt": (
            "A driving, heroic fantasy battle theme — monsters closing in and the "
            "hero standing their ground. It HITS RUNNING from the very first beat, "
            "already at full energy. A relentless galloping ostinato in low staccato "
            "strings under urgent brass calls, punchy taiko and timpani, snare "
            "rolls, and a bold rising minor-key melody on horns answered by high "
            "strings; a short choir shout for accent. Energetic, courageous and "
            "exciting — the thrill of a fight you can WIN — powerful and adventurous "
            "rather than dark, evil, horrifying or tragic. Keeps a strong steady "
            "pulse the whole way through with one short breath-taking bar before it "
            "drives again, so it can loop under a long fight without exhausting the "
            "listener. Around 142 BPM, minor key, big cinematic percussion, punchy "
            "controlled low end, seamless loop. Instrumental."
        ),
    },
}

NEW_BEDS = ["town", "cave", "home", "battle", "adventure"]


# ------------------------------------------------------------- API helpers

# ---- SUITES FROM DATA (briefs/*.json) --------------------------------------
# A campaign is a diff, not a code edit. Each brief file is one SUITE — one key,
# one tempo, one phrase length — holding every POOL and every COLOUR ever
# written for it, so the maintainer can swap a colour back in later and nothing
# he has seen is ever lost. Track names are <suite>_<pool>_<colour>, which means
# a re-roll of one colour cannot overwrite another, and the wiki groups them by
# prefix for free.
BRIEFS_DIR = MUSIC_DIR / "briefs"


def load_suites() -> dict[str, dict]:
    specs: dict[str, dict] = {}
    if not BRIEFS_DIR.is_dir():
        return specs
    for path in sorted(BRIEFS_DIR.glob("*.json")):
        try:
            doc = json.loads(path.read_text())
        except (OSError, ValueError) as e:  # a broken brief must not kill a run
            print(f"! skipping {path.name}: {e}")
            continue
        suite = doc.get("suite") or path.stem
        pm = int(doc.get("phrase_ms") or 0)
        for pool, pd in (doc.get("pools") or {}).items():
            n = int(pd.get("phrases") or 0)
            if not (pm and n):
                continue
            for c in pd.get("colours") or []:
                slug = c.get("slug")
                prompt = c.get("prompt")
                if not (slug and prompt):
                    continue
                specs[f"{suite}_{pool}_{slug}"] = {
                    "out": f"{suite}_{pool}_{slug}",
                    "seconds": int(round(n * pm / 1000)),
                    "bpm": doc.get("bpm"),
                    "phrase_ms": pm,
                    "key_line": pd.get("key_line") or doc.get("key_line", ""),
                    "harmony": pd.get("harmony") or doc.get("harmony", ""),
                    "foregrounds": c.get("foregrounds") or [],
                    "prompt": prompt,
                    "suite": suite,
                    "pool": pool,
                    "colour": slug,
                    "idea": c.get("idea"),
                }
    return specs


TRACKS.update(load_suites())


def plan_sections(plan: dict) -> list[dict]:
    """Normalize a composition plan's sections (the REST API has shipped both
    snake_case and camelCase for these fields)."""
    def get(d, *names, default=None):
        for n in names:
            if isinstance(d, dict) and n in d:
                return d[n]
        return default
    out = []
    for sec in get(plan, "sections", default=[]) or []:
        out.append({
            "name": get(sec, "section_name", "sectionName", default="section"),
            "duration_ms": int(get(sec, "duration_ms", "durationMs", default=0)),
            "styles": list(get(sec, "positive_local_styles", "positiveLocalStyles",
                               default=[]) or []),
        })
    return out


# ---- INTERCHANGEABLE PHRASES (maintainer 2026-08-08) -----------------------
# The Hyrule Field trick: Kondo did not write a loop, he wrote short phrases the
# game re-orders at run time, so the theme almost never unfolds the same way
# twice. That is what keeps a bed the player hears for hours from wearing out.
#
# A through-composed piece CANNOT be shuffled — its sections are in that order
# for a reason, and reordering them sounds wrong. Three things have to be true
# for phrases to be interchangeable, and none of them happen by accident:
#
#   1. ONE key and ONE tempo for the whole piece. A modulation or a tempo change
#      makes two phrases un-joinable, full stop.
#   2. EVERY PHRASE THE SAME LENGTH, and that length a whole number of bars, so
#      a boundary is always a musical boundary.
#   3. THE SAME HARMONIC CYCLE UNDER EVERY PHRASE. This is the one that actually
#      does the work: if all phrases sit on the same chord loop, any phrase can
#      follow any other and still resolve. The variety then lives in the
#      FOREGROUND — which instrument carries it, how busy it is — not in the
#      harmony.
#
# The prose brief asks for all three, but prose is a wish. The composition plan
# is where it can be ENFORCED, so `phrase_plan` rewrites whatever the planner
# returns into equal blocks that share one harmony line and differ only in
# foreground. The API still supplies the plan OBJECT (so the schema is always
# valid); we only impose the shape.
def phrase_plan(plan: dict | None, length_ms: int, phrase_ms: int,
                harmony: str, foregrounds: list[str], key_line: str = "") -> dict | None:
    """Equal, bar-aligned phrases over one shared chord cycle, in ONE key.

    `key_line` is the fix for v1.1's failure. Describing the harmony once in a
    section style and hoping produced beds that held their key in 2 of 15
    phrases (summit_seq) and 8 of 15 (day_seq). The key now goes in the plan's
    GLOBAL styles AND at the head of every section, stated positively ("stays
    in D major throughout") rather than as a prohibition — negative prompts
    weight the very words they forbid, which this pipeline learned the hard
    way and documents at the top of the file."""
    if not plan or not isinstance(plan, dict):
        return plan
    secs = plan.get("sections") or plan.get("sectionS") or []
    if not secs or not isinstance(secs[0], dict):
        return plan
    template = dict(secs[0])
    key_name = "section_name" if "section_name" in template else "sectionName"
    key_dur = "duration_ms" if "duration_ms" in template else "durationMs"
    key_pos = ("positive_local_styles" if "positive_local_styles" in template
               else "positiveLocalStyles")
    n = max(2, round(length_ms / phrase_ms))
    out = []
    for i in range(n):
        sec = dict(template)
        sec[key_name] = f"Phrase {i + 1}"
        sec[key_dur] = phrase_ms
        # Harmony first and identical everywhere; foreground rotates.
        sec[key_pos] = [x for x in (key_line, harmony, foregrounds[i % len(foregrounds)],
                        "same key throughout", "same tempo throughout",
                        "starts on the downbeat", "self-contained phrase") if x]
        out.append(sec)
    plan = dict(plan)
    plan["sections"] = out
    if key_line:
        gk = "positive_global_styles" if "positive_global_styles" in plan else "positiveGlobalStyles"
        plan[gk] = [key_line, *(plan.get(gk) or [])]
    return plan


def credits_remaining(session: requests.Session) -> int | None:
    try:
        r = session.get(SUB_URL, timeout=60)
        if r.status_code != 200:
            return None
        d = r.json()
        limit, used = d.get("character_limit"), d.get("character_count")
        if isinstance(limit, int) and isinstance(used, int):
            return max(0, limit - used)
    except (requests.RequestException, ValueError):
        return None
    return None


def make_plan(session: requests.Session, prompt: str, length_ms: int) -> dict | None:
    try:
        r = session.post(PLAN_URL, json={"prompt": prompt, "music_length_ms": length_ms,
                                         "model_id": MODEL_ID}, timeout=600)
    except requests.RequestException as e:
        print(f"  ! plan request failed: {e}")
        return None
    if r.status_code != 200:
        print(f"  ! music/plan {r.status_code}: {r.text[:200]} — composing from the raw prompt")
        return None
    try:
        plan = r.json()
    except ValueError:
        return None
    if not plan_sections(plan):
        print("  ! plan had no sections — composing from the raw prompt")
        return None
    return plan


class QuotaExhausted(RuntimeError):
    """The account is out of credits. Terminal for the RUN, not just this take.

    Learned 2026-08-22: the first 401 quota_exceeded was treated as one bad
    candidate, so the run kept trying — six more requests across two tracks,
    every one refused, before it gave up. Worse, it then exited non-zero and
    the workflow skipped its commit step, throwing away three tracks that had
    already been generated and paid for. Credits are the scarcest thing here:
    stop asking the moment the answer is no, and keep everything already made.
    """


def compose(session: requests.Session, *, prompt: str | None = None,
            plan: dict | None = None, length_ms: int | None = None,
            fmt: str = "pcm_44100") -> tuple[bytes, str] | None:
    body: dict = {"model_id": MODEL_ID}
    if plan is not None:
        body["composition_plan"] = plan
    else:
        body["prompt"] = prompt
        if length_ms:
            body["music_length_ms"] = length_ms
    try:
        r = session.post(MUSIC_URL, params={"output_format": fmt}, json=body, timeout=900)
    except requests.RequestException as e:
        print(f"  ! compose request failed: {e}")
        return None
    if r.status_code != 200:
        # OUT OF CREDITS is terminal for the run — asking again in another
        # format, or for the next track, cannot succeed and only wastes the
        # wall clock. Raise past every retry so the caller can stop cleanly and
        # still keep everything generated up to this point.
        if "quota_exceeded" in r.text or "quota" in r.text.lower():
            raise QuotaExhausted(r.text[:200])
        # The lossless format needs a high enough tier — degrade once.
        if fmt != "mp3_44100_128":
            print(f"  ! {fmt} rejected ({r.status_code}: {r.text[:120]}) — retrying as mp3")
            return compose(session, prompt=prompt, plan=plan, length_ms=length_ms,
                           fmt="mp3_44100_128")
        print(f"  ! music {r.status_code}: {r.text[:200]}")
        return None
    if not r.content:
        print("  ! music returned an empty body")
        return None
    return r.content, fmt


# ---------------------------------------------------------------- scoring

def score_candidate(card: dict, loop: dict, want_s: float, is_battle: bool) -> tuple[float, list[str]]:
    """Rank a take the way the maintainer would judge it, using measured proxies.
    Returns (score, reasons-it-is-bad).

    DISQUALIFY before you rank. The first battle run shipped a 0.07-SECOND file
    because the additive score handed a degenerate take 42 points for the things
    it trivially "passed" — no lead-in and no silence are free when there is no
    audio — while the two real 90 s takes were dragged below it by a fade-out
    penalty. A take that is not a track cannot be compared to one that is, so
    those cases now score a hard zero instead of competing.
    """
    bad: list[str] = []

    # --- hard disqualifiers: not a usable track at all ---------------------
    if card["duration_s"] < 0.6 * want_s:
        return 0.0, [f"TRUNCATED ({card['duration_s']:.2f}s of {want_s:.0f}s)"]
    if card["lufs"] <= -50:
        return 0.0, [f"SILENT ({card['lufs']} LUFS)"]
    if card["silence_frac"] > 0.5:
        return 0.0, [f"MOSTLY SILENT ({card['silence_frac']:.0%})"]

    s = 0.0

    # A late start is the one fault the maintainer has explicitly rejected.
    lead = card["lead_in_s"]
    s += 22.0 if lead <= 0.25 else 14.0 if lead <= 0.6 else 4.0 if lead <= 1.2 else 0.0
    if lead > 0.6:
        bad.append(f"slow start ({lead:.2f}s)")

    # The loop seam is what makes a bed sound composed rather than repeated.
    s += 30.0 * min(1.0, max(0.0, (loop["score"] - 0.55) / 0.40))
    if loop["score"] < 0.72:
        bad.append(f"weak loop seam ({loop['score']:.2f})")

    # Dead air anywhere is a hole in the bed.
    s += 12.0 * (1.0 - min(1.0, card["silence_frac"] / 0.08))
    if card["silence_frac"] > 0.06:
        bad.append(f"gaps ({card['silence_frac']:.1%} silent)")

    # Dynamics: over-compressed reads lifeless, wildly peaky reads unmixed.
    crest = card["crest_db"]
    s += 10.0 if 8.0 <= crest <= 17.0 else 5.0 if 6.0 <= crest <= 20.0 else 0.0
    if not 6.0 <= crest <= 20.0:
        bad.append(f"odd dynamics (crest {crest:.1f} dB)")

    # Brightness — the composer's own foley lesson, RE-CALIBRATED FOR MUSIC.
    # The foley thresholds (3400 Hz) flagged all five beds at 5800-6800 Hz,
    # which is simply where a real orchestra with strings, cymbals and bells
    # sits — a footstep and a full mix are not the same measurement. These
    # marks catch a genuinely shrill bed without condemning every take.
    hi = 6800.0 if is_battle else 5200.0
    cen = card["centroid_hz"]
    s += 12.0 if cen <= hi else 6.0 if cen <= hi * 1.35 else 0.0
    if cen > hi * 1.35:
        bad.append(f"harsh/bright ({cen:.0f} Hz)")

    # Stereo: must not be mono-flat, must not cancel on a phone speaker.
    corr = card["stereo_corr"]
    s += 8.0 if 0.15 <= corr <= 0.96 else 3.0 if corr > 0.0 else 0.0
    if corr < 0.0:
        bad.append(f"phase problems (corr {corr:.2f})")

    # It should be roughly the length we asked for.
    ratio = card["duration_s"] / max(want_s, 1.0)
    s += 6.0 if ratio >= 0.85 else 2.0 if ratio >= 0.6 else 0.0
    if ratio < 0.85:
        bad.append(f"short ({card['duration_s']:.0f}s of {want_s:.0f}s)")

    # A fade-out at the very END only matters if we would ever REACH it. We
    # loop at measured points well inside the track, so a tail the loop never
    # plays is cosmetic — this used to be a flat ×0.5 and it halved both real
    # battle takes (whose endings fade) below a broken 0.07 s file. It now
    # applies only when the seam is too weak to rely on, i.e. when playback
    # really would run to the end.
    if card["tail_rms_ratio"] < 0.35:
        if loop["score"] < 0.8:
            s *= 0.5
            bad.append(f"fades out with no usable loop (tail {card['tail_rms_ratio']:.2f})")
        else:
            bad.append(f"fades out at the end, loop avoids it (tail {card['tail_rms_ratio']:.2f})")
    return round(s, 2), bad


# ------------------------------------------------------------- the pipeline

def _grid_ms(spec: dict, measured_bpm: float | None) -> int:
    """Phrase length from the MEASURED tempo when it is close to the brief.

    Within 10% we believe the measurement and recompute the grid from it, so
    cuts land on real bar lines. Outside 10% the estimator has almost certainly
    halved or doubled the pulse, and the brief is the safer number.
    """
    asked_ms = int(spec["phrase_ms"])
    asked_bpm = spec.get("bpm")
    if not (measured_bpm and asked_bpm):
        return asked_ms
    if abs(measured_bpm / asked_bpm - 1) > 0.10:
        return asked_ms
    bars = asked_ms / 1000 * asked_bpm / 60 / 4
    return int(round(bars * 4 * 60_000 / measured_bpm))


def build_track(session: requests.Session, name: str, spec: dict, seconds: int | None,
                candidates: int) -> dict | None:
    secs = seconds or spec["seconds"]
    length_ms = max(10_000, min(300_000, secs * 1000))
    print(f"\n=== {name} (~{secs}s, {candidates} candidate(s)) ===")

    plan = make_plan(session, spec["prompt"], length_ms)
    # A SEQUENCEABLE bed gets its plan rewritten into equal phrases over one
    # shared chord cycle — see phrase_plan. Without this the planner writes an
    # intro/build/outro shape, which is exactly what cannot be shuffled.
    if spec.get("phrase_ms"):
        plan = phrase_plan(plan, length_ms, spec["phrase_ms"],
                           spec["harmony"], spec["foregrounds"],
                           spec.get("key_line", ""))
    sections = plan_sections(plan) if plan else []
    if sections:
        print("  plan:", ", ".join(f"{s['name']}:{s['duration_ms'] / 1000:.0f}s" for s in sections))

    best = None
    tried = []
    for i in range(candidates):
        try:
            got = compose(session, prompt=spec["prompt"], plan=plan, length_ms=length_ms)
        except QuotaExhausted:
            # Out of credits mid-track. If an earlier candidate already landed,
            # fall through and MASTER IT — a paid-for take must not be lost
            # because the next request was refused.
            print(f"  ! out of credits after {i} candidate(s) for {name}")
            if best is None:
                raise
            break
        if not got:
            continue
        audio, fmt = got
        try:
            y, sr = M.decode(audio, expected_s=secs)
        except Exception as e:  # a container we cannot open is a dead candidate
            print(f"  ! candidate {i + 1}: decode failed ({e})")
            continue
        card = M.measure(y, sr)
        loop = M.find_loop(M.to_mono(y), sr, bpm=spec.get("bpm"),
                           min_loop_s=min(30.0, card["duration_s"] * 0.45))
        sc, bad = score_candidate(card, loop, secs, name == "battle")
        tried.append({"score": sc, "faults": bad, **card, "loop_score": loop["score"]})
        print(f"  candidate {i + 1}/{candidates}: score {sc:5.1f}  "
              f"lufs {card['lufs']:+.1f}  lead {card['lead_in_s']:.2f}s  "
              f"loop {loop['score']:.3f}  centroid {card['centroid_hz']:.0f}Hz"
              + (f"   [{'; '.join(bad)}]" if bad else "   [clean]"))
        # A DISQUALIFIED TAKE MUST NEVER WIN, not even unopposed. score 0 means
        # truncated, silent or mostly silence — score_candidate's hard
        # disqualify. With three candidates the good one simply outranked it,
        # which hid this: at ONE candidate (the breadth-over-re-rolls policy)
        # `best is None` made a 0.12-second fragment the winner and it shipped
        # as nangijala_explore_day_choir. Better to write nothing and re-roll.
        if sc <= 0:
            print(f"  ! candidate {i + 1} disqualified — not eligible to win")
            continue
        if best is None or sc > best["score"]:
            best = {"score": sc, "y": y, "sr": sr, "card": card, "loop": loop,
                    "fmt": fmt, "faults": bad}

    if best is None:
        print(f"  !! {name}: every candidate failed — nothing written")
        return None

    # Master the winner, then re-measure the loop on the MASTERED audio (the
    # lead-in trim shifts every timestamp).
    y, info = M.master(best["y"], best["sr"])
    loop = M.find_loop(M.to_mono(y), best["sr"], bpm=spec.get("bpm"),
                       min_loop_s=min(30.0, len(y) / best["sr"] * 0.45))
    print(f"  master: {info}")
    print(f"  loop:   {loop['loop_start_s']}s → {loop['loop_end_s']}s "
          f"(seam {loop['score']}, {loop['loop_end_s'] - loop['loop_start_s']:.1f}s long)")

    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, f"{spec['out']}.wav")
        M.write_wav(wav, y, best["sr"])
        variants = M.encode_variants(wav)
        if not variants:
            print(f"  !! {name}: no delivery copies encoded — nothing written")
            return None
        # KEEP EVERY GENERATION (maintainer 2026-08-22: "don't delete the
        # generations! Maybe I want to swap something out and something
        # different in"). The live name is what the game/wiki play; a numbered
        # copy goes to music/pool/ and is NEVER overwritten, so re-rolling a
        # brief adds an option instead of destroying the previous one. Same
        # convention the foley library already uses.
        POOL_DIR.mkdir(parents=True, exist_ok=True)
        ver = 1
        while any((POOL_DIR / f"{spec['out']}__v{ver:02d}{e}").exists()
                  for e in (".ogg", ".m4a", ".mp3")):
            ver += 1
        for v in variants:
            dst = MUSIC_DIR / v["file"]
            src_tmp = os.path.join(tmp, v["file"])
            ext = os.path.splitext(v["file"])[1]
            shutil.copyfile(src_tmp, POOL_DIR / f"{spec['out']}__v{ver:02d}{ext}")
            os.replace(src_tmp, dst)
            print(f"  wrote {dst.name} ({v['size_bytes'] / 1024:.0f} KB)"
                  f"  + archived as {spec['out']}__v{ver:02d}{ext}")

    musical = M.musical_analysis(y, best["sr"], prior_bpm=spec.get("bpm"))
    print(f"  key:    {musical['key']['root']} {musical['key']['mode']} "
          f"(conf {musical['key']['confidence']}), "
          f"measured {musical['timing']['bpm']} BPM (asked {spec.get('bpm')})")

    return {
        "id": name,
        "files": [{"file": v["file"], "mime": v["mime"], "size_bytes": v["size_bytes"]}
                  for v in variants],
        "duration_s": round(len(y) / best["sr"], 3),
        "bpm": musical["timing"]["bpm"] or spec.get("bpm"),
        "asked_bpm": spec.get("bpm"),
        "musical": musical["key"],
        "timing": musical["timing"],
        "loop": loop,
        # Mastering already matched every bed, so the engine needs no trim.
        # This is the by-ear escape hatch: nudge it here and redeploy, no
        # regeneration (the maintainer always tunes the final dB by ear).
        "trim_db": 0.0,
        "master": info,
        "measured": best["card"],
        "faults": best["faults"],
        "candidates_tried": tried,
        "sections": sections,
        "source_format": best["fmt"],
        # PHRASE METADATA — what makes a track cuttable by anyone but this
        # script. phrase_ms and the pool name lived only in the Python spec, so
        # the engine and the wiki could not be phrase-aware at all: they saw a
        # 165-second file and nothing else. Publishing it here is the same fix
        # as composer/assignments.json — the thing that knows publishes what it
        # knows, instead of every consumer re-deriving it from someone else's
        # source. `phrases` is computed from the MASTERED duration, because the
        # master trims lead-in and that shifts every boundary.
        **({"phrase": {
            # THE GRID FOLLOWS THE AUDIO, not the request. A brief asking 140
            # that renders at 137.2 has a real bar of 13.99 s, so cutting on the
            # 13.714 s the request implies drifts ~0.3 s per phrase and lands
            # mid-bar within a dozen phrases. Recompute from the measurement —
            # but only when it is CLOSE, because the tempo estimator halves and
            # doubles, and trusting a 2x reading would be far worse than
            # trusting the brief.
            "phrase_ms": _grid_ms(spec, musical["timing"].get("bpm")),
            "phrase_ms_asked": spec["phrase_ms"],
            "bpm_measured": musical["timing"].get("bpm"),
            "bars": round(spec["phrase_ms"] / 1000 * (spec.get("bpm") or 0) / 60 / 4) or None,
            "phrases": int((len(y) / best["sr"]) * 1000 // _grid_ms(spec, musical["timing"].get("bpm"))),
            # Beat one of the mastered audio: cuts are measured from HERE, not
            # from zero, or the whole grid is offset by the lead-in.
            "beat_anchor_s": musical["timing"].get("beat_anchor_s"),
            "suite": spec.get("suite"),
            "pool": spec.get("pool"),
            "key_asked": spec.get("key_line", "").split(",")[0] or None,
        }} if spec.get("phrase_ms") else {}),
    }


MIMES = {".mp3": "audio/mpeg", ".ogg": 'audio/ogg; codecs="opus"', ".m4a": "audio/mp4"}


def adopt_existing(names: list[str]) -> dict:
    """Measure ALREADY-COMMITTED audio into tracks.json without regenerating it.

    `title` and `night` are APPROVED takes — the maintainer signed off on how
    they sound, so re-rolling them to get metadata would be vandalism, and
    transcoding them into the new container would be a second lossy generation
    on audio that is already finished. Instead we measure the committed file as
    it stands and carry the level correction in `trim_db`, so the approved bytes
    keep playing while joining the same measured loudness system as the new beds.
    Needs no API key.
    """
    out = {}
    for name in names:
        spec = TRACKS.get(name, {})
        stem = spec.get("out", name)
        files = [p for ext in (".ogg", ".m4a", ".mp3")
                 if (p := MUSIC_DIR / f"{stem}{ext}").exists()]
        if not files:
            print(f"  ! {name}: no committed audio at {stem}.(ogg|m4a|mp3) — skipped")
            continue
        y, sr = M.decode(files[0].read_bytes())
        card = M.measure(y, sr)
        musical = M.musical_analysis(y, sr, prior_bpm=spec.get("bpm"))
        loop = M.find_loop(M.to_mono(y), sr, bpm=musical["timing"]["bpm"] or spec.get("bpm"),
                           min_loop_s=min(30.0, card["duration_s"] * 0.45))
        trim = round(M.TARGET_LUFS - card["lufs"], 2)
        print(f"  {name}: {card['duration_s']:.1f}s  lufs {card['lufs']:+.2f} "
              f"→ trim {trim:+.2f} dB  loop {loop['loop_start_s']}→{loop['loop_end_s']}s "
              f"(seam {loop['score']})  key {musical['key']['root']} "
              f"{musical['key']['mode']}  {musical['timing']['bpm']} BPM")
        out[name] = {
            "id": name,
            "files": [{"file": p.name, "mime": MIMES[p.suffix], "size_bytes": p.stat().st_size}
                      for p in files],
            "duration_s": card["duration_s"],
            "bpm": musical["timing"]["bpm"] or spec.get("bpm"),
            "asked_bpm": spec.get("bpm"),
            "musical": musical["key"],
            "timing": musical["timing"],
            "loop": loop,
            # Not re-mastered: the trim is what puts this approved take on the
            # same perceived level as the mastered beds.
            "trim_db": trim,
            "master": {"adopted": True, "lufs_in": card["lufs"]},
            "measured": card,
            "faults": [],
            "candidates_tried": [],
            "sections": [],
            "source_format": files[0].suffix.lstrip("."),
        }
    return out


def write_tracks_json(entries: dict) -> None:
    out = {}
    if TRACKS_JSON.exists():
        try:
            out = json.loads(TRACKS_JSON.read_text()).get("tracks", {})
        except ValueError:
            out = {}
    out.update(entries)
    TRACKS_JSON.write_text(json.dumps({
        "schema": "composer-music@1",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "target_lufs": M.TARGET_LUFS,
        "ceiling_dbtp": M.CEILING_DBTP,
        "tracks": out,
    }, indent=2) + "\n")
    print(f"\nwrote {TRACKS_JSON} ({len(out)} track(s))")


def main() -> int:
    which = sys.argv[1] if len(sys.argv) > 1 else "new"

    # `adopt` only measures files already on disk — no API, no key.
    if which == "adopt":
        rest = [n for n in sys.argv[2:] if n.strip()]
        names = rest or [n for n in TRACKS if (MUSIC_DIR / f"{TRACKS[n]['out']}.mp3").exists()
                         or (MUSIC_DIR / f"{TRACKS[n]['out']}.ogg").exists()]
        print(f"adopting committed audio: {', '.join(names)}")
        entries = adopt_existing(names)
        write_tracks_json(entries)
        return 0 if entries else 1

    key = os.environ.get("ELEVENLABS_API_KEY") or os.environ.get("ELEVEN_LABS_API_KEY")
    if not key:
        print("ELEVENLABS_API_KEY not set — refusing to run (no placeholder audio).")
        return 1
    # `credits` asks the balance and stops. Free, and the only way to plan a
    # campaign: measured 2026-08-22, a take costs ~14 credits per second of
    # music, so the balance says how many minutes are affordable before a run
    # walks into a wall halfway through a suite.
    if which == "credits":
        s2 = requests.Session(); s2.headers.update({"xi-api-key": key})
        # Print the RAW subscription payload as well as the parsed number. The
        # first version of this probe said "unknown" because credits_remaining
        # reads character_limit/character_count, while the quota REFUSAL speaks
        # in "credits" — a different unit. Guessing the field name again would
        # be the same mistake; show what the endpoint actually returns.
        try:
            r = s2.get(SUB_URL, timeout=60)
            print(f"  /user/subscription -> {r.status_code}")
            if r.status_code == 200:
                d = r.json()
                for k, v in sorted(d.items()):
                    if isinstance(v, (int, float, str, bool)) or v is None:
                        print(f"    {k}: {v}")
        except Exception as e:  # noqa: BLE001 — a probe must never crash a run
            print(f"  ! subscription lookup failed: {e}")
        rem = credits_remaining(s2)
        print(f"credits remaining: {rem if rem is not None else 'unknown'}")
        if rem:
            print(f"  ~= {rem / 14:.0f} s of music  ({rem / 14 / 60:.1f} min), "
                  f"or ~{rem / 14 // 100:.0f} takes of 100 s")
        return 0
    # ARGS ARE POSITION-INDEPENDENT: the numeric one is `seconds`, every other
    # one is a track name. This used to be `int(sys.argv[2])`, which assumed the
    # caller passed at most one name — and composer-theme.yml interpolates its
    # `track` input UNQUOTED, so asking it for "cave3 cave4" arrived as two argv
    # entries and the run died on `int("cave4")` before generating anything.
    # The workflow is quoted now, but a runner that splits arguments should not
    # be able to kill a generation run: parse by SHAPE, not by position.
    extra = [a.strip() for a in sys.argv[2:] if a.strip()]
    seconds = next((int(a) for a in extra if a.isdigit()), None)
    more = [a for a in extra if not a.isdigit()]
    if which == "all":
        names = list(TRACKS)
    elif which == "new":
        names = list(NEW_BEDS)
    else:
        names = [n for n in which.replace(",", " ").split() if n] + more

    session = requests.Session()
    session.headers.update({"xi-api-key": key})

    rem = credits_remaining(session)
    # HOW THE SEARCH SPENDS ITS CREDITS. Two ways to look for a good take:
    # roll the SAME brief several times, or write several DIFFERENT briefs and
    # roll each once. A broad campaign should do the second — the maintainer's
    # own instruction, "rewrite the entire prompt often to test new ideas" —
    # because three rolls of one idea explore far less than three ideas, and
    # cost the same. So a run asking for many tracks takes ONE candidate each
    # and lets the breadth be the search; a run asking for one or two is
    # re-rolling a specific brief and still gets three.
    # CANDIDATES=<n> in the environment overrides either way.
    candidates = 1 if len(names) >= 6 else 3
    env_c = os.environ.get("CANDIDATES", "").strip()
    if env_c.isdigit():
        candidates = max(1, min(5, int(env_c)))
    if rem is not None:
        print(f"credits remaining: {rem:,}")
        budget = max(0, rem - CREDIT_FLOOR)
        per_take = 110_000
        affordable = budget // max(1, per_take * len(names))
        candidates = int(max(1, min(candidates, affordable)))
        if budget <= 0:
            print(f"!! credits at/below the {CREDIT_FLOOR:,} floor — refusing to run")
            return 1
    print(f"generating {len(names)} track(s) with {candidates} candidate(s) each")

    out = {}
    rc = 0
    for name in names:
        spec = TRACKS.get(name)
        if not spec:
            print(f"unknown track {name!r} (have: {', '.join(TRACKS)}, 'new', or 'all')")
            rc = 1
            continue
        try:
            entry = build_track(session, name, spec, seconds, candidates)
        except QuotaExhausted as e:
            # OUT OF CREDITS. Every remaining track would be refused, so stop
            # asking — but fall through to write_tracks_json so that everything
            # generated before the wall is kept. On 2026-08-22 this path did not
            # exist: the run kept requesting, exited 1, and the workflow's
            # commit step (which had no `if: always()`) discarded three tracks
            # that were already paid for.
            print(f"\n!! OUT OF CREDITS — {e}")
            print(f"!! stopping. {len(out)} track(s) generated this run are kept; "
                  f"{len(names) - len(out) - 1} not attempted.")
            rc = 1
            break
        except Exception as e:
            print(f"  !! {name} failed: {type(e).__name__}: {e}")
            rc = 1
            continue
        if entry is None:
            rc = 1
            continue
        out[name] = entry

    write_tracks_json(out)
    # A run that produced nothing usable must not look like a success.
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
