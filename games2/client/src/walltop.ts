// THE LOWERED WALL'S TOP — his Settings dial (maintainer 2026-09-18: "when we
// lower the wall the top of the lowered wall should be the same
// material/ground type as the roof... I don't want plain black here! If
// something we can make this 50% darker but not black! Let's make a slider
// instead with how much darker this part should be! When the slider is at
// 100% darkened the walls inside are black. At 0% the game is like today").
//
// The material is the resolver's (tiles3.ts, Tiles3Cell.cutCap: the roof deck's
// ground over the wall, else the rock the wall is cut through); this dial is
// the darkening painted over that lid, 0..100%, 50 his opening number. A
// change repaints the cut cells (WorldScene polls it with the other dials).
import { makeDial } from "./dial";

export const WALL_TOP_DARK_MIN = 0;
export const WALL_TOP_DARK_MAX = 100;
export const WALL_TOP_DARK_DEFAULT = 50;

const dial = makeDial({
  key: "ml-wall-top-dark",
  min: WALL_TOP_DARK_MIN,
  max: WALL_TOP_DARK_MAX,
  def: WALL_TOP_DARK_DEFAULT,
  decimals: 0,
  label: "Lowered wall top darkening",
  text: (v) => (v <= 0 ? "0% (the roof as it is)" : v >= 100 ? "100% (black)" : `${Math.round(v)}%${Math.round(v) === WALL_TOP_DARK_DEFAULT ? " (default)" : ""}`),
  resetTitle: "back to 50% darker",
});

/** 0..1: how much darker a lowered wall's top is painted than the roof material. */
export const wallTopDark = () => dial.get() / 100;
export const setWallTopDark = (v: number) => dial.set(v);
export const ensureWallTopDial = () => dial.ensure();
