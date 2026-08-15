"""The object-agnostic variant ladder, and the lighting clauses.

ONE ladder runs over barrels, cairns, lamps, beds, boats, moss patches and
waterfalls, so NO RUNG MAY NAME AN OBJECT, A MATERIAL OR A PART. Rung 0 is used
for every first attempt; each later rung is reached only after the gate found
the result too close to the source, so force climbs down the list.

THE ONE RULE THAT SHAPES ALL OF THIS. Negating a NOUN backfires — every material
noun lands in the model's conditioning as something to render, which is why
"no handle" produces a handle. The maintainer, after a prompt of mine failed:
"I dont mention things like 'glass panes', 'the shutters', 'the stone', 'the
woodgrain', 'the paint'. Those word will get this AI to start painting and
turning wood into stone." Negating a BEHAVIOUR is fine — "do not draw the same
one again" names an action, not a thing. Removals are therefore written as
POSITIVE descriptions of the desired end state.

Second rule: short beats long. His 231-character window prompt succeeded where
my 690-character one failed outright.

PROVENANCE. The ladder below was designed by four independent passes scored by
three judges on separate axes, then synthesized. Every one of the three judges
independently flagged the same defect in the strongest candidate: it carried NO
COLOUR ANCHOR, and its most forceful rungs explicitly released the palette
("nothing else the same") at exactly the rungs the retry gate reaches most.
That is the "Wrong color palette" rejection waiting to happen — and it is the
same fault the first live pilot produced, where a warm brown wooden barrel came
back three times as a grey stone one. Two independent routes, one conclusion,
so "same colours" now rides on 11 of the 12 rungs.
"""

# --- the ladder --------------------------------------------------------------
# Rung 1 is deliberately bare and deliberately soft: it mirrors the proven tree
# ladder's second rung and lets a mild retry succeed cheaply before force ramps.
# The middle rungs each introduce ONE new axis — shape, then size/proportion,
# then outline — so force rises a notch at a time rather than four paraphrases
# of the same demand. The bluntest rungs stay at the bottom, because
# MAX_PROMPT_TRIES is derived from this list's LENGTH and the last rungs only
# ever run after the structural gate has already rejected a near-copy.
#
# NO PAIR OR ROW FRAMING ANYWHERE ("a companion piece", "side by side with the
# first", "a whole row of these"). Those are composition instructions to an
# image model and the likely return is several objects in one sprite.
LADDER = [
    "Redraw this in the same style and colours, but another one of the same "
    "kind. It MUST look different. Do not draw the same one again.",
    "Draw the same kind again, but a different one.",
    "Redraw this as a different individual of the same kind. Same style, "
    "same colours.",
    "Another of the same kind, same style and colours. Give it a different shape.",
    "Same kind, same style, same colours. Change its size and proportions.",
    "Same kind, same style, same colours. Give it a different outline.",
    "Same kind, same style, same colours. New shape, new layout.",
    "Same kind and style, same colours. Change both the proportions and the "
    "outline. Do not repeat the old shape.",
    "Same kind. Same style. Same colours. DIFFERENT SHAPE. Do not repeat the "
    "old one.",
    "Same kind, same style, same colours. Change the whole shape. It must not "
    "match the old one.",
    "Same kind, same style, same colours, nothing else the same. CHANGE THE "
    "SHAPE AND THE LAYOUT.",
    "Start over and draw a new one of these from scratch. Same kind, same "
    "style, same colours, nothing else the same. Do not repeat the old shape.",
]

# --- framing -----------------------------------------------------------------
# MEASURED ON THE FIRST PILOT. One barrel variant came back drawn much larger
# and from a different camera angle — the sprite no longer matched its siblings,
# which makes the states unusable as variants of one piece.
#
# This says nothing about the object's own SIZE, on purpose: rung 4 deliberately
# varies size and proportions, and a clause saying "same size" would contradict
# it. The defect is the CAMERA and how much of the frame the subject fills, so
# that is all this pins. Colour is left to the ladder, which now carries it.
#
# NO VERB OF POSTURE OR SUPPORT. An early draft said "it stands…", which is
# wrong for rugs, moss patches, tar pools and hanging cliff vines, and enough to
# make the model reorient the piece.
PRESERVE = "Draw it from the same angle, filling the frame the same way."

# --- lighting ----------------------------------------------------------------
# A SAME-CONDITION VARIANT GETS NO LIGHTING CLAUSE AT ALL. Three of every unlit
# piece's five new states are unlit->unlit, where nothing about the lighting
# changes. The clause that used to sit here ("This one is cold and dark ... its
# colours dull and unlit") was read as a PALETTE instruction and drained warm
# wood grey across the whole pilot. Saying nothing is not laziness; it is the
# only correct instruction, because there is nothing to change.
STAY_LIT = ""
STAY_UNLIT = ""

# Crossing conditions IS a real change and must be stated.
#
# MAKE_LIT may name light freely: it is an ADDITION, so every noun in it is
# something we WANT rendered — the noun rule only bites on removals. It ends
# with a COLON because the group's own glow concept is appended straight after
# it, and reads as "...its own light in the dark: embers along its seams."
#
# MAKE_UNLIT is the trap, and is only ever reached when the anchor really is
# lit, so "has gone out" is literally true. It names nothing that must
# disappear: no glow, flame, ember, spark, lamp or torch. "quiet and still"
# suppresses residual flicker without naming it. "stone cold" and "dull
# colours" were both rejected while drafting — the first smuggles in a material
# noun that starts turning things to stone, the second re-opens the palette.
MAKE_LIT = "This time it should glow and give off its own light in the dark:"
MAKE_UNLIT = "This time it has gone out. It is dark now, quiet and still."
