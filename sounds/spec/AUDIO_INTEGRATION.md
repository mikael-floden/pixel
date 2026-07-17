# Audio actor — charter & game integration

Decision (owner: product): a dedicated **audio actor** owns the whole audio vertical
end-to-end — **production** (SFX + ambience + music) **and** the **binding** of audio
to gameplay, via a self-contained audio module inside the game. This mirrors the
existing **`games-ui`** actor, which owns UI inside the game through the stable
`HudActions` interface. Audio gets the same treatment.

## Who owns what

| Concern | Owner | Location |
|---|---|---|
| SFX + ambience production | **audio actor** | `sounds/` (this domain) |
| Music production (score, stems, adaptive layers) | **audio actor** | `music/` (new domain — to create) |
| Binding audio → gameplay events (the AudioManager) | **audio actor** | a carved-out module inside the game, e.g. `games2/<app>/client/src/audio/` — **one-writer: the audio actor** |
| Emitting gameplay audio events + owning game logic | **game agent** | the rest of `games2/` |

The audio actor never edits game logic; it only (a) produces assets + contracts in
its own domains, and (b) writes its **own** module inside the game, which subscribes
to a **stable audio-event interface** the game exposes. One writer per file → no
conflicts, per `coordination/PROTOCOL.md`.

## The stable interface (proposed — to agree with the game agent)

Like `HudActions`, the game exposes a thin, stable **`AudioBus`** the game code calls
and the audio module implements/subscribes to. The game emits *semantic* events; it
does not know sound ids or playback rules.

```ts
// exposed by the game, implemented by the audio module (audio actor owns the impl)
interface AudioBus {
  event(name: string, params?: {                 // e.g. "player.footstep", "combat.hit_taken"
    surface?: string;                             // ground tile for footsteps
    position?: {x:number;y:number};               // for distance/pan/occlusion
    region?: string; time?: string; weather?: string;
  }): void;
  setRegion(region: string, time?: string, weather?: string): void;  // ambience + reverb zone
}
```

The game just calls `audio.event("item.coin_pickup")` / `audio.setRegion("forest","night")`.
Everything else — sample choice, round-robin, jitter, ducking, reverb zone,
distance attenuation, adaptive music layering — lives in the audio module.

## The contract the module consumes

- **`sounds/viewer_data.json`** — every sound with `feel`, `mix_gain_db`, `variation`
  (round-robin + jitter), `loop`, and file paths (served at `/assets/sounds/...`).
- **`sounds/bindings.json`** — the proposed **event → sound + playback-rule** map
  (buses, ducking, reverb zones, per-event play mode). This is the turnkey spec: the
  module reads it instead of hard-coding.
- **`music/` contract** (future) — cues/stems per region+mood + adaptive-layer rules.

## Responsibilities checklist (audio actor)

1. Produce + master SFX/ambience (done: 40 sounds) and music (todo: `music/`).
2. Keep `bindings.json` in sync with the catalog and the game's event names.
3. Own the game audio module: implement round-robin + jitter, reverb zones,
   distance/occlusion, side-chain ducking, adaptive music.
4. Coordinate the module boundary + `AudioBus` interface with the game agent (below).

## Rollout

1. **Negotiate the boundary** with the game agent via `coordination/board.py`:
   the audio module directory (one-writer) + the `AudioBus` event interface. (Posted.)
2. Game agent adds `AudioBus` calls at gameplay sites (footstep, pickup, region change).
3. Audio actor implements the module against `bindings.json` + `viewer_data.json`.
4. Stand up `music/` and extend `bindings`/interface for adaptive score.
