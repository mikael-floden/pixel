"""Heuristic animation-name -> game-state classifier.

The 5 game states are idle / walk / angry / attack / die. The maintainer words
each animation freely in the PixelLab UI ("Jumps like a frog" is a walk,
"Melts to lava and dissapers" is a die), so state mapping is judgment. The
authoritative per-monster mapping lives in config/roster.json:renames — this
classifier only supplies a BEST-EFFORT default when a newly tagged monster
shows up that no one has mapped yet; sync flags anything it couldn't place so
the maintainer (or agent) can pin it in the roster.

Order matters: attack words are checked before die words ("Angry root attack"
is an attack even though "angry" appears; "Angry water explosion then reappear"
is an attack, not a death), and angry only matches idle-ish animations.
"""

from __future__ import annotations

import re

STATES = ("idle", "walk", "angry", "attack", "die")

_ATTACK = r"attack|bite|slam|slash|spike|spit|kick|sword|swing|burst|skull|" \
          r"explosion|splash|rip up|crush|claw|headbutt|charge|smash|stomp|tusk"
_DIE = r"die|dies|dead|death|faint|fade|melt|dissap|disap|evaporat|skeleton|" \
       r"ash|crumble|pile|burns up|merges with the ground|despawn|vanish|" \
       r"cut in half|falls? (dead|to the floor|down)|unconscious"
_WALK = r"walk|run|jump|hop|skip|crawl|fly|flying|hover|glide|slither|" \
        r"moving forward|move forward|march|stride|locomot|step"
_ANGRY_MOOD = r"angry|irritated|frustrat|rage|aggro|grumpy"
_IDLE = r"idle|breath|calm|peaceful|still|subtle|stance|rest"


def classify(name):
    """Best-effort state for one animation name, or None when unsure."""
    n = re.sub(r"^custom-", "", (name or "").lower()).replace("\n", " ")
    if re.search(_ATTACK, n):
        return "attack"
    if re.search(_DIE, n):
        return "die"
    if re.search(_WALK, n):
        return "walk"
    if re.search(_ANGRY_MOOD, n) and re.search(_IDLE, n):
        return "angry"
    if re.search(_IDLE, n):
        return "idle"
    return None


def propose_renames(anim_names):
    """{exact name -> state} for every classifiable name, first-come-first-
    served per state (a second idle-ish animation stays unmapped rather than
    silently colliding). Also returns the list of unplaced names."""
    renames, unplaced = {}, []
    used = set()
    for name in anim_names:
        s = classify(name)
        if s and s not in used:
            renames[name] = s
            used.add(s)
        else:
            unplaced.append(name)
    return renames, unplaced
