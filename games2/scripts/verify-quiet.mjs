// No sound the maintainer did not ask for.
//
// The combat/loot work started emitting a swing per attack, a hit per blow, a
// chime per pickup and a broadcast chime on every player's level-up. All of it
// was REMOVED — the call sites are gone, not muted behind a flag — so this gate
// is a SOURCE check: the game must not emit those events at all. A mute could
// be flipped back by accident; a deleted call has to be deliberately rewritten.
//
// Runs with no browser and no dev stack: node scripts/verify-quiet.mjs
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOT = new URL("..", import.meta.url).pathname;

// Events nothing may emit until there is foley the maintainer has approved.
const FORBIDDEN = ["tool.sword_swing", "combat.hit_taken", "item.get", "progress.level_up"];
// Approved in their own rounds — these must KEEP being emitted, so that
// "silence everything" can never quietly pass this gate.
const REQUIRED = ["player.jump", "player.fall", "ui.press", "ui.release", "ui.notify"];

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|mts|mjs)$/.test(name)) files.push(p);
  }
})(join(ROOT, "client", "src"));
files.push(join(ROOT, "composer", "engine", "api.ts"));

let failed = 0;
const emitted = new Map(); // event name -> [file:line]
for (const file of files) {
  const src = readFileSync(file, "utf8");
  src.split("\n").forEach((line, i) => {
    // Only real emissions, not the comments that explain why they are gone.
    const m = line.match(/gameAudio\.event\(\s*["']([^"']+)["']/);
    if (!m) return;
    const rel = file.slice(ROOT.length);
    emitted.set(m[1], [...(emitted.get(m[1]) ?? []), `${rel}:${i + 1}`]);
  });
}

for (const name of FORBIDDEN) {
  const hits = emitted.get(name);
  if (hits) {
    console.log(`FAIL  "${name}" is emitted again at ${hits.join(", ")}`);
    failed++;
  } else {
    console.log(`  removed: ${name}`);
  }
}
for (const name of REQUIRED) {
  if (!emitted.has(name)) {
    console.log(`FAIL  "${name}" is no longer emitted — approved audio was lost`);
    failed++;
  } else {
    console.log(`  still emitted: ${name}`);
  }
}

// Anything NEW that starts emitting should be a deliberate, reviewed decision.
const known = new Set([...FORBIDDEN, ...REQUIRED, "ui.confirm"]);
for (const name of emitted.keys()) {
  if (!known.has(name) && !name.includes("$")) {
    console.log(`NOTE  "${name}" is emitted and not in this gate's list — ` +
      `if it is new, the maintainer should hear it before it ships`);
  }
}

console.log(failed ? `\nverify-quiet: ${failed} FAILURE(S)` : "\nverify-quiet: ALL OK");
process.exit(failed ? 1 : 0);
