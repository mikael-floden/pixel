/* THE ENV TICK'S TWO HALVES, and when the second may share a frame with the
 * first.
 *
 * games-perf split the tick (2026-09-23): the env sample, the field refresh
 * and the gloom raster run on the tick's frame; the director's per-episode
 * coverage waits for the NEXT frame, so a fast frame never carries both.
 * The rule as first written was "the frame after — if that frame is not an
 * env frame itself", and on a client whose EVERY frame is longer than the
 * sample period (a software-GL harness at ~1.4 fps; a phone inside the
 * long-frame bursts the beacon counts by the thousand) every frame is an env
 * frame, so the director's turn never came: its tick count froze at boot and
 * no episode — thunder, birds, bats, sandstorm, leaves — was ever switched
 * on. Measured in the weather gate: 24 director ticks for a whole run, and a
 * server-forced [rain, thunder] with thunder never starting.
 *
 * So: the director waits for its own frame while frames are FAST, and shares
 * the frame when the frame is already longer than the sample period — the
 * next frame would be an env frame too, so waiting is not a deferral, it is
 * never. On a long frame the director's share is a rounding error. Pure, so
 * the server test walks both regimes frame by frame. */

/** Should the director run on THIS frame? `envFrame`: this frame took the
 *  env sample; `due`: an env sample has run since the director last did;
 *  `dtMs`: this frame's wall-clock length; `sampleMs`: the env period. */
export function directorRunsNow(envFrame: boolean, due: boolean, dtMs: number, sampleMs: number): boolean {
  if (!due) return false;
  if (!envFrame) return true;
  return dtMs >= sampleMs;
}
