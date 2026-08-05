// No sound the maintainer did not ask for — and every assignable action exists.
//
// The model since 2026-08-05: the game EMITS semantic events freely (the wiki
// lists emitted-but-silent events so the Game Master can assign sounds to
// them), and the composer's engine plays an event ONLY through one of:
//   - EVENT_ASSIGNMENTS  (the Game Master's wiki picks, wired from
//     live/tuning/sfx_requests.json)
//   - the approved voice branch (player.jump / player.fall)
//   - EVENT_FOLEY        (the approved UI clicks)
//   - bindings.json, but ONLY for BINDINGS_APPROVED names
// This gate parses api.ts for that entire can-sound surface and fails if it
// grows beyond the approved list — a new noise needs a wiki assignment or the
// maintainer's explicit sign-off, never a code-only addition. It also fails if
// a required action stops being emitted (the wiki could no longer assign it)
// or an approved sound stops being emitted.
//
// Runs with no browser and no dev stack: node scripts/verify-quiet.mjs
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOT = new URL("..", import.meta.url).pathname;

// Every event name allowed to MAKE A SOUND without a new maintainer decision.
const APPROVED_SOUNDING = new Set([
  "player.jump", "player.fall",                    // voice grunts (approved 07-25)
  "ui.press", "ui.release",                        // tactile pair (approved 07-18)
  "ui.cursor_move", "ui.confirm", "ui.cancel", "ui.error", // legacy clicks, same family
  "ui.notify",                                     // chat ping (bindings, pre-combat)
]);

// Actions that MUST be emitted so the wiki can list them for assignment
// (maintainer 2026-08-05: dmg, kick, punch, monster killed, cross on/off,
// player dies, item pickup, item drop).
const REQUIRED_ACTIONS = [
  "combat.hit_taken", "combat.kick", "combat.punch", "combat.monster_die",
  "combat.cross_on", "combat.cross_off", "player.die", "item.pickup", "item.drop",
];
// Approved sounds that must keep being emitted (an over-eager cleanup that
// silences the whole game must not pass).
const REQUIRED_APPROVED = ["player.jump", "player.fall", "ui.press", "ui.release", "ui.notify"];

let failed = 0;
const fail = (m) => { console.log(`FAIL  ${m}`); failed++; };

// ---- the engine's can-sound surface, parsed from api.ts -------------------
const api = readFileSync(join(ROOT, "composer", "engine", "api.ts"), "utf8");
const block = (re, label) => {
  const m = api.match(re);
  if (!m) { fail(`cannot find ${label} in api.ts — gate is blind, fix the regex`); return ""; }
  return m[0];
};
const names = (src) => [...src.matchAll(/["']([a-z][a-z0-9_.]*)["']\s*[,:\]]/gi)].map((m) => m[1]);

const bindingsApproved = names(block(/BINDINGS_APPROVED = new Set<string>\(\[[^\]]*\]/s, "BINDINGS_APPROVED"));
const eventFoley = names(block(/EVENT_FOLEY: Record<string, string> = \{[^}]*\}/s, "EVENT_FOLEY"))
  .filter((n) => n.includes("."));
const assignBlock = block(/const EVENT_ASSIGNMENTS: Record<string, EventAssignment> = \{[^;]*\};/s, "EVENT_ASSIGNMENTS");
const assigned = [...assignBlock.matchAll(/["']([a-z][a-z0-9_.]+)["']\s*:\s*\{/gi)].map((m) => m[1]);

for (const n of [...bindingsApproved, ...eventFoley]) {
  if (!APPROVED_SOUNDING.has(n)) fail(`"${n}" can sound via ${bindingsApproved.includes(n) ? "bindings" : "EVENT_FOLEY"} but is not on the approved list`);
}
console.log(`  can-sound (approved): ${[...eventFoley, ...bindingsApproved].join(", ")}`);
console.log(assigned.length
  ? `  can-sound (wiki-assigned): ${assigned.join(", ")}`
  : "  can-sound (wiki-assigned): none yet");

// ---- what the game emits --------------------------------------------------
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|mts|mjs)$/.test(name)) files.push(p);
  }
})(join(ROOT, "client", "src"));

const emitted = new Set();
for (const file of files) {
  for (const m of readFileSync(file, "utf8").matchAll(/gameAudio\.event\(\s*["']([^"']+)["']/g))
    emitted.add(m[1]);
}

for (const n of REQUIRED_ACTIONS) {
  if (!emitted.has(n)) fail(`action "${n}" is not emitted — the wiki cannot list it for assignment`);
  else console.log(`  assignable action emitted: ${n}`);
}
for (const n of REQUIRED_APPROVED) {
  if (!emitted.has(n)) fail(`approved "${n}" is no longer emitted — approved audio was lost`);
}
// An assignment for an event nobody fires is dead wiring — worth a loud note.
for (const n of assigned) {
  if (!emitted.has(n)) console.log(`NOTE  assignment for "${n}" but nothing emits it (dead wiring?)`);
}

console.log(failed ? `\nverify-quiet: ${failed} FAILURE(S)` : "\nverify-quiet: ALL OK");
process.exit(failed ? 1 : 0);
