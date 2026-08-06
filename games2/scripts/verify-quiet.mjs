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
import { spawnSync } from "child_process";
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
  "progress.level_up", // bound but EMPTY (maintainer 2026-08-05)
];

// Names that must NOT exist anywhere: removed events whose bindings/emissions
// were left dangling once (maintainer: "never ever do that again"). item.get
// was a SECOND name for the moment the game emits as item.pickup.
const REMOVED_NAMES = ["item.get", "tool.sword_swing"];
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
// Anchored on the closing `\n};` at column 0, NOT on "no semicolon until the
// end": a `;` inside a COMMENT in the table truncated the match and blinded
// this gate the first time a comment there used one. It failed loudly, which
// is the point — but the fix belongs in the regex, not in the prose.
const assignBlock = block(/const EVENT_ASSIGNMENTS: Record<string, EventAssignment> = \{[\s\S]*?\n\};/s, "EVENT_ASSIGNMENTS");
// `@<uid>` scopes an assignment to ONE character (the wiki's own spelling,
// `player.jump@default_girl`); the event the game emits is the part before it.
const assigned = [...assignBlock.matchAll(/["']([a-z][a-z0-9_.@]+)["']\s*:\s*\{/gi)].map((m) => m[1]);

for (const n of [...bindingsApproved, ...eventFoley]) {
  if (!APPROVED_SOUNDING.has(n)) fail(`"${n}" can sound via ${bindingsApproved.includes(n) ? "bindings" : "EVENT_FOLEY"} but is not on the approved list`);
}
console.log(`  can-sound (approved): ${[...eventFoley, ...bindingsApproved].join(", ")}`);
console.log(assigned.length
  ? `  can-sound (wiki-assigned): ${assigned.join(", ")}`
  : "  can-sound (wiki-assigned): none yet");

// ---- no route points at a foley set that isn't there ----------------------
// The wiki lets the maintainer REJECT takes, and a set whose every take is
// rejected gets deleted. A route left pointing at a deleted set is the same
// dangling-reference bug as a binding for a removed event ("never ever do
// that again"): the event silently stops sounding and nothing says so. Every
// set an ACTIVE route names must exist on disk. (`thunder` is deliberately
// NOT checked — it has no set today by the maintainer's verdict, and its
// lookup is documented as the way a regenerated set comes back.)
const foleySets = new Set(
  readdirSync(join(ROOT, "composer", "foley"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "pipeline")
    .map((d) => d.name),
);
const routedSets = [
  ...Object.entries({ EVENT_FOLEY: /EVENT_FOLEY: Record<string, string> = \{[^}]*\}/s,
                      FOOTSTEP_SETS: /FOOTSTEP_SETS: Record<string, string> = \{[^}]*\}/s,
                      JUMP_VOICE: /const JUMP_VOICE: Record<string, JumpVoiceCfg> = \{[\s\S]*?\n\};/s })
    .flatMap(([label, re]) =>
      [...block(re, label).matchAll(/(?::|set:)\s*["']([^"']+)["']/g)].map((m) => [label, m[1]])),
  ["FOOTSTEP_DEFAULT", (api.match(/FOOTSTEP_DEFAULT = "([^"]+)"/) ?? [])[1]],
];
for (const [label, set] of routedSets) {
  if (!set) { fail(`cannot read a set name out of ${label} — gate is blind, fix the regex`); continue; }
  if (!foleySets.has(set)) fail(`${label} routes to foley set "${set}" but composer/foley/${set} does not exist`);
}
console.log(`  routed foley sets all present: ${[...new Set(routedSets.map(([, s]) => s))].join(", ")}`);

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
// A few moments are ENGINE-driven: the engine watches a state flag the client
// already sends (the swimming flag → player.water_enter/exit) and names the
// event itself, so no client call site exists to scan. They are still real
// assignable events, so count them as emitted rather than reporting every
// assignment for one as dead wiring.
for (const m of api.matchAll(/this\.event\(\s*["']([^"']+)["']/g)) emitted.add(m[1]);
for (const m of api.matchAll(/\?\s*["'](player\.[a-z_]+)["']\s*:\s*["'](player\.[a-z_]+)["']/g)) {
  emitted.add(m[1]);
  emitted.add(m[2]);
}

for (const n of REQUIRED_ACTIONS) {
  if (!emitted.has(n)) fail(`action "${n}" is not emitted — the wiki cannot list it for assignment`);
  else console.log(`  assignable action emitted: ${n}`);
}
for (const n of REQUIRED_APPROVED) {
  if (!emitted.has(n)) fail(`approved "${n}" is no longer emitted — approved audio was lost`);
}
// ---- the published assignments manifest is in sync -----------------------
// composer/assignments.json is how ANY other tool learns what an assigned
// event really plays. The wiki parses api.ts for EVENT_FOLEY and bindings but
// NOT for EVENT_ASSIGNMENTS, so before this file existed its sound card showed
// `ui.press` playing ui_tick and `ui.release` playing nothing, while the engine
// played the maintainer's ui_click_bead / ui_click_latch — indistinguishable
// from his assignments having been reverted. A stale manifest would recreate
// exactly that, so it fails the gate rather than drifting quietly.
{
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "build-assignments.mjs"), "--check"], { encoding: "utf8" });
  const out = (r.stdout ?? "").trim();
  if (r.status !== 0) fail(out || "composer/assignments.json is stale — run: node scripts/build-assignments.mjs");
  else console.log(out);
}

// ---- the per-monster state events exist (games-audio 2026-08-06) ----------
// These are the ONE family that cannot be emitted as literal names: the id is
// `monsters.<kind>.<action>` over 24 roster kinds x 4 animation states, so it
// is built from data and the literal-name scan above is blind to it. The wiki
// does not need the scan for them either — its sound card derives the ids from
// the entity and its animation states — but nothing else would notice if the
// emission were refactored away, so check the call shape directly.
const scene = readFileSync(join(ROOT, "client", "src", "scenes", "WorldScene.ts"), "utf8");
if (!/gameAudio\.event\(`monsters\.\$\{[^`]*\}\.\$\{?\w+\}?`/.test(scene))
  fail("the per-monster `monsters.<kind>.<action>` emission is gone from WorldScene");
else {
  const acts = ["attack", "angry", "walk", "idle"].filter((a) => scene.includes(`fire("${a}")`));
  if (acts.length !== 4) fail(`monsterSfx fires ${acts.length}/4 states (${acts.join(", ")}) — the wiki card can only assign what is emitted`);
  else console.log(`  per-monster states emitted: monsters.<kind>.{${acts.join(",")}}`);
}

// ---- nothing dangling: removed names gone from bindings AND from source ---
const bindingsJson = JSON.parse(readFileSync(join(ROOT, "..", "sounds", "bindings.json"), "utf8"));
const boundNames = new Set((bindingsJson.events ?? []).map((e) => e.event));
for (const n of REMOVED_NAMES) {
  if (boundNames.has(n)) fail(`"${n}" is still bound in sounds/bindings.json`);
  if (emitted.has(n)) fail(`"${n}" is still emitted by the game`);
  if (api.includes(`"${n}"`)) fail(`"${n}" still referenced in api.ts`);
}
console.log(`  removed cleanly (no binding, no emission, no engine ref): ${REMOVED_NAMES.join(", ")}`);
// An event may be BOUND with no sound on purpose (level_up): assignable, silent.
for (const e of bindingsJson.events ?? []) {
  if (!e.sound && !emitted.has(e.event))
    console.log(`NOTE  "${e.event}" is bound with no sound and nothing emits it`);
}

// An assignment for an event nobody fires is dead wiring — worth a loud note.
// A voice-scoped id is checked on its base event; the scope is a call OPTION
// (opts.voice), not part of the emitted name.
for (const n of assigned) {
  const base = n.split("@")[0];
  if (!emitted.has(base)) console.log(`NOTE  assignment for "${n}" but nothing emits it (dead wiring?)`);
}

console.log(failed ? `\nverify-quiet: ${failed} FAILURE(S)` : "\nverify-quiet: ALL OK");
process.exit(failed ? 1 : 0);
