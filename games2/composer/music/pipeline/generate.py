#!/usr/bin/env python3
"""Generate the composer's OWN score (ElevenLabs Music, music_v1).

The composer has the same generation rights + ELEVENLABS_API_KEY as the music
domain (maintainer 2026-07-19: "free hands"). These tracks are committed under
games2/composer/music/ and bundled by Vite (engine/contextMusic.ts). This does
NOT touch the music/ domain (another agent owns that).

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

def build_track(session: requests.Session, name: str, spec: dict, seconds: int | None,
                candidates: int) -> dict | None:
    secs = seconds or spec["seconds"]
    length_ms = max(10_000, min(300_000, secs * 1000))
    print(f"\n=== {name} (~{secs}s, {candidates} candidate(s)) ===")

    plan = make_plan(session, spec["prompt"], length_ms)
    sections = plan_sections(plan) if plan else []
    if sections:
        print("  plan:", ", ".join(f"{s['name']}:{s['duration_ms'] / 1000:.0f}s" for s in sections))

    best = None
    tried = []
    for i in range(candidates):
        got = compose(session, prompt=spec["prompt"], plan=plan, length_ms=length_ms)
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
        for v in variants:
            dst = MUSIC_DIR / v["file"]
            os.replace(os.path.join(tmp, v["file"]), dst)
            print(f"  wrote {dst.name} ({v['size_bytes'] / 1024:.0f} KB)")

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
    seconds = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].strip() else None
    if which == "all":
        names = list(TRACKS)
    elif which == "new":
        names = list(NEW_BEDS)
    else:
        names = [n for n in which.replace(",", " ").split() if n]

    session = requests.Session()
    session.headers.update({"xi-api-key": key})

    rem = credits_remaining(session)
    # Roughly: one 100 s take costs ~100k characters of the shared pool. Keep a
    # floor so the sound/music agents are never starved by a music run.
    candidates = 3
    if rem is not None:
        print(f"credits remaining: {rem:,}")
        budget = max(0, rem - CREDIT_FLOOR)
        per_take = 110_000
        affordable = budget // max(1, per_take * len(names))
        candidates = int(max(1, min(3, affordable)))
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
