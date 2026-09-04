"""THE SIZE THE GAME ACTUALLY DRAWS A SCENERY PIECE AT — one rule, one place.

A piece's contract (`scenery/<piece>/scenery.json` `placement`) gives a height
in metres and, derived from it, `world_px_height` with the note "render the
sprite scaled so its height == world_px_height; a character is
character_height_px tall". Every published piece says a character is 64 px.
**The game's people are 88** (`CHARACTER_BODY_PX` in games2/shared/src/index.ts),
so the game keeps the metres and swaps in the person it has: it draws, and
stamps collision with, `world_px_height * 88 / character_height_px` — 1.375x
the contract's number (`sceneryDrawnPx`).

maps2 read the raw contract number instead, and that is one bug with two faces
(maintainer 2026-09-04, overlay screenshot: "Didn't you fix the placement so
the scenery was perfectly centered on a tile? ... the hitbox touches the top
and have a small distance left to the bottom"):

  * the hitbox centre sits at a scaled offset from the art's anchor, so
    centring it at 1/1.375 of that offset left every footprint UP-SCREEN of
    the cell it blocks — measured over the_game, median 3.0 px, always up;
  * every piece in `render3.py` was drawn 27% smaller than in the game, so the
    reference render — the thing the maintainer and I both judge from — was
    never showing the crowding the game shows.

Both go away by asking here. The constant is READ OUT OF games2's source, not
copied: if the game re-bases to a different person, this follows or the build
dies with a message that says so.
"""

from __future__ import annotations

import os
import re

_HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(_HERE))
_SRC = os.path.join(REPO, "games2", "shared", "src", "index.ts")

CONTRACT_CHARACTER_PX = 64.0     # SCENERY_CONTRACT_CHARACTER_PX, the fallback


def _character_body_px() -> float:
    """games2's own CHARACTER_BODY_PX. Parsed, never copied - a number that
    lives in two files is a number that will disagree with itself."""
    src = open(_SRC, encoding="utf-8").read()
    m = re.search(r"export const CHARACTER_BODY_PX\s*=\s*([0-9.]+)", src)
    assert m, ("games2/shared/src/index.ts no longer exports CHARACTER_BODY_PX "
               "- scenery scale cannot be derived; read sceneryDrawnPx there "
               "and fix maps2/pipeline/sceneryscale.py")
    return float(m.group(1))


CHARACTER_BODY_PX = _character_body_px()


def drawn_px(wph, contract_character_px=None):
    """The art-px height the game draws `wph` at, or None when the piece
    publishes no height. Mirrors games2 `sceneryDrawnPx` exactly."""
    if not isinstance(wph, (int, float)) or not wph > 0:
        return None
    c = contract_character_px if isinstance(contract_character_px, (int, float)) \
        and contract_character_px > 0 else CONTRACT_CHARACTER_PX
    return wph * CHARACTER_BODY_PX / c


def drawn_px_for(facts):
    """Same, from a `games2/config/scenery-bbox.json` `pieces[<piece>]` record
    ({"wph": .., "cpx": ..})."""
    if not facts:
        return None
    return drawn_px(facts.get("wph"), facts.get("cpx"))
