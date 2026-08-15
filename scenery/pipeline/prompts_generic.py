"""The object-agnostic variant ladder, and the four lighting clauses.

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
"""

# --- the ladder --------------------------------------------------------------
# Provisional wording; replaced by the synthesized ladder from the design pass.
LADDER = [
    "Redraw this object in the same style, as another one of the same kind. "
    "It MUST look different. Do not draw the same one again.",
    "Draw the same kind of object again, but a different one.",
    "Another one of the same kind, same art style, different shape.",
    "Same kind of object, same style — but this one turned out differently.",
    "Redraw this as a different individual of the same kind.",
    "Keep the style and the kind. Change the proportions and the arrangement.",
    "A sibling of this one. Same kind, same style, different build.",
    "Same kind and style. Reshape the outline and shift the bulk.",
    "Draw a second one that belongs beside this one. Same kind, same style.",
    "The same kind seen as a different specimen. Same style, new shape.",
    "Same kind and style. Give it DIFFERENT PROPORTIONS and move the largest "
    "masses somewhere else.",
    "Same kind of object. Change the whole shape and outline. It must not "
    "match the old one.",
]

# --- preservation ------------------------------------------------------------
# MEASURED ON THE FIRST PILOT, 2026-08-15. Without this, a warm brown wooden
# barrel came back three times as a GREY STONE barrel, and one variant was drawn
# much larger and from a different camera angle. Both are the failures the
# maintainer already named: "Wrong color palette" on honey_tree_002, and his
# warning that loose wording "will get this AI to start painting and turning
# wood into stone".
#
# This is preservation stated POSITIVELY — what to keep, never what to avoid —
# so it does not trip the noun-negation rule. Short, because it rides on every
# single prompt.
PRESERVE = "Keep the same colours, the same size and the same viewing angle."

# --- lighting ----------------------------------------------------------------
# THE BIGGEST LESSON OF THE PILOT: A SAME-CONDITION VARIANT GETS NO LIGHTING
# CLAUSE AT ALL. Three of every unlit piece's five new states are unlit->unlit,
# where nothing about the lighting changes — and the clause I had there ("cold
# and dark ... its colours dull and unlit") was read as a PALETTE instruction
# and drained the wood grey. Saying nothing is not laziness here; it is the only
# correct instruction, because there is nothing to change.
STAY_LIT = ""
STAY_UNLIT = ""

# Crossing conditions is a real change and must be stated. Naming the CHANGE is
# fine — the maintainer's own working window prompt says "represent lights being
# on inside the house". What is forbidden is naming things incidentally, which
# is what "remove the {glow}" (still in the tree pipeline) and my "cold, dull
# colours" both did.
MAKE_LIT = "This one is lit up and gives off its own light:"
MAKE_UNLIT = "This one is not lit up and gives off no light of its own."
