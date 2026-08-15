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

# --- lighting ----------------------------------------------------------------
# MAKE_UNLIT is the rule-1 trap: it is a removal. The tree pipeline still says
# "remove the {glow}", which names the very thing that must disappear. This says
# what a dark object LOOKS like instead.
MAKE_LIT = "This one is lit from within and gives off light in the dark:"
STAY_LIT = "This one also gives off light:"
MAKE_UNLIT = ("This one is cold and dark, lit only by the surrounding scene, "
              "its colours dull and unlit.")
STAY_UNLIT = "This one is cold and dark, lit only by the surrounding scene."
