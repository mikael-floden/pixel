// THE DOORWAY CROSSING'S SPEED — the one dial the crossing never had.
//
// Every other part of this transition is his by eye: the wall height, the
// indoor dials, and the fade itself, which he tuned twice in one day (first
// 2x, then "twice as fast is not enough, 3x", both directions). What none of
// them could do is SLOW IT DOWN, and that is what a one-frame report needs:
// "the last frame when fading from indoor to outdoor the entire house
// sometimes light up" (2026-09-15) is about 16ms of a 0.39s crossing on a
// phone, and the headless rig renders that whole stretch as ONE frame, so no
// capture here can see what he sees. At 0.15x it is two and a half seconds and
// anyone can watch it.
//
// The dial multiplies the ROLL RATE, so 1.00 is exactly today's picture and
// nothing downstream changes: the debris' 3x curves, the light grade's 1.5x
// and the landing are all functions of the mix, not of wall-clock, so they
// stretch with it and keep their proportions.
//
// THE COST AT A SLOW SETTING, and it is the interesting one: the exit keeps
// drawing the CUT world under an opaque debris layer until the light grade
// lands, and that layer carries a BUILD-TIME view cull. Stretch the crossing
// and a running player drags the camera past what the layer covers — the very
// artefact the 1.5x grade was chosen to bound ("~60px of camera drift against
// OCC_CULL_PAD's ~360"). So a slow setting can show a fault the default cannot,
// which for an instrument is the point, and is why the default is his 1.00.

import { makeDial } from "./dial";

export const DOOR_FADE_MIN = 0.1;
export const DOOR_FADE_MAX = 2;
export const DOOR_FADE_DEFAULT = 1;

const dial = makeDial({
  key: "ml-door-fade",
  min: DOOR_FADE_MIN,
  max: DOOR_FADE_MAX,
  def: DOOR_FADE_DEFAULT,
  decimals: 2,
  label: "Doorway fade speed",
  text: (v) =>
    Math.abs(v - DOOR_FADE_DEFAULT) < 0.005
      ? "1.00x (his)"
      : v <= 0.2001
        ? `${v.toFixed(2)}x (slow motion)`
        : `${v.toFixed(2)}x`,
  resetTitle: "back to the tuned crossing speed",
});

/** Multiplier on the indoor blend's roll rate. 1 = the tuned crossing. */
export const doorFadeSpeed = () => dial.get();
export const setDoorFadeSpeed = (v: number) => dial.set(v);
export const ensureDoorFadeDial = () => dial.ensure();
