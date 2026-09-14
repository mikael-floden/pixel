/* A LANDING PUFF — the pure half, so `server/test/dust.test.ts` can pin the
 * physics and `dust.ts` only pools sprites.
 *
 * WHAT MAKES IT READ AS AN IMPACT rather than as a firework: the specks go
 * OUT, not up. A ring that rises reads as a spell; a ring that skims the
 * ground, slows hard and settles reads as something heavy arriving. So the
 * outward speed is large, the upward kick is small, drag is strong, and every
 * speck ends on the floor it started from.
 *
 * THE RING IS ISO. The player's feet sit on the ground plane, where a step is
 * 32 px wide to 14 tall, so a circle of specks drawn round them must be
 * squashed the same way or the puff reads as a hoop standing up out of the
 * floor — the same trap the fish rings had.
 *
 * A FALL IS NOT A HOP. Both end with feet on the ground, and the difference
 * is the whole point: a hop lands soft (a few specks, barely clear of the
 * boot) and a drop off a ledge throws a wide ring. One `power` drives count,
 * spread, speed and life together, so there is no way to tune them apart and
 * have a heavy landing look light.
 */

/** Ground-plane squash: a step is this much shorter down the screen. */
export const ISO_SQUASH = 14 / 32;

/** How long a speck lives, ms, at the softest and hardest landing. */
export const LIFE_MS: readonly [number, number] = [300, 700];
/** Specks thrown, at the softest and hardest landing. */
export const SPECKS: readonly [number, number] = [4, 11];
/* Outward speed, px/s on the ground plane. THESE ARE SIZED BY WHAT THE RING
 * HAS TO CLEAR: the player's own boots. The first cut ran 26 px/s into a 4.2
 * drag over a 260 ms hop, which reaches FOUR PIXELS — a cluster of specks
 * entirely underneath the character, invisible in two shots out of three.
 *
 * THE RING MUST CLEAR THE BOOTS, and that sets the floor. Ambient draws below
 * the player (the lit-copy band above it belongs to the game), so a puff that
 * stays inside the body silhouette is a puff nobody ever sees — measured, a
 * ~13 px ring put ZERO specks outside the character. A humanoid here is about
 * 28 px across at the feet, so the hop reaches ~22 and the fall ~41: both are
 * outside the legs within a frame or two, and what the legs do cover is the
 * near half, which is the half that SHOULD be behind them.
 *
 * AND IT HAS TO GET THERE WHILE IT IS STILL BRIGHT. Drag sets that, not the
 * speed: with a gentle drag the ring only reaches its full width as it fades,
 * so every speck is inside the body for the whole time anyone can see it —
 * measured, ZERO specks were both clear of the character and above a fifth of
 * their alpha. The time constant is 1/DRAG, so a brisk drag with a big launch
 * speed puts the ring at ~78% of its reach by a third of its life and then
 * parks it. Final reach is exactly SPEED/DRAG. */
export const SPEED: readonly [number, number] = [220, 420];
/** The upward kick, px/s — enough to clear the ground by about 3 px on a hop
 *  and 5 on a drop. Small on purpose: see the file note.
 *
 *  THE KICK IS CAPPED BY THE LIFE, not chosen freely: flight time is 2k/G, and
 *  a speck still rising when its puff fades is dust that evaporates in mid-air.
 *  At the jitter's widest (x1.4) a hop's speck is down in 280 ms of its 300,
 *  and a fall's in 560 of its 700. */
export const KICK: readonly [number, number] = [26, 52];
/** Gravity on the kick, px/s². Brisk, so the specks are down well inside the
 *  puff's life rather than still rising when it fades. */
export const GRAVITY = 260;
/** Outward drag, per second: the ring stalls rather than sailing. */
export const DRAG = 10;
/** Alpha a speck starts at; it only ever fades from here. */
export const ALPHA = 0.9;

/** 0..1 for a hop (`0`) through the hardest fall. `fallV` is the game's own
 *  fall velocity at touchdown; `0` or absent means it was a hop. */
export const FALL_V_FULL = 22;
export function powerOf(fallV: number): number {
  if (!(fallV > 0)) return 0;
  return Math.max(0, Math.min(1, fallV / FALL_V_FULL));
}

const lerp = (r: readonly [number, number], t: number) => r[0] + (r[1] - r[0]) * t;

/** How many specks a landing of this power throws. */
export function speckCount(power: number): number {
  return Math.round(lerp(SPECKS, Math.max(0, Math.min(1, power))));
}

/** How long they last. */
export function puffLife(power: number): number {
  return lerp(LIFE_MS, Math.max(0, Math.min(1, power)));
}

export interface Speck {
  /** Ground-plane offset from the feet, px (y already squashed). */
  x: number;
  y: number;
  /** Height above the ground, px. Never negative — it lands and stays. */
  alt: number;
  alpha: number;
}

/** One speck of a puff at age `t` ms. `i` of `n` sets its bearing, `jitter`
 *  (0..1) breaks the ring up so it is not a clock face, and `power` scales
 *  everything that makes a heavy landing heavy. */
export function speckAt(i: number, n: number, t: number, power: number, jitter: number, life: number): Speck {
  const p = Math.max(0, Math.min(1, power));
  const age = Math.max(0, t) / 1000;
  // bearing: evenly spread, then nudged, so the ring is even but not a dial
  const bearing = ((i + 0.5) / n) * Math.PI * 2 + (jitter - 0.5) * (Math.PI / n);
  // OUT, with drag: distance under exponential decay, so it stalls
  const v0 = lerp(SPEED, p) * (0.75 + 0.5 * jitter);
  const reach = (v0 / DRAG) * (1 - Math.exp(-DRAG * age));
  // UP, then down under gravity, and it never goes below the floor
  const k0 = lerp(KICK, p) * (0.6 + 0.8 * jitter);
  const alt = Math.max(0, k0 * age - 0.5 * GRAVITY * age * age);
  const u = Math.max(0, Math.min(1, (t / life) || 0));
  return {
    x: Math.cos(bearing) * reach,
    y: Math.sin(bearing) * reach * ISO_SQUASH,
    alt,
    // holds, then eases away — a linear fade reads as a dimmer switch
    alpha: ALPHA * Math.pow(1 - u, 1.5),
  };
}

/** Is the puff over? */
export function puffDone(t: number, life: number): boolean {
  return t >= life;
}
