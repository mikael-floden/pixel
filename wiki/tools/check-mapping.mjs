// THE WIKI MUST NOT LIE ABOUT WHAT THE GAME PLAYS.
//
// Maintainer 2026-08-06: "The wiki is showing old sound mappings not the one
// playing in the game." It was true, in two directions at once:
//   * every sound HE had assigned was invisible — the page showed `ui_tick`
//     for ui.press while the game played `ui_click_bead`, and "no sound yet"
//     for ui.release while the game played `ui_click_latch` — because
//     build.mjs never read EVENT_ASSIGNMENTS, the engine's FIRST lookup;
//   * dozens of events rendered as bound sounds that the engine never plays,
//     because the build fell through to sounds/bindings.json for everything.
//     bindings.json is the sound agent's RECOMMENDATION; api.ts honours it
//     ONLY for the handful in BINDINGS_APPROVED, and is otherwise silent.
//
// So this gate re-derives the engine's resolution from api.ts ITSELF and
// asserts data.json agrees, event by event. It reads the engine source rather
// than a copy of the answer, so it cannot drift with the thing it checks:
// if the composer re-assigns a sound, this passes only once the wiki rebuilds.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const D = JSON.parse(readFileSync(join(ROOT, "wiki/site/data.json"), "utf8"));
const API = readFileSync(join(ROOT, "games2/composer/engine/api.ts"), "utf8");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };

// ---- read the engine's own tables ---------------------------------------
function record(name) {
  const m = API.match(new RegExp(`${name}(?:\\s*:[^=]+)?\\s*=\\s*\\{([\\s\\S]*?)\\};`));
  if (!m) return null;
  const body = m[1].replace(/\/\/[^\n]*/g, "");
  const out = {};
  const entry = /(?:"([^"]+)"|([$\w.]+))\s*:\s*(?:"([^"]+)"|(-?\d+(?:\.\d+)?)|(\{[^{}]*\}))/g;
  for (let e; (e = entry.exec(body)); ) {
    const key = e[1] ?? e[2];
    if (e[3] != null) out[key] = e[3];
    else if (e[4] != null) out[key] = Number(e[4]);
    else {
      const inner = {}; const sub = /([$\w]+)\s*:\s*(?:"([^"]+)"|(-?\d+(?:\.\d+)?))/g;
      for (let s; (s = sub.exec(e[5])); ) inner[s[1]] = s[2] ?? Number(s[3]);
      out[key] = inner;
    }
  }
  return out;
}
// The assignments come from the composer's PUBLISHED manifest, which their own
// gate keeps in step with the engine — "it cannot go stale on you the way an
// api.ts regex can" (games-audio, 2026-08-06). They were right within hours: a
// regex on `const assigned = EVENT_ASSIGNMENTS[name]` broke the moment they
// added per-character voices. We still parse the source as a CROSS-CHECK, so
// a manifest that stops matching the engine fails here instead of quietly
// becoming the new truth.
// An event maps to a LIST — several assigned sounds rotate round-robin — and
// it used to map to a single object THROUGH THE SAME `@1` format string. Both
// the builder and this gate read only the object shape, so the day the list
// landed every assignment silently became "no sound yet" on a page full of the
// maintainer's own work. Normalise, and never assume the shape again.
const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const DOC = JSON.parse(readFileSync(join(ROOT, "games2/composer/assignments.json"), "utf8"));
const ASSIGN = DOC.events ?? {};
const FOLEY = record("EVENT_FOLEY");
const bm = API.match(/const BINDINGS_APPROVED(?:\s*:[^=]+)?\s*=\s*new Set<[^>]*>\(\[([\s\S]*?)\]\)/);
const APPROVED = new Set(bm ? [...bm[1].replace(/\/\/[^\n]*/g, "").matchAll(/"([^"]+)"/g)].map((x) => x[1]) : []);

ok(DOC.format === "pixel-composer-assignments@1", `the composer's manifest is the expected format (${DOC.format})`);
ok(Object.keys(ASSIGN).length > 0, `it lists assignments (${Object.keys(ASSIGN).length})`);
// NO REGEX RE-PARSE OF THE ASSIGNMENT TABLE. It was tried, and it broke twice
// in one day — first on per-character voices, then on the value becoming a
// LIST — which is exactly what games-audio warned about when they published
// the manifest ("it cannot go stale on you the way an api.ts regex can").
// Their own gate keeps the manifest in step with the engine; ours keeps the
// PAGE in step with the manifest. What is checked here instead is
// shape-agnostic: every event the manifest claims must at least exist as a
// literal key in the engine source, which catches a manifest naming events
// api.ts has never heard of without pretending to parse TypeScript.
const unknown = Object.keys(ASSIGN).filter((id) => !API.includes(`"${id}"`));
ok(unknown.length === 0, `every assigned event id appears in api.ts${unknown.length ? ` — unknown: ${unknown.join(", ")}` : ""}`);
ok(!!FOLEY, `EVENT_FOLEY parses (${Object.keys(FOLEY ?? {}).length} entries)`);
ok(APPROVED.size > 0, `BINDINGS_APPROVED parses (${[...APPROVED].join(", ")})`);
// The ORDER is load-bearing: if assignments stop outranking the rest,
// everything below is checking the wrong thing. Matched loosely on purpose —
// the exact expression has already changed once (per-character voices).
ok(/EVENT_ASSIGNMENTS\[/.test(API), "assignments are still consulted by the engine");
ok(/if \(!BINDINGS_APPROVED\.has\(name\)\) return;/.test(API), "and bindings.json is still gated behind BINDINGS_APPROVED");

const byId = new Map(D.sfx.events.map((e) => [e.id, e]));
const setOf = (l) => (l.source === "composer" ? l.set : l.soundId);

// ---- 1. every assignment is shown, and shows the ASSIGNED sound ----------
for (const [id, rawA] of Object.entries(ASSIGN)) {
  const list = asList(rawA);
  const e = byId.get(id);
  if (!e) { ok(false, `${id}: assigned to "${list.map((x) => x.sound).join(", ")}" but the wiki does not list the event at all`); continue; }
  const wants = list.map((x) => String(x.sound).replace(/^composer\//, "").split(/[#/]/)[0]);
  const got = e.sounds.map(setOf);
  ok(e.bound && wants.every((w) => got.includes(w)),
    `${id} → ${wants.join(" + ")}${wants.every((w) => got.includes(w)) ? "" : ` — WIKI SHOWS ${got.length ? got.join("+") : "nothing"}`}`);
  // Several assigned sounds ROTATE (one per trigger); layered sounds play
  // together. Confusing them makes ▶ fire four thunder cracks at once.
  if (list.length > 1) ok(e.rotates === true, `  …and its ${list.length} sounds are marked as taking turns, not layered`);
  // Every assigned recording must actually resolve — the maintainer assigns
  // POOL candidates now (weather.thunder is four), and a set-only take lookup
  // resolved each to an empty layer: a card claiming a sound with nothing in it.
  ok(e.sounds.every((l) => l.takes.length > 0),
    `  …and every layer carries a real recording (${e.sounds.map((l) => l.takes.length).join("/")})`);
  const a = list[0];
  if (a.pitch != null) {
    const r = e.sounds.find((l) => setOf(l) === wants[0])?.rate;
    ok(Math.abs((r ?? 1) - a.pitch) < 1e-6, `  …at the assigned pitch ×${a.pitch} (${r})`);
  }
  if (a.volume_db != null) {
    const t = e.sounds.find((l) => setOf(l) === wants[0])?.trimDb;
    ok(Math.abs((t ?? 0) - a.volume_db) < 1e-6, `  …at the assigned volume ${a.volume_db} dB (${t})`);
  }
  // RANDOM PITCH IS NOT GENTLED for a composer assignment. oneshot.ts:135 is
  // `gentle = sound.urls ? 1 : 0.35`, and the engine's assigned-composer
  // branch builds its entry WITH urls — so the full ±j plays. The wiki scaled
  // it by 0.35 like the catalog path and showed the Game Master 65% less than
  // his own setting (item.drop read ±0.14 st against a played ±0.4).
  if (a.max_random_pitch_semis != null && String(a.sound).startsWith("composer/")) {
    const j = Math.abs(a.max_random_pitch_semis);
    const gotJ = e.sounds.find((l) => setOf(l) === wants[0])?.jitterSemis;
    ok(!!gotJ && Math.abs(Math.abs(gotJ[1]) - j) < 1e-6,
      `  …with the assigned random pitch ±${j} st, ungentled (${gotJ ? `±${Math.abs(gotJ[1])}` : "none"})`);
  }
}
// The gentle constant is what makes the rule above non-obvious — pin it, so a
// change on the composer's side surfaces here rather than as a quiet 65% drift.
ok(/const gentle = sound\.urls \? 1 : 0\.35;/.test(readFileSync(join(ROOT, "games2/composer/engine/oneshot.ts"), "utf8")),
  "the gentle rule is still `sound.urls ? 1 : 0.35` (urls ⇒ full jitter)");

// ---- 2. NOTHING is shown as bound that the engine would not play ---------
// The whole "the wiki shows old mappings" class lives here: a library
// suggestion must never render as a sound the game plays.
const ghosts = [];
for (const e of D.sfx.events) {
  if (!e.bound) continue;
  const via = e.via;
  const legit = via === "assigned" ? !!ASSIGN[e.id]
    : via === "foley" ? !!FOLEY?.[e.id]
    : via === "bindings" ? APPROVED.has(e.id)
    : null;                                    // engine-driven subsystems below
  if (legit === false) ghosts.push(`${e.id} (via ${via})`);
  // `via` is absent (undefined OR null) on the engine-driven families — loose
  // compare, or every one of them reads as an unknown route.
  if (legit === null && via != null) ghosts.push(`${e.id} (unknown via "${via}")`);
}
ok(ghosts.length === 0, `no event is shown as bound that the engine would not play${ghosts.length ? ` — ${ghosts.length}: ${ghosts.slice(0, 8).join(", ")}` : ""}`);

// Engine-driven families (footsteps, ambience, the jump/fall voices) resolve
// through their own tables and legitimately carry no `via`. They must still
// be there — a blanket "via must be set" rule would delete them.
const driven = D.sfx.events.filter((e) => e.bound && e.via == null);
ok(driven.length > 0, `the engine-driven families are still listed (${driven.length}: e.g. ${driven.slice(0, 3).map((e) => e.id).join(", ")})`);
// The complete list of engine-driven families, each a direct call in api.ts
// rather than an assignable `gameAudio.event(...)`: footsteps (step profile),
// ambience (region loops), the jump/fall voices, star() → gem_pickup, and
// thunder() → the composer's thunder set. Anything NEW showing up here is a
// route this gate has not been taught, and is exactly the kind of drift that
// let the old mappings survive — so it fails until someone looks.
ok(driven.every((e) => /^(footsteps|ambience|player|progress|weather)\./.test(e.id)),
  `and every one of them is a known engine-driven family (${[...new Set(driven.map((e) => e.id.split(".")[0]))].join(", ")})`);

// ---- 3. an unapproved suggestion reads as SILENT, and says why -----------
const bindings = JSON.parse(readFileSync(join(ROOT, "sounds/bindings.json"), "utf8"));
// ---- 3a. NO DEAD CARDS. A name in sounds/bindings.json is not a moment in
// the game: 16 of its rows are older spellings (combat.enemy_defeat, when the
// game fires combat.monster_die) or tools and containers no code has yet.
// Listed, they were indistinguishable from a live event waiting for a sound —
// audition, pick, assign, hear silence, no explanation (maintainer 2026-08-06:
// "Please remove … This is madness"). An event earns a card by being FIRED or
// by having a sound BOUND; anything else is a line in somebody else's file.
const dead = D.sfx.events.filter((e) => !e.bound && !e.emitted).map((e) => e.id);
ok(dead.length === 0, `every card is either fired by the game or has a sound bound${dead.length ? ` — ${dead.length} dead: ${dead.slice(0, 8).join(", ")}` : ""}`);
// The safety valve: BOUND-but-unfired must still be listed, or a sound the
// Game Master assigned would vanish with no way to see or unbind it. That is
// the red "not fired yet" chip, and hiding it would be the worse bug.
const hidden = new Set(D.sfx.hiddenDeadEvents ?? []);
ok(![...hidden].some((id) => asList(ASSIGN[id]).length), `nothing hidden is actually assigned (${hidden.size} hidden)`);
ok(!hidden.has("combat.monster_die"), "the event the game really fires on a monster death is still listed");
ok(hidden.has("combat.enemy_defeat") || !(bindings.events ?? []).some((b) => b.event === "combat.enemy_defeat"),
  "and its dead twin combat.enemy_defeat is not");
const suggested = (bindings.events ?? []).filter((b) => b.sound && !APPROVED.has(b.event) && !ASSIGN[b.event] && !FOLEY?.[b.event]);
const wrong = suggested.map((b) => byId.get(b.event)).filter((e) => e && e.bound).map((e) => e.id);
ok(wrong.length === 0, `library suggestions are not dressed up as bindings (${suggested.length} suggestions, ${wrong.length} wrongly bound)`);
const explained = suggested.map((b) => byId.get(b.event)).filter((e) => e && /library suggests/.test(e.note ?? ""));
ok(explained.length === suggested.filter((b) => byId.get(b.event)).length,
  `and each says what is on offer and why it is silent (${explained.length}/${suggested.filter((b) => byId.get(b.event)).length})`);

console.log(`\n${D.sfx.events.length} events: ${D.sfx.events.filter((e) => e.via === "assigned").length} assigned, ` +
  `${D.sfx.events.filter((e) => e.via === "foley").length} foley, ${D.sfx.events.filter((e) => e.via === "bindings").length} approved-binding, ` +
  `${driven.length} engine-driven, ${D.sfx.events.filter((e) => !e.bound).length} silent`);
console.log(fails.length ? `\nMAPPING CHECKS FAILED (${fails.length})` : "\nALL MAPPING CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
