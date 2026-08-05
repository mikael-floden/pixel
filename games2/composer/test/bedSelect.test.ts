/**
 * The context score's decision table. Run: npx tsx composer/test/bedSelect.test.ts
 *
 * Music-selection bugs are miserable to find by ear — you have to stand in the
 * right place, on the right map, at the right time of day, and even then "wrong
 * bed" and "right bed, late" sound identical. So the rules are pinned here.
 */

import {
  BED_FALLBACK, BED_NAMES, BedName, BedInputs, desiredBed, resolveBed,
} from "../engine/bedSelect";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

const calm: BedInputs = { threat: 0, cave: 0, fire: 0, town: 0, sun: 1 };
const want = (f: Partial<BedInputs>, cur: BedName | null = null) =>
  desiredBed({ ...calm, ...f }, cur);

// ---- priority: the most urgent TRUE thing wins ----------------------------
check("empty daylight world → adventure", want({}), "adventure");
check("dark → night", want({ sun: 0.1 }), "night");
check("bonfire → home", want({ fire: 0.9 }), "home");
check("village → town", want({ town: 0.8 }), "town");
check("under a roof → cave", want({ cave: 0.9 }), "cave");
check("monsters on me → battle", want({ threat: 0.9 }), "battle");
check("battle outranks everything", want({ threat: 0.9, cave: 0.9, fire: 0.9, town: 0.9, sun: 0 }), "battle");
check("cave outranks home/town/night", want({ cave: 0.9, fire: 0.9, town: 0.9, sun: 0 }), "cave");
check("home outranks town", want({ fire: 0.9, town: 0.9 }), "home");

// PLACE beats TIME — the bug this pins is "everything becomes the night bed
// after dark", which would make town/cave/home pointless for half the cycle.
check("town at night is still town", want({ town: 0.8, sun: 0 }), "town");
check("cave at night is still cave", want({ cave: 0.9, sun: 0 }), "cave");
check("bonfire at night is still home", want({ fire: 0.9, sun: 0 }), "home");

// ---- hysteresis: no dithering on a boundary ------------------------------
// A reading between OFF and ON keeps whatever is playing, either way.
check("mid town reading, town playing → stays town", want({ town: 0.35 }, "town"), "town");
check("mid town reading, nothing playing → not town", want({ town: 0.35 }, null), "adventure");
check("mid battle reading holds battle", want({ threat: 0.45 }, "battle"), "battle");
check("mid battle reading does not start battle", want({ threat: 0.45 }, null), "adventure");
check("battle releases below the low mark", want({ threat: 0.2 }, "battle"), "adventure");
check("night holds through a dawn wobble", want({ sun: 0.45 }, "night"), "night");
check("dawn wobble does not start night", want({ sun: 0.45 }, null), "adventure");

// ---- fallback: nothing may ever be silent -------------------------------
const none = () => false;
const all = () => true;
const only = (...ns: BedName[]) => (n: BedName) => ns.includes(n);

check("all generated → itself", BED_NAMES.map((n) => resolveBed(n, all)), BED_NAMES);
check("none generated → catalog for every bed", BED_NAMES.map((n) => resolveBed(n, none)),
  BED_NAMES.map(() => null));

// THE STATE THIS SHIPS IN, before generation lands: only `night` exists.
// Day must keep the catalog bed (unchanged behaviour) and night must keep
// playing the approved night bed.
const today = only("night");
check("today: adventure → catalog", resolveBed("adventure", today), null);
check("today: night → night", resolveBed("night", today), "night");
check("today: town → catalog", resolveBed("town", today), null);
check("today: home → catalog", resolveBed("home", today), null);
check("today: battle → catalog", resolveBed("battle", today), null);
check("today: cave → night (documented degradation)", resolveBed("cave", today), "night");

// Partial generation must never fall to a bed that is itself missing.
check("battle falls to adventure", resolveBed("battle", only("adventure")), "adventure");
check("home falls to town", resolveBed("home", only("town")), "town");
check("home falls past town to adventure", resolveBed("home", only("adventure")), "adventure");
check("cave falls to night", resolveBed("cave", only("night")), "night");

// Every fallback target must be a real bed, or resolveBed would return a name
// nothing can play.
for (const [from, chain] of Object.entries(BED_FALLBACK)) {
  const bad = chain.filter((n) => !BED_NAMES.includes(n));
  check(`fallback chain for ${from} is well-formed`, bad, []);
}
// A chain must not contain its own head (an infinite-looking degradation).
for (const [from, chain] of Object.entries(BED_FALLBACK)) {
  check(`fallback chain for ${from} excludes itself`, chain.includes(from as BedName), false);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall bed-selection rules hold");
process.exit(failures ? 1 : 0);
