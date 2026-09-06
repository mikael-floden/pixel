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
- They fade out at the end of their life rather than blinking away.

QA: `scripts/verify-crawlers.mjs` — asserts both the dash and the rest states
actually occur (a spider that only glides has lost the one thing that makes it a
spider), that they stay on walkable ground, that they never enter the player's
personal space, and that they favour night while ants favour day.
