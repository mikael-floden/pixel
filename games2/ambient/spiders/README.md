# spiders/ — the skitter

Three pixels and a suggestion of legs. Same reasoning as `ants/`: too small for
the sprite-art treatment the flocks get, so behaviour does the identifying.

Where an ant is read from the COLUMN it walks in, **a spider is read from the
SKITTER** — a hard dart of a few dozen pixels, a dead stop, then another dart
somewhere slightly different. Nothing else in this world moves like that, so the
motion alone names the animal.

- Solitary: two on screen at most. A crowd of these reads as vermin.
- Dusk and night creatures, but a quarter of them are out by day — a daytime
  walk is not guaranteed spider-free.
- They veer at anything they cannot walk on, and keep `PLAYER_CLEAR` away from
  the player: a spider skittering over your feet is a jump-scare, and this layer
  is atmosphere.
- **So is a change of LEVEL.** A cliff foot is walkable and is drawn a few
  pixels below the plateau standing over it, so a walkability test alone lets a
  skitter run down the cliff face. A dash onto a different terrace is refused
  like a step into water (`flatWith`, over `__ml.pickAt`); the spider re-reads
  its level when it relocates.
- **The edge of the view is one of those walls.** There are at most two spiders
  in the world, so one that skitters off the side of the screen is the whole
  effect gone — measured, a spider spent 17 of 191 frames entirely out of frame.
  It turns `EDGE_TURN` px before the rim; retiring it past `OFF_VIEW` is only
  the backstop for a camera that walks away from it.
- They fade out at the end of their life rather than blinking away.
- **A spider that leaves the view is MOVED, not killed**, and an empty world
  gets its first one in 900 ms instead of waiting the full 7–22 s gap
  (maintainer 2026-09-07: "I see no spiders and ants if I run away to a
  different location ... you can move the simulated ants and spiders to a new
  location"). Retiring an off-view spider is right for one that skittered off
  the edge and wrong for what actually happens — the PLAYER left, stranding the
  population behind. There is nothing to preserve out there (a spider is a
  position, a heading and a timer), so the same one is re-placed on ground in
  the view we are looking at now, keeping its life and its dash/rest phase.

QA: `scripts/verify-crawlers.mjs` — asserts both the dash and the rest states
actually occur (a spider that only glides has lost the one thing that makes it a
spider), that they stay on walkable ground, that they never enter the player's
personal space, that one is ON SCREEN whenever one is drawn, and that they favour night while ants favour day, and that
one appears within four seconds of arriving somewhere new (measured 200 ms).
