/**
 * games2/composer — the COMPOSER actor (see sounds/spec/AUDIO_INTEGRATION.md).
 *
 * Binds the producers' audio contracts to the running game:
 *   sounds/viewer_data.json + bindings.json   (sound actor: SFX + ambience)
 *   music/viewer_data.json + metadata.json    (musician actor: the score)
 *
 * The game code talks ONLY to `gameAudio` — semantic events in, mixed audio
 * out. See composer/README.md for the event API and the mixing model.
 */

import { GameAudio } from "./engine/api";

export type { AvatarFrame, FieldSample } from "./engine/api";
export type { PlayOpts } from "./engine/oneshot";

/** The one audio authority for the page. */
export const gameAudio = new GameAudio();
