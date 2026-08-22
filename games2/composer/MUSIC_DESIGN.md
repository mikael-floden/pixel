# The score, v2 — suites, pools, phrases

The clean slate (maintainer 2026-08-08). v1 was one linear track per situation.
v1.1 (`*_seq`) added interchangeable phrases but decided nothing about how they
relate to each other, and it showed: measured per phrase, `summit_seq` held its
key in 2 of 15 phrases and `day_seq` in 8 of 15. The material cannot be shuffled
because nothing ever said it had to agree.

v2 decides the agreements FIRST and derives everything else from them.

## The three words, and they are not interchangeable

**PHRASE** — one interchangeable chunk of music. The unit the engine schedules.
OoT calls these segments or chunks.

**POOL** — the phrases for one game state. The engine picks the next phrase from
the pool the player's state names. OoT's Hyrule Field has three: 11 moving,
5 combat, 4 standing still.

**SUITE** — the COMPATIBILITY GROUP, and the answer to "what happens when the
world is a hundred islands". One key, one tempo, one bar length. Everything in a
suite can cross-fade into anything else in it, layer over it, and switch on the
beat, because they agree on the only two things that matter. A `bed` is just one
audio FILE inside a suite — not a compatibility boundary, which is why calling a
suite a bed confuses the design.

    suite  (one key, one tempo)
      └── pool   (explore / idle / combat / arrive)
            └── phrase  (8 bars, ~13.7 s)

Different suites are free to disagree. The home island can be D major and a
frozen island B minor, because you never hear two suites at once: you move
between them at a LOAD or a DOORWAY, where a clean cut is what a player expects
anyway. Inside a suite, nothing ever cuts.

## The decisions, and why

**ONE TEMPO PER SUITE, and it is faster than it feels.** 140 BPM. Every pool in
the suite uses it, including combat — which is what lets combat start on the
next beat instead of crossfading over the top. Combat gets its urgency from
DENSITY (more notes per bar, drums entering), never from a tempo change, because
a tempo change is exactly what makes two phrases un-joinable. A calm pool at 140
is written in half-time feel: long held notes over a fast pulse, which reads as
peaceful. Hyrule Field is ~150 BPM and does not feel like a race.

**EIGHT BARS PER PHRASE = 13.71 s at 140 BPM.** Eight bars is the natural
musical sentence, and at 140 it lands in the 12-16 s window where a phrase is
long enough to be an idea and short enough that a state change feels responsive.
This is the number that sets everything else: `phrase_s = 8 x 4 x 60 / bpm`.

**ONE KEY PER SUITE, stated as a hard constraint.** v1.1's mistake was
describing the harmony once in a section style and hoping. v2 states the key in
the plan's GLOBAL styles and repeats it in every section — "D major throughout,
home note D, no modulation, no key change" — and the generated result is
MEASURED per phrase before it ships. Phrases that drift are rerolled, not
shipped and hoped over.

**FOUR POOLS PER SUITE.**

| pool | phrases | when |
|------|--------:|------|
| explore | 12 | moving through the area — the default, heard most |
| idle | 4 | standing still |
| combat | 6 | a fight |
| arrive | 2 | entering the area; plays once, then hands to explore |

24 phrases x 13.71 s = 329 s of material per suite, and 12 explore phrases means
2.7 minutes before the most-heard pool can repeat — with a shuffled bag, longer.
The proportions follow OoT (11/5/4) because they are proven, with `arrive` added
because our areas have real doorways.

**ONE REQUEST PER POOL.** 329 s exceeds the 300 s per-generation cap, and a
per-pool brief is better anyway: the combat brief can ask for density while the
idle brief asks for space. The cost is that four requests can drift apart in key
— which is precisely why the key is pinned in the brief AND verified by
measurement, with a reroll on failure.

## What the engine needs

Three numbers per suite, and everything else is choosing integers:

    beat_anchor_s   where beat one actually is (already measured)
    phrase_s        one phrase, derived from the tempo
    pools           phrase index -> which pool it belongs to

Playback is a shuffled BAG per pool: play all N in random order, reshuffle,
never repeat inside a cycle. Not uniform random — uniform clusters, and hearing
the same phrase twice in a minute is exactly what a listener catches. A state
change takes effect at the NEXT PHRASE BOUNDARY, which is why switches land on
the beat for free: a boundary is the only place a decision is ever made.

## What this replaces

v1 (`title`, `night`, `cave4`, `summit_triumph`, `battle`) and v1.1 (`*_seq`)
both stay until a v2 suite is auditioned and preferred. Nothing is deleted on a
promise.
