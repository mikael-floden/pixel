// THE NAV SLIDE ANGLE — his Settings dial (maintainer 2026-09-18, running
// bottom-right into the hearth house's east wall: "the nav system kicks in and
// runs the character out the door! This feels too extreme... What I'm asking
// for here is to let the player's input control the character until the very
// end/corner... we need a threshold here for how much the stick can diverge
// from perpendicular into the wall before the player starts to find a route
// around... Let's set the slider at the beginning to 45 degrees").
//
// Screen degrees off the wall's NORMAL. Within it a push into a terrain wall
// is the player's: the movement tick slides the body by what the wall does not
// cancel and the nav plans nothing until the slide is cornered (shared
// `walkHeading`, rule 0; the measure is `wallAngleDeg`). Past it the thumb is
// leaning along the wall and the nav helps round in that direction as before —
// still one cell back at most. 0 hands every push to the nav (yesterday's
// behaviour); 90 never plans until cornered.
import { NAV_SLIDE_DEG_MIN, NAV_SLIDE_DEG_MAX, NAV_SLIDE_DEG_DEFAULT } from "@nangijala/shared";
import { makeDial } from "./dial";

const dial = makeDial({
  key: "ml-nav-slide",
  min: NAV_SLIDE_DEG_MIN,
  max: NAV_SLIDE_DEG_MAX,
  def: NAV_SLIDE_DEG_DEFAULT,
  decimals: 0,
  label: "Nav slide angle",
  text: (v) => (v <= 0 ? "0° (nav on every push)" : `${Math.round(v)}°${Math.round(v) === NAV_SLIDE_DEG_DEFAULT ? " (default)" : ""}`),
  resetTitle: "back to 45 degrees off the wall's normal",
});

/** Degrees off a wall's normal within which a push stays the player's. */
export const navSlideDeg = () => dial.get();
export const setNavSlideDeg = (v: number) => dial.set(v);
export const ensureNavSlideDial = () => dial.ensure();
