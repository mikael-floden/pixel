// INDOOR SCENERY — the furniture of a house is drawn when you are inside it,
// and never when you are not.
//
//   node scripts/verify-indoorscenery.mjs [--world=the_game]
//
// WHY IT EXISTS: every piece under a roof or cave deck was dropped from the
// scenery index at load (render3's overview rule, which a cut-away must not
// share), so on the_game 136 placements — every bed, cupboard, hearth, table,
// chair, brazier and rug — were invisible in the game while the server still
// stamped their footprints into the collision grid (maintainer: "it feels like
// something is invisible inside this house"). The index now keeps them flagged
// and the scene draws one only while its roof is cut away.
//
// AND WHAT STANDS ON THE ROOF GOES WITH THE ROOF — the other half of the same
// rule (the lid arm below). A chimney's feet are on the deck's top, so it draws
// from the street and must dissolve when the cut removes the roof under it.
// That test read the piece's GROUND (the floor of the house, which the cut
// never passes) instead of its feet, so the same sprite was flagged as "on the
// lid" AND kept as a room-covering candidate — and stepSceneryCover, which runs
// a frame pass right after the lid fade, wrote alpha 1 over it. The stack stood
// in the middle of the room with its own roof cut away from under it
// (maintainer 2026-09-14, inside the meadow house: "the scenery object on top
// of the roof (the chimney) is visible when I am inside the house"). So the arm
// reads the ALPHA the sprite wears, never the flag: the count was right through
// the whole bug.
//
// The house is DERIVED from the world doc, never hardcoded: the roof deck with
// the most furniture, a free floor cell inside it to stand on, and the spawn to
// step back out to. The lid arm derives its own — the roofed deck that carries
// a piece standing on top of it.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { ensureClientDist } from "./clientdist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }),
);
const WORLD = String(args.world ?? "the_game");
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`); if (!ok) fails.push(msg); };
const die = (m) => { console.error(`verify-indoorscenery: CANNOT MEASURE — ${m}`); process.exit(2); };

// --- the house, from the world doc itself
const wj = join(REPO, "maps2", "worlds3", WORLD, "world.json");
if (!existsSync(wj)) die(`${wj} is missing (a maps3 world is required)`);
const doc = JSON.parse(readFileSync(wj, "utf8"));
const trunc = (v) => Math.trunc(v);
/* A HOUSE, AND ONLY A CAVE IF THE WORLD HAS NO FURNISHED HOUSE. Both kinds are
 * roofed decks and "most furniture" used to decide between them, which handed
 * this gate — whose subject is "the furniture of a house" — a CAVE at level 36
 * with 14 pieces once maps2 furnished the caves (2026-09-18). Three of its arms
 * then measured something they were not written for: a cave places no piece off
 * south, so the per-facing rule had nothing to read, and its on-lid piece is a
 * mountain top that never draws from a street. Kind first, furniture second. */
let house = null;
for (const pass of ["roof", "cave"]) {
  for (const d of doc.decks ?? []) {
    if (d.kind !== pass) continue;
    const cells = new Set((d.cells ?? []).map((c) => `${c.x ?? c.col},${c.y ?? c.row}`));
    const furniture = (doc.scenery ?? []).filter((p) => cells.has(`${trunc(p.x)},${trunc(p.y)}`));
    if (!house || furniture.length > house.furniture.length) house = { d, cells, furniture };
  }
  if (house && house.furniture.length >= 3) break;
}
if (!house || house.furniture.length < 3) die("no roofed deck on this world holds furniture — nothing to verify");
// THE FREEST FLOOR CELL, not the middle one: since 2026-09-09 maps2 stands
// furniture against the walls, and a cupboard's footprint reaches the cell
// beside it — a probe teleported there was pushed off it by the rescue. The
// cell farthest from every piece's anchor is the one a body can stand on.
const standIn = (h) => {
  const occupied = new Set(h.furniture.map((p) => `${trunc(p.x)},${trunc(p.y)}`));
  const free = [...h.cells]
    .map((k) => k.split(",").map(Number))
    .filter(([x, y]) => !occupied.has(`${x},${y}`) && doc.level?.[y]?.[x] === 0)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (!free.length) return null;
  const far = (c) => Math.min(...h.furniture.map((p) => Math.hypot(p.x - (c[0] + 0.5), p.y - (c[1] + 0.5))));
  return free.reduce((best, c) => (far(c) > far(best) ? c : best), free[0]);
};
const stand = standIn(house);
if (!stand) die("the furnished room has no free floor cell to stand on");
// THE LID HOUSE: a roofed deck carrying a piece whose own `z` puts its feet on
// that deck's top — the chimney class. Biggest such room, so it has floor to
// stand on; null on a world that stands nothing on a roof (the arm then says so
// instead of passing silently).
/* ...and the same preference for the lid arm: a chimney on a house roof is
 * what "on the lid" means here, and it is visible from the street, which the
 * arm's walk requires. A cave's mountain top is only the fallback. */
let lid = null;
for (const pass of ["roof", "cave"]) {
for (const d of doc.decks ?? []) {
  if (d.kind !== pass) continue;
  const cells = new Set((d.cells ?? []).map((c) => `${c.x ?? c.col},${c.y ?? c.row}`));
  const furniture = (doc.scenery ?? []).filter((p) => cells.has(`${trunc(p.x)},${trunc(p.y)}`));
  const onLid = furniture.filter((p) => typeof p.z === "number" && p.z >= (d.level ?? 0) - 1e-9);
  if (!onLid.length) continue;
  // The placement INDEX is what the scene keys a lit copy on (`place`).
  const onLidIdx = onLid.map((p) => (doc.scenery ?? []).indexOf(p));
  if (!lid || cells.size > lid.cells.size) lid = { d, cells, furniture, onLid, onLidIdx };
}
  if (lid) break;
}
const lidStand = lid ? standIn(lid) : null;
const spawn0 = doc.spawn ?? [Math.round(doc.size.w / 2), Math.round(doc.size.h / 2)];
console.log(`[indoorscenery] ${WORLD}: room of ${house.cells.size} cells with ${house.furniture.length} pieces; standing at ${stand}, outside at ${spawn0}`);
console.log(
  lid
    ? `[indoorscenery] lid room: ${lid.cells.size} cells at level ${lid.d.level}, ${lid.onLid.length} piece(s) on top (${[...new Set(lid.onLid.map((p) => p.piece))].join(", ")}); standing at ${lidStand}`
    : "[indoorscenery] no piece stands on a roof in this world — the lid arm will report that, not pass",
);

// --- a prod server on the working tree
const port = 2600 + Math.floor(Math.random() * 300);
const origin = `http://127.0.0.1:${port}`;
const tsx = join(ROOT, "node_modules", ".bin", "tsx");
console.log(`[indoorscenery] client/dist: ${ensureClientDist(ROOT, die, { tag: "indoorscenery" })}`);
const child = spawn(tsx, ["src/index.ts"], {
  cwd: join(ROOT, "server"), detached: true,
  env: { ...process.env, PORT: String(port), SERVE_CLIENT: "1", NODE_ENV: "production" },
  stdio: ["ignore", "ignore", "ignore"],
});
const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
process.on("exit", stop);
for (let t0 = Date.now(); ; ) {
  try { if ((await fetch(origin + "/health")).ok) break; } catch {}
  if (Date.now() - t0 > 90_000) die("the server never became healthy");
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 480, height: 320 }, serviceWorkers: "block" });
const page = await ctx.newPage();
await page.addInitScript(({ world }) => {
  localStorage.setItem("ml-last-choice", JSON.stringify({ world, characterUid: "default_boy", name: "Indoors" }));
  sessionStorage.setItem("ml-rejoin", "1");
}, { world: WORLD });
await page.goto(origin + "/", { waitUntil: "commit" });
await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 150_000, polling: 100 });
await page.waitForFunction(() => { try { return window.__ml.tiles3().drew.blits > 0; } catch { return false; } }, null, { timeout: 120_000, polling: 250 }).catch(() => {});
// NOTHING MAY KILL THE PROBE. The room this gate derives is whatever the world
// doc makes the most-furnished one, and since 2026-09-09 a monster zone reaches
// it: the probe teleported in, was dead within six seconds, and a dead player's
// next teleport is refused by design — so the "outside" sample was the inside
// one again and four sections failed on a picture nothing had changed. Same
// switch verify-indoor and verify-indoorscope already throw.
await page.evaluate(() => window.__ml.noAggro?.(true));
// AND THE CLOCK STOPS. Every arm here compares one moment with another, and the
// world's own time of day moves between them: measured, a walk that takes 20
// seconds crossed a phase and read 275% of its own "street" baseline with
// nothing wrong at all. Frozen at DAY, which is also the condition his
// screenshots are taken in.
await page.evaluate(() => { window.__ml.timeSpeed?.(0); window.__ml.timeOfDay?.("night", true); });

// SETTLE ON THE PICTURE, NEVER ON A FIXED WAIT — and never on "the loaders
// are quiet" alone. Teleporting lands in a neighbourhood whose scenery streams
// in two round trips (the piece manifest, then the art that manifest names),
// and BOTH loaders read quiet in the window between a manifest landing and the
// rebuild that queues its art. This harness renders on software GL at ~0.5 s a
// frame, so sampling in that window photographs an empty room and calls it a
// bug — it did, twice, while the fix under test was working. So: quiet AND the
// number of drawn sprites unchanged across three consecutive samples.
const settle = async () => {
  let last = -1;
  let same = 0;
  for (let i = 0; i < 120; i++) {
    const s = await page.evaluate(() => {
      try {
        const t = window.__ml.tiles3();
        const si = window.__ml.sceneryIndoor();
        return { h: t.hold, drawn: t.drew.scenery, blits: t.drew.blits, maskUp: si.maskUp, indoor: si.indoor };
      } catch {
        return null;
      }
    });
    if (s && s.blits > 0) {
      const quiet = s.h.piecesIdle && s.h.artIdle && s.h.queued === 0 && !s.h.loaderBusy && !s.h.manifestTimer;
      // AND the doorway transition has finished. The light grade outlives the
      // scenery by seconds here (a ~1.9 s exponential tail at ~0.5 s a frame),
      // and mid-fade the mask is still up while the verdict already says
      // outside — a legitimate crossfade state, not the settled one this gate
      // measures. Settled means the mask agrees with the verdict.
      const settledIndoor = s.maskUp === s.indoor;
      same = quiet && settledIndoor && s.drawn === last ? same + 1 : 0;
      last = s.drawn;
      if (same >= 3) return;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  console.log("  (the scene never settled — sampling anyway)");
};

const at = async (col, row, label) => {
  // A dead probe cannot teleport (the handler refuses it); revive it first.
  const dead = await page.evaluate(() => !!window.__ml.me()?.dead);
  if (dead) {
    console.log(`  (the probe died before [${label}] — respawning)`);
    await page.evaluate(() => window.__ml.roomSend?.("respawn", {}));
    await page.waitForFunction(() => !window.__ml.me()?.dead, null, { timeout: 30_000, polling: 250 }).catch(() => {});
  }
  await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [col, row]);
  await settle();
  const s = await page.evaluate(() => ({ scenery: window.__ml.sceneryIndoor(), indoor: window.__ml.indoor(), t3: window.__ml.tiles3() }));
  console.log(
    `[${label}] indoor=${s.indoor?.indoor} roofed=${s.scenery.roofed} cutAway=${s.scenery.cutAway} drawnRoofed=${s.scenery.drawnRoofed} drawn=${s.scenery.drawn} pieces=${s.t3.pieces.loaded}/${s.t3.pieces.requested}`,
  );
  return s;
};

const home = await at(stand[0], stand[1], "inside the house");
check(home.indoor?.indoor === true, "standing in the room puts the renderer indoors");
check(home.scenery.roofed > 50, `the index KEEPS the roofed placements (${home.scenery.roofed}) instead of dropping them at load`);
check(home.scenery.cutAway > 0, `the cut lets the room's own pieces through (${home.scenery.cutAway})`);
check(home.scenery.drawnRoofed > 0, `indoor furniture is actually DRAWN (${home.scenery.drawnRoofed} pieces)`);
check(
  home.scenery.drawnRoofed <= home.scenery.cutAway,
  `nothing is drawn that the cut did not release (${home.scenery.drawnRoofed} <= ${home.scenery.cutAway})`,
);
// THE BUSH-ON-THE-ROOF GUARD, and the reason the pieces were dropped in the
// first place: standing in MY building must not open every other roof on the
// map. The cut is per column (`cutAt` answers Infinity for a column drawn
// whole), so only this room's pieces may pass — a small fraction of all of
// them, and the neighbour's house keeps its furniture hidden with its roof.
check(
  home.scenery.cutAway < home.scenery.roofed / 2,
  `only MY room's roof is cut — ${home.scenery.cutAway} of ${home.scenery.roofed} roofed pieces released`,
);
await page.screenshot({ path: join(ROOT, "scripts", "_tmp-indoor-inside.png") });

// --- AND EVERY FACING IS DRAWN INSIDE ITS OWN FOOTPRINT. The room is where the
//     turned pieces are (maps2 stands furniture against the walls), and a
//     piece's rotations share their south still's CANVAS while their silhouette
//     does not: a turned view shows the front of the base and reaches further
//     down the same canvas (hearth_901 LIT_1: foot y 112 south, y 125
//     south-west). fitSprite used to pin the DRAWN frame's own foot to the
//     placement point, which lifted turned art 13 px off the footprint the map
//     agent placed against the wall and the wiki drew its box on (maintainer
//     2026-09-14: "the hitbox looks to be correctly placed against the wall
//     already ... it's the scenery that wasn't drawn inside the already
//     correctly placed hitbox"). So: the SOUTH still's alpha foot must land on
//     the anchor, measured on the display object's own numbers and the raw crop
//     its frame name carries — which is the packed, streamed art, not a table.
const drawn = await page.evaluate(() => window.__ml.sceneryDrawn());
let fitN = 0;
let fitTurned = 0;
let fitWorst = 0;
let fitWho = "";
let hung = 0;
for (const d of drawn) {
  if (!d.crop || !d.south || !d.canvas) continue;
  /* A PIECE THAT HANGS ON A WALL IS EXEMPT, by the rule itself (games2/
   * CLAUDE.md): "a facing draws through the STATE's SOUTH still's canvas
   * (anchorBox) at the PIECE's base scale — ONLY where a footprint is stamped.
   * A piece with `z` hangs on a wall, stamps none, and keeps its own art's
   * foot: the height HE tuned". So its foot is NOT the placement anchor and
   * never was; measuring it here read the tuned hanging height as a renderer
   * fault (wall_hangings/wall_hanging_017, 8.92 px, 2026-09-18). `place` is the
   * index into the world doc's scenery list, which is where `z` lives. */
  if (typeof (doc.scenery ?? [])[d.place]?.z === "number") { hung++; continue; }
  const [sx, sy, sw, sh] = d.crop;
  const [x, y, w, h] = d.box;
  const kx = w / sw;
  const ky = h / sh;
  const cx = (d.south[0] + d.south[2]) / 2;
  const foot = {
    // A flip mirrors the canvas inside the same destination rect.
    x: d.flipX ? x + w - (cx - sx) * kx : x + (cx - sx) * kx,
    y: y + (d.south[3] - sy) * ky,
  };
  const off = Math.max(Math.abs(foot.x - d.ax), Math.abs(foot.y - d.ay));
  if (off > fitWorst) { fitWorst = off; fitWho = `${d.piece} ${d.state} ${d.dir}`; }
  fitN++;
  if (d.turned) fitTurned++;
}
console.log(
  `  drawn pieces measured: ${fitN} (${fitTurned} turned), worst foot ${fitWorst.toFixed(2)} px off its anchor` +
    `; ${hung} wall-hung piece(s) exempt (they stamp no footprint and keep their own art's foot)`,
);
check(fitN > 5, `the room draws pieces to measure (${fitN})`);
/* A TURNED PIECE IS THE WORLD'S TO OFFER, AND THE DISTINCTION MATTERS. This
 * rule is about the per-facing anchor, so it needs a piece whose placement asks
 * for a facing other than south. Whether the ROOM HAS one is world data (maps2
 * places the furniture and re-places it: this room held only south facings
 * after the yard refit, 2026-09-18, and the gate read that as a failure of the
 * renderer); whether a turned piece the room HAS is actually DRAWN is ours, and
 * still a failure. So: the world's own count decides between a skip and a
 * check. */
const roomTurned = house.furniture.filter((p) => p.dir && p.dir !== "south").length;
if (!roomTurned) console.log(`  SKIP the turned-facing rule — this room places no piece off south (${house.furniture.length} pieces, all south)`);
else check(fitTurned > 0, `at least one of the ${roomTurned} turned piece(s) this room places is DRAWN (${fitTurned})`);
check(
  fitWorst <= 1.5,
  `every facing stands its south still's foot on the placement anchor — worst ${fitWorst.toFixed(2)} px (${fitWho})`,
);

// --- THE LID: a piece standing on the roof dissolves with it, and the alpha is
//     what is asserted (see the header — the flag was right all through the bug)
if (!lid || !lidStand) {
  check(false, "no roofed deck carries a piece standing on top of it — the lid rule is unmeasured on this world");
} else {
  const onLid =
    lidStand[0] === stand[0] && lidStand[1] === stand[1]
      ? home
      : await at(lidStand[0], lidStand[1], "inside the lid house");
  check(onLid.indoor?.indoor === true, "standing in the lid room puts the renderer indoors");
  check(
    onLid.scenery.deckPieces > 0,
    `the index flags the pieces standing ON a deck (${onLid.scenery.deckPieces} placements)`,
  );
  check(onLid.scenery.onLid > 0, `the cut catches what stands on the removed roof (${onLid.scenery.onLid} sprite(s))`);
  check(
    onLid.scenery.onLidAlpha !== null && onLid.scenery.onLidAlpha <= 0.02,
    `and those sprites are INVISIBLE, not merely flagged — alpha ${onLid.scenery.onLidAlpha}`,
  );
}

const out = await at(spawn0[0], spawn0[1], "outside at the spawn");
check(out.indoor?.indoor === false, "back outdoors");
check(out.scenery.maskUp === false, "the cut-away is fully rolled back (the exit fade landed)");
check(out.scenery.cutAway === 0, `with no cut drawn, NO roofed piece may pass (${out.scenery.cutAway})`);
check(out.scenery.drawnRoofed === 0, `no roofed piece is drawn outdoors — no furniture on a roof (${out.scenery.drawnRoofed})`);
check(out.scenery.drawn > 0, `outdoor scenery still draws (${out.scenery.drawn} sprites)`);
// ...and with no roof cut, nothing is on a lid: the chimney is an ordinary
// outdoor piece from the street, at full opacity like any other.
check(out.scenery.onLid === 0, `no piece is treated as standing on a cut lid outdoors (${out.scenery.onLid})`);
await page.screenshot({ path: join(ROOT, "scripts", "_tmp-indoor-outside.png") });

// --- AND FROM THE STREET, THE PIECE ON THE LID STANDS ON THE LID. The shared
//     depth rule takes the level a piece STANDS on; reading the cell's terrain
//     level put a chimney on the house floor while its art was drawn six
//     storeys up, so the roof it stands on counted as covering it and `coverY`
//     cropped its lit copy partway up the stack — a hard horizontal step
//     across the chimney (maintainer 2026-09-14: "a visible edge that looks
//     like a shadow bug"). Measured on the sprite, not on the flag: the copy's
//     own crop state.
if (lid && lid.onLidIdx.length) {
  // A floor cell a few rows south of the room — outside it, in view of it.
  const cells = [...lid.cells].map((k) => k.split(",").map(Number));
  const midC = Math.round(cells.reduce((a, c) => a + c[0], 0) / cells.length);
  const maxR = Math.max(...cells.map((c) => c[1]));
  let spot = null;
  for (let dr = 3; dr <= 8 && !spot; dr++)
    if (doc.level?.[maxR + dr]?.[midC] === 0 && !lid.cells.has(`${midC},${maxR + dr}`)) spot = [midC, maxR + dr];
  if (!spot) check(false, "no floor cell south of the lid house to stand on — the street arm is unmeasured");
  else {
    const street = await at(spot[0], spot[1], "outside, beside the lid house");
    const copies = await page.evaluate((ids) => (window.__ml.sceneryLitCopy?.() ?? []).filter((l) => ids.includes(l.place)), lid.onLidIdx);
    console.log(`  lit copies of the on-lid pieces in view: ${JSON.stringify(copies)}`);
    check(street.indoor?.indoor === false, "standing in the street is outdoors");
    if (!copies.length) check(false, "the piece on the lid has no lit copy from the street — nothing to measure");
    for (const c of copies) {
      check(
        c.z >= (lid.d.level ?? 0),
        `its lit copy stands ON the lid (z ${c.z}, deck at ${lid.d.level})`,
      );
      check(!c.cropped, `and nothing crops it (cover ${c.cover}) — the deck it stands on is not over it`);
    }

    // --- AND IT IS NEVER LIT BY THE ROOM UNDER IT. Standing on the roof puts a
    //     piece in its room's CELLS while it is outdoors, and the light did not
    //     ask about height: the interior ambient, the hearth's point light, and
    //     — the one that actually did it — the hearth's glow HALO, a
    //     screen-space bloom with no line of sight, reached straight up through
    //     the roof into the chimney standing over it. Measured at his house:
    //     +41% and warm (1.309,1.146,1.007 against the street's 0.930,0.898,
    //     0.893) at an alpha still 0.79, which is a bright flash on the way in
    //     and again on the way out (maintainer 2026-09-14: "the chimney on the
    //     roof flashes bright as if it suddenly got the light from inside the
    //     house"). The piece may only DIM across the crossing, with the outside
    //     it belongs to — never brighten, never warm.
    const pl = lid.onLid[0];
    const probe = { col: pl.x, row: pl.y, z: (lid.d.level ?? 0) + 0.5, place: lid.onLidIdx[0] };
    // THE BASELINE IS THE STREET, so wait for the mask to be fully rolled back
    // before reading it: taken mid-roll it is dim, and every honest outdoor
    // sample later reads as a "flash" against it.
    await page
      .waitForFunction(() => window.__ml.indoor().mix < 0.01, null, { timeout: 30_000, polling: 100 })
      .catch(() => {});
    await settle();
    const base = await page.evaluate((q) => window.__ml.lightAtCell(q.col, q.row, q.z), probe);
    if (!base) check(false, "no light reading at the piece on the lid — the fade arm is unmeasured");
    else {
      const peak = (l) => Math.max(l[0], l[1], l[2]);
      const warm = (l) => l[0] - l[2];
      const luma8 = (t) =>
        t === null || t === undefined ? null : 0.2126 * ((t >> 16) & 255) + 0.7152 * ((t >> 8) & 255) + 0.0722 * (t & 255);
      /* TWO CLAIMS, and the second is the one the first fix missed.
       *
       * (1) THE LIGHT MODEL at the piece's own point (lightAtCell): its ambient
       *     and the glow halos, which is what a body standing there would take.
       *
       * (2) WHAT THE COPY IS ACTUALLY DRAWN WITH. A scenery piece is not lit by
       *     that sum: scenerylit.ts adds each light PER TEXEL from the same
       *     ledger and takes only the OCCLUSION from it, at the volume's own
       *     sample point — which carried the CELL's terrain level, six storeys
       *     under a chimney and inside the room. So the model went quiet while
       *     the picture did not (maintainer 2026-09-14, on that build: "the
       *     chimney on the roof still flashes in brightness when I walk in/out
       *     a house"). The tint it is drawn with, the level its volume is
       *     sampled at, and the per-light occlusion the pipeline multiplies are
       *     the three numbers the picture is made of, and all three are exact.
       *
       * NOT THE PIXELS THEMSELVES: the camera glides for about a second after a
       * crossing while the roll lasts a third of one, so the piece's box travels
       * over changing background and its mean luma moves 15% with nothing wrong
       * — measured identical on the broken build and the fixed one, which makes
       * it a gate that cannot tell them apart. */
      const sample = () =>
        page.evaluate((q) => {
          const lit = (window.__ml.sceneryLitCopy(q.place) ?? [])[0] ?? null;
          const ni = window.__ml.nightIndoor(q.col, q.row);
          const ceil = ni.ceil ?? 0;
          // Every light OF THE ROOM under this piece: within reach, below that
          // room's own underside, AND standing on one of the room's own cells.
          // None of them may touch it.
          // THE LAST TEST IS NOT DECORATION. Without it this arm collected any
          // light under the roof within 14 cells — including the torch in my
          // own hand while I stand in the STREET, which is not a light of the
          // room and has no wall between it and a chimney on the roof. The
          // engine blocks my room's geometry against my room's lights (the
          // fragment's lightMine), so a torch outside reads occ 1 here by
          // design; asserting 0 on it asserted the bug that made the house's
          // outer walls go black mid-fade. While I stand INSIDE, my torch IS
          // one of the room's lights and this arm still holds it to 0.
          const room = window.__ml
            .lights()
            .map((L, i) => ({ i, z: L.z, d: Math.hypot(L.col - q.col, L.row - q.row), mine: !!window.__ml.nightIndoor(L.col, L.row)?.cell?.room }))
            .filter((L) => ceil > 0 && L.z < ceil && L.d < 14 && L.mine);
          return {
            mix: window.__ml.indoor().mix,
            l: window.__ml.lightAtCell(q.col, q.row, q.z),
            tint: lit?.tint ?? null,
            alpha: lit?.alpha ?? null,
            fz: lit?.shape?.fz ?? null,
            fc: lit?.shape?.fc ?? null,
            fr: lit?.shape?.fr ?? null,
            roomCells: window.__ml.roomTex?.()?.cells ?? null,
            roomLit: room.map((L) => ({ i: L.i, z: L.z, d: +L.d.toFixed(1), mine: L.mine, occ: lit?.shape?.occ?.[L.i] ?? null })),
            ni,
          };
        }, probe);
      const street = await sample();
      const baseTint = luma8(street.tint);
      const walk = [];
      // Into the house and straight back out, sampling the roll itself — the
      // flash is 2-3 frames wide and lands early, while the piece is still
      // nearly opaque (the lid fade runs at 3x).
      for (const [c, r] of [lidStand, spot]) {
        await page.evaluate(([c2, r2]) => window.__ml.teleport(c2 + 0.5, r2 + 0.5), [c, r]);
        for (let i = 0; i < 18; i++) {
          await page.waitForTimeout(70);
          walk.push(await sample());
        }
        await settle();
      }
      const lit = walk.filter((w) => w.l);
      const hot = lit.reduce((a, w) => Math.max(a, peak(w.l) / Math.max(0.001, peak(base))), 0);
      const hotWarm = lit.reduce((a, w) => Math.max(a, warm(w.l) - warm(base)), 0);
      const rolled = lit.filter((w) => w.mix > 0.02).length;
      const worst = lit.reduce((a, w) => (peak(w.l) > peak(a.l) ? w : a), lit[0]);
      console.log(
        `  fade walk: ${lit.length} samples (${rolled} with the mask rolling), brightest ${(hot * 100).toFixed(0)}% of the street, warmest +${hotWarm.toFixed(3)} R-B`,
      );
      console.log(
        `    street ${base.map((v) => v.toFixed(3))} | hottest ${worst.l.map((v) => v.toFixed(3))} at mix ${worst.mix}`,
      );
      check(rolled >= 4, `the walk really crossed the fade (${rolled} samples with mix > 0.02)`);
      check(hot <= 1.02, `the piece on the roof never brightens across the crossing (peak ${(hot * 100).toFixed(0)}% of the street)`);
      check(hotWarm <= 0.03, `and never takes the fire's colour (peak +${hotWarm.toFixed(3)} R-B over the street)`);
      const tints = walk.map((w) => luma8(w.tint)).filter((v) => typeof v === "number");
      const tintHot = tints.length && baseTint ? Math.max(...tints) / Math.max(1, baseTint) : 0;
      const feet = [...new Set(walk.map((w) => w.fz).filter((v) => v !== null))];
      // Only frames where the copy is actually DRAWN: while it is dissolved its
      // volume is not re-lit, so what the probe reads there is the last value
      // it was drawn with, not a light reaching anything.
      const leaks = walk
        .filter((w) => w.mix > 0.02 && (w.alpha ?? 0) > 0.01)
        .flatMap((w) => w.roomLit.filter((L) => (L.occ ?? 0) > 0.001));
      console.log(
        `    room test at the volume: ${JSON.stringify(walk.find((w) => w.mix > 0.02)?.ni ?? null)}\n` +
        `    leaks: ${JSON.stringify(leaks.slice(0, 3))}\n` +
        `    drawn with: tint luma ${baseTint?.toFixed(1)} at the street, brightest ${(tintHot * 100).toFixed(0)}%; volume sampled at level ${feet.join("/")} cell ${walk.find((w) => w.fc !== null)?.fc},${walk.find((w) => w.fr !== null)?.fr} (deck cell: ${lid.cells.has(`${Math.floor(walk.find((w) => w.fc !== null)?.fc ?? -1)},${Math.floor(walk.find((w) => w.fr !== null)?.fr ?? -1)}`)}); ${leaks.length} room-light leak(s)`,
      );
      check(tints.length >= 8 && !!baseTint, `the copy's tint was readable from the street and across the walk (${tints.length} samples)`);
      check(tintHot <= 1.02, `THE TINT IT IS DRAWN WITH never brightens past its street value (peak ${(tintHot * 100).toFixed(0)}%)`);
      check(
        feet.length > 0 && feet.every((z) => z >= (lid.d.level ?? 0)),
        `its lit volume is sampled at the piece's FEET, on the deck (level ${feet.join("/")}, deck at ${lid.d.level})`,
      );
      check(
        leaks.length === 0,
        `no light of the room under it reaches it while the mask is up (${leaks.length} leak(s), worst occ ${leaks.reduce((a, L) => Math.max(a, L.occ ?? 0), 0).toFixed(3)})`,
      );    }
  }
}

// --- THE EXIT FADE AT THE DOOR (maintainer 2026-09-20, four screenshots of his
//     hearth house): "the entire house is colored reddish during the indoor to
//     outdoor animation ... the scenery light inside the house lights up the
//     outside of the house", and "it looks a bit ugly that we can see the
//     scenery through the roof during the animation". Two rules, both pinned:
//     the house's OUTER FACES fade with the street (a face whose front cell is
//     not my room's is outside it; the sun leaves my room only), and the
//     furniture is GONE once the roof is opaque (indoorcurve.ts, leaving: the
//     lesser of the light grade and the debris' complement). Measured on his
//     frame before: the world at 0.62 of settled, the house's faces at 1.03, a
//     table at 0.38 on a solid roof.
//     The crossing is a HOP of 1.8 cells through the doorway — under the 2-cell
//     correction bar, so the blend is not snapped and the real crossfade runs
//     (a walk on this rig is ~1 cell per 24 s) — with the blend PINNED, and the
//     pixels are read at the cells' own projections so the camera's glide after
//     a crossing does not matter. Regions the small viewport cannot hold are
//     skipped; at least one outer face must be in view or the arm is unmeasured.
{
  const floorL = doc.level?.[stand[1]]?.[stand[0]] ?? 0;
  const cellsXY = [...house.cells].map((k) => k.split(",").map(Number));
  const wallL = Math.max(...cellsXY.map(([x, y]) => doc.level?.[y]?.[x] ?? 0));
  const roofL = house.d.level ?? wallL;
  const maxX = Math.max(...cellsXY.map((c) => c[0]));
  const maxY = Math.max(...cellsXY.map((c) => c[1]));
  // THE DOOR: a deck cell at the floor level with the outside beside it.
  let door = null;
  for (const [x, y] of cellsXY) {
    if ((doc.level?.[y]?.[x] ?? 99) !== floorL) continue;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const lv = doc.level?.[y + oy]?.[x + ox];
      if (typeof lv === "number" && lv <= floorL + 1 && !house.cells.has(`${x + ox},${y + oy}`)) { door = { x, y, ox, oy }; break; }
    }
    if (door) break;
  }
  if (!door || wallL <= floorL) {
    check(false, `no doorway with the street beside it on this house (walls ${wallL}, floor ${floorL}) — the exit-fade arm is unmeasured`);
  } else {
    const inSpot = [door.x + 0.5 - 0.6 * door.ox, door.y + 0.5 - 0.6 * door.oy];
    const hop = [door.x + 0.5 + 1.2 * door.ox, door.y + 0.5 + 1.2 * door.oy];
    // The street cell: four cells out from the door, past the house's own cast
    // shadow, on the same ground the door opens onto.
    const streetCell = [door.x + 4 * door.ox, door.y + 4 * door.oy];
    // The visible outer faces: the SW face of the south (max-y) wall row and the
    // SE face of the east (max-x) wall column — the wall cell nearest the door
    // but two cells clear of it (villagers gather at doors and a body in front
    // of the face is a sample of the body), and with NO scenery on that face:
    // a window's pane or a barrel against the wall draws its lit copy above the
    // darkness overlay, so a "face" sample on it never fades with anything
    // (measured on the meadow house: 180 luma on a pane, 98% of settled through
    // the whole crossing).
    const nearest = (cands) => cands
      .filter(([x, y]) => Math.hypot(x - door.x, y - door.y) >= 2)
      .sort((a, b) => Math.hypot(a[0] - door.x, a[1] - door.y) - Math.hypot(b[0] - door.x, b[1] - door.y))[0] ?? null;
    const placed = doc.scenery ?? [];
    const clearFace = (x, y, ox, oy) => !placed.some((p) => Math.abs(p.x - (x + 0.5 + ox)) < 1.3 && Math.abs(p.y - (y + 0.5 + oy)) < 1.3);
    let southWall = nearest(cellsXY.filter(([x, y]) => y === maxY && (doc.level?.[y]?.[x] ?? 0) === wallL && clearFace(x, y, 0, 1)));
    let eastWall = nearest(cellsXY.filter(([x, y]) => x === maxX && (doc.level?.[y]?.[x] ?? 0) === wallL && clearFace(x, y, 1, 0)));
    const roofCell = nearest(cellsXY.filter(([x, y]) => (doc.level?.[y]?.[x] ?? 99) === floorL && x < maxX - 1 && y < maxY - 1));
    // A TALLER VIEW, AND A PINNED CAMERA. At 480x320 the game's view is a
    // 200 px strip under the HUD cards and the time pill, and a wall face two
    // rows up from the player lands under the pill (measured: the "face" was
    // the pill's own sky art). Portrait, like his phone, puts the door's wall
    // in the clear band; the camera is parked on the cell above the door after
    // each hop (a teleport re-attaches it) and again for the settled frame, so
    // the two frames project identically.
    await page.setViewportSize({ width: 480, height: 720 });
    const camAt = [door.x - 2 * door.ox, door.y - 2 * door.oy];
    const parkCam = async (at = camAt) => {
      await page.evaluate(([c, r]) => window.__ml.lookAt(c, r), at);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await new Promise((r) => setTimeout(r, 500));
    };
    const hopOut = async () => {
      await page.evaluate(([c, r]) => window.__ml.teleport(c, r), hop);
      const ok = await page.waitForFunction(
        ([c, r]) => { const f = window.__ml.indoorFade(); const m = window.__ml.me(); return f.exiting === true && !!m && Math.abs(m.x / 32 - c) < 0.7 && Math.abs(m.y / 32 - r) < 0.7; },
        hop, { timeout: 60_000, polling: 100 },
      ).then(() => true).catch(() => false);
      await parkCam();
      return ok;
    };
    const geom = () => page.evaluate(([sx, sy, wx, wy]) => {
      const a = window.__ml.cellScreen(sx, sy), b = window.__ml.cellScreen(sx + 1, sy); // two street cells, equal level
      const w = window.__ml.cellScreen(wx, wy); // a wall cell, at the wall's own level
      const dx = b.x - a.x, dy = b.y - a.y;
      // w vs a: (col+row) differ by (wx+wy) - (sx+sy) rows of dy, and (w.level - a.level) levels of lh
      const lh = ((a.y + ((wx + wy) - (sx + sy)) * dy) - w.y) / Math.max(1e-6, w.level - a.level);
      return { dx, dy, lh, zoom: a.zoom, vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio };
    }, [streetCell[0], streetCell[1], (southWall ?? eastWall)[0], (southWall ?? eastWall)[1]]);
    const measure = async (label) => {
      const buf = await page.screenshot({ type: "png" });
      const png = PNG.sync.read(buf);
      const g = await geom();
      const { dx, dy, lh } = g;
      const proj = await page.evaluate(([cells]) => cells.map(([c, r]) => (c === null ? null : window.__ml.cellScreen(c, r))),
        [[southWall ?? [null, null], eastWall ?? [null, null], roofCell ?? [null, null], streetCell]]);
      const [pS, pE, pR, pT] = proj;
      // Boxes in the screenshot's own pixels: cellScreen answers in the canvas's
      // pixels, and the canvas is the viewport at dpr 1 here.
      const box = (cx, cy, hw, hh) => [Math.round(cx - hw), Math.round(cy - hh), Math.round(cx + hw), Math.round(cy + hh)];
      const faceMid = (P, sign) => [P.x + (sign * dx) / 2, P.y + 1.5 * dy - (wallL - P.level) * lh + ((wallL - floorL) * lh) / 2];
      const topMid = (P, lv) => [P.x, P.y + dy - (lv - P.level) * lh];
      const regions = {
        southFace: pS ? box(...faceMid(pS, -1), dx / 4, Math.max(2, lh * 0.9)) : null,
        eastFace: pE ? box(...faceMid(pE, +1), dx / 4, Math.max(2, lh * 0.9)) : null,
        roof: pR ? box(...topMid(pR, roofL), dx * 0.4, dy * 0.4) : null,
        street: box(...topMid(pT, floorL), dx * 0.4, dy * 0.4),
      };
      const mean = (b) => {
        if (!b) return null;
        const [x0, y0, x1, y1] = b;
        if (x0 < 0 || y0 < 0 || x1 > png.width || y1 > png.height) return null; // off the small viewport: unmeasured here
        let r = 0, gg = 0, bb = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * png.width + x) * 4; r += png.data[i]; gg += png.data[i + 1]; bb += png.data[i + 2]; n++; }
        return n ? [r / n, gg / n, bb / n] : null;
      };
      const stats = Object.fromEntries(Object.entries(regions).map(([k, b]) => [k, mean(b)]));
      const f = await page.evaluate(() => ({ fade: window.__ml.indoorFade(), me: window.__ml.me(), tod: window.__ml.timeOfDay?.() }));
      writeFileSync(join(ROOT, "scripts", `_tmp-exitfade-${label.replace(/[^a-z0-9.]+/gi, "-")}.png`), buf);
      console.log(`  [${label}] mix ${f.fade.mix} debris ${f.fade.alpha} furniture ${f.fade.roofedDrawn} | ` +
        Object.entries(stats).map(([k, v]) => `${k} ${v ? v.map((x) => x.toFixed(0)).join(",") : "off-view"}`).join(" | ") +
        ` | ${f.tod?.name ?? "?"} t${f.tod?.phaseT?.toFixed?.(2)} | zoom ${g.zoom.toFixed(2)} dx ${dx.toFixed(1)} dy ${dy.toFixed(1)} lh ${lh.toFixed(1)} | boxes ${JSON.stringify(regions)}`);
      return { stats, fade: f.fade };
    };
    console.log(`  exit-fade fixture: floor ${floorL} walls ${wallL} roof ${roofL}; door ${door.x},${door.y} facing ${door.ox},${door.oy}; in ${inSpot.map((v) => v.toFixed(1))} hop ${hop.map((v) => v.toFixed(1))}; south wall ${southWall} east wall ${eastWall} roof cell ${roofCell} street ${streetCell}`);
    const luma = (v) => (v ? 0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2] : NaN);

    // CLEAR SKY, pinned on this client: the cloud field is a drifting shadow,
    // and two frames minutes apart under a passing cloud edge differ by more
    // than the bars below with nothing wrong (measured: one roof cell at 1.56x
    // the street's ratio in one run, 0.53x in the next).
    await page.evaluate(() => window.__ml.weather?.(0, true));
    // ...AND DAY, the condition of his screenshots: at night the faces beside a
    // door are lit by the street's own lamp and the panes' glow, neither of
    // which rides the street's ambient fade this arm is about.
    await page.evaluate(() => window.__ml.timeOfDay?.("day", true, 0.5));
    await at(inSpot[0], inSpot[1], "just inside the door");
    // The furniture must be DRAWN before the crossing means anything.
    const furnished = await page.waitForFunction(() => { try { return window.__ml.sceneryIndoor().drawnRoofed > 0; } catch { return false; } }, null, { timeout: 120_000, polling: 500 }).then(() => true).catch(() => false);
    check(furnished, "the room's furniture is drawn before the exit is measured");
    // 1. Pinned at mix 0.5: the roof is opaque (debris 1) while the light grade is
    //    still 0.25 — where the old rule left a table at 0.25 on a solid roof.
    await page.evaluate(() => window.__ml.indoorMixPin(0.5));
    const flipped = await hopOut();
    check(flipped, "the hop through the doorway starts the exit crossfade (blend pinned at 0.5)");
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const half = await measure("exit pinned 0.5");
    check(half.fade.alpha >= 0.999, `the roof debris is opaque at mix 0.5 (alpha ${half.fade.alpha})`);
    check(
      half.fade.roofedDrawn !== null && half.fade.roofedDrawn <= 0.02,
      `under an opaque roof the furniture wears nothing (drawn alpha ${half.fade.roofedDrawn}; on the light grade alone it wore 0.25)`,
    );
    // 2. Pinned at mix 0.9: still a FADE, not a switch — the roof at 0.3, the
    //    furniture at the lesser of the grade (0.85) and the roof's complement (0.7).
    await page.evaluate(() => window.__ml.indoorMixPin(null));
    await at(inSpot[0], inSpot[1], "just inside the door again");
    await page.evaluate(() => window.__ml.indoorMixPin(0.9));
    const flipped2 = await hopOut();
    check(flipped2, "the second hop starts the exit crossfade (blend pinned at 0.9)");
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const early = await measure("exit pinned 0.9");
    check(
      early.fade.roofedDrawn !== null && Math.abs(early.fade.roofedDrawn - 0.7) <= 0.05,
      `while the roof is still returning the furniture fades with it — 0.70 at mix 0.9 (drawn alpha ${early.fade.roofedDrawn}; the grade alone is 0.85)`,
    );
    // 3. The settled outdoor frame, and the light comparison: through the fade
    //    the house's outer faces must fade with the street, not stay lit as the
    //    room. Measured before at his geometry: the faces at 1.6x the street's
    //    own fade ratio.
    await page.evaluate(() => window.__ml.indoorMixPin(null));
    const landed = await page.waitForFunction(() => { const f = window.__ml.indoorFade(); return !f.inside && f.mix <= 0 && !f.exiting; }, null, { timeout: 120_000, polling: 250 }).then(() => true).catch(() => false);
    check(landed, "the exit crossfade lands outdoors");
    await settle();
    await parkCam();
    const done = await measure("settled outside");
    const ratio = (a, b, k) => luma(a.stats[k]) / Math.max(1, luma(b.stats[k]));
    const streetK = ratio(half, done, "street");
    check(streetK > 0.3 && streetK < 0.95, `mid-exit the street is fading up from black (${(streetK * 100).toFixed(0)}% of settled)`);
    let facesInView = 0;
    for (const k of ["southFace", "eastFace"]) {
      if (!half.stats[k] || !done.stats[k]) continue;
      facesInView++;
      const rel = ratio(half, done, k) / streetK;
      check(rel <= 1.2, `the house's outer face (${k}) fades WITH the street — ${(rel * 100).toFixed(0)}% of the street's own fade ratio (was ~160%)`);
    }
    check(facesInView > 0, "at least one outer face of the house is in view to measure");
    if (half.stats.roof && done.stats.roof) {
      const rel = ratio(half, done, "roof") / streetK;
      check(rel >= 0.75 && rel <= 1.25, `the roof slab fades with the street too (${(rel * 100).toFixed(0)}% of the street's ratio)`);
    }

    // 4. NIGHT (maintainer 2026-09-20, two more screenshots, on the build that
    //    carried the rules above). Day hid both: the sun lights a face whatever
    //    the torch does, and the room's warm ambient is near the street's.
    //    a) "Completely broken player torch" (251.4,284.6, the wall beside her
    //       black): the outer-face rule ran with NO room published — roomAt
    //       answers 1 there and roomCellAt 0 — so every wall face in the world
    //       was the outer face of a room nobody stood in: no point light above
    //       the light's height, none of the glow field. The same outer face,
    //       my torch beside it, switched on and off: 1.00 on that build.
    await page.evaluate(() => window.__ml.timeOfDay?.("night", true, 0.5));
    // STAND IN FRONT OF THE FACE, not at the door: a torch is a 6-cell pool
    // with square falloff, and the wall this arm can measure is whichever one
    // has no scenery on it — four cells down the wall from the door on this
    // house. At the door its lift on that face was 1.02 with the light
    // working. One cell out from the face, the camera parked on the wall cell
    // so both the face and the player are mid-frame.
    const torchFace = southWall ? { cell: southWall, key: "southFace", out: [0, 1] } : eastWall ? { cell: eastWall, key: "eastFace", out: [1, 0] } : null;
    let bestLift = 0;
    if (!torchFace) {
      check(false, "a scenery-free outer face of the house is available to measure the torch on");
    } else {
      const stand = [torchFace.cell[0] + 0.5 + 1.1 * torchFace.out[0], torchFace.cell[1] + 0.5 + 1.1 * torchFace.out[1]];
      const camTorch = [torchFace.cell[0] + 2 * torchFace.out[0], torchFace.cell[1] + 2 * torchFace.out[1]];
      await at(stand[0], stand[1], "outside at night, standing in front of the house's wall");
      await page.evaluate(() => window.__ml.torch?.(true));
      await new Promise((r) => setTimeout(r, 1500)); // the light slot's tenure ramp
      await parkCam(camTorch);
      const torchOn = await measure("night torch on");
      await page.evaluate(() => window.__ml.torch?.(false));
      await new Promise((r) => setTimeout(r, 1500));
      await parkCam(camTorch);
      const torchOff = await measure("night torch off");
      await page.evaluate(() => window.__ml.torch?.(true));
      const on = torchOn.stats[torchFace.key];
      const off = torchOff.stats[torchFace.key];
      if (!on || !off) {
        check(false, `the wall face (${torchFace.key}) is in view to measure the torch on`);
      } else {
        bestLift = luma(on) / Math.max(0.5, luma(off));
        console.log(`  night ${torchFace.key} at ${stand.map((v) => v.toFixed(1))}: torch on ${luma(on).toFixed(1)} / off ${luma(off).toFixed(1)} = ${bestLift.toFixed(2)}`);
        check(
          bestLift >= 1.25,
          `at night my torch lights the house's outer face beside me (${torchFace.key}: ${(bestLift * 100).toFixed(0)}% of the same face with the torch off; 100% on the build whose outer-face rule ran outdoors)`,
        );
      }
    }
    //    b) "The house still flashes red when I run out" (257.4,305.0 at night,
    //       the whole roof slab warm): the exit pinned where the roof is
    //       opaque, against the settled night frame — the slab no brighter
    //       than the street's own ratio allows, and no warmer than it settles.
    await at(inSpot[0], inSpot[1], "just inside the door at night");
    await page.waitForFunction(() => { try { return window.__ml.sceneryIndoor().drawnRoofed > 0 && window.__ml.indoorLight().roomHasLight; } catch { return false; } }, null, { timeout: 120_000, polling: 500 }).catch(() => {});
    await page.evaluate(() => window.__ml.indoorMixPin(0.55));
    const flippedN = await hopOut();
    check(flippedN, "the night hop through the doorway starts the exit crossfade (blend pinned at 0.55)");
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const nightHalf = await measure("night exit pinned 0.55");
    await page.evaluate(() => window.__ml.indoorMixPin(null));
    const landedN = await page.waitForFunction(() => { const f = window.__ml.indoorFade(); return !f.inside && f.mix <= 0 && !f.exiting; }, null, { timeout: 120_000, polling: 250 }).then(() => true).catch(() => false);
    check(landedN, "the night exit crossfade lands outdoors");
    await settle();
    await parkCam();
    const nightDone = await measure("night settled outside");
    if (nightHalf.stats.roof && nightDone.stats.roof) {
      // ABSOLUTE, not a ratio of ratios: at night these are 8-12 luma out of
      // 255, where a 25% band is two units of noise. What his report is about
      // is a roof that LIGHTS UP and goes WARM, so that is what this asserts —
      // no brighter than the settled night roof by more than 6 luma, and no
      // warmer. (The day arm above keeps the proportional test, where the
      // numbers are 50-100 and a ratio means something.)
      const warm = (v) => v[0] - v[2];
      const l0 = luma(nightDone.stats.roof);
      const l1 = luma(nightHalf.stats.roof);
      console.log(`  night roof: mid-exit ${l1.toFixed(1)} (R-B ${warm(nightHalf.stats.roof).toFixed(0)}) settled ${l0.toFixed(1)} (R-B ${warm(nightDone.stats.roof).toFixed(0)}); street ${luma(nightHalf.stats.street).toFixed(1)} -> ${luma(nightDone.stats.street).toFixed(1)}`);
      check(l1 <= l0 + 6, `at night the roof does not light up through the exit (mid-exit ${l1.toFixed(1)} vs settled ${l0.toFixed(1)} luma)`);
      check(warm(nightHalf.stats.roof) <= warm(nightDone.stats.roof) + 6, `mid-exit the roof is no warmer than it settles (R-B ${warm(nightHalf.stats.roof).toFixed(0)} vs ${warm(nightDone.stats.roof).toFixed(0)})`);
    } else {
      check(false, "the roof cell is in view at night to measure");
    }
    //    c) THE TORCH ON THE WALL BESIDE ME, MID-FADE (maintainer 2026-09-20,
    //       two screenshots: "the walls are super dark during the fade and get
    //       normal brightness when the fade to outdoor has completed"). An
    //       outer face is outside my room, so the two blocks meant for my
    //       room's own lights — the roof/wall line of sight, and "a pixel
    //       outside my room above a light takes none of it" — fired on the
    //       torch in my hand, which stands lower than the face. The same face,
    //       torch on, at mix 0.55 and settled, from the SAME spot: measured
    //       from the door the far wall barely reads the torch at all (1.02
    //       with the light working), so this uses the wall cell BESIDE the
    //       door, one cell from where the hop lands.
    const sideCells = [[door.x - 1, door.y], [door.x + 1, door.y], [door.x, door.y - 1], [door.x, door.y + 1]]
      .filter(([x, y]) => house.cells.has(`${x},${y}`) && (doc.level?.[y]?.[x] ?? 0) === wallL && clearFace(x, y, door.ox, door.oy));
    const sideWall = sideCells[0] ?? null;
    if (!sideWall) {
      check(false, "a scenery-free wall cell beside the door is available for the mid-fade torch arm");
    } else {
      const keptS = southWall, keptE = eastWall;
      const sideKey = door.oy !== 0 ? "southFace" : "eastFace";
      if (sideKey === "southFace") { southWall = sideWall; eastWall = null; } else { eastWall = sideWall; southWall = null; }
      await page.evaluate(() => window.__ml.torch?.(true));
      await at(inSpot[0], inSpot[1], "just inside the door at night, torch lit, for the mid-fade wall");
      await page.waitForFunction(() => { try { return window.__ml.sceneryIndoor().drawnRoofed > 0; } catch { return false; } }, null, { timeout: 120_000, polling: 500 }).catch(() => {});
      await page.evaluate(() => window.__ml.indoorMixPin(0.55));
      const flippedW = await hopOut();
      check(flippedW, "the torch-lit hop starts the exit crossfade (blend pinned at 0.55)");
      await new Promise((r) => setTimeout(r, 1200)); // the torch's slot ramp
      await parkCam();
      const wallMid = await measure("night wall mid-fade, torch on");
      await page.evaluate(() => window.__ml.indoorMixPin(null));
      await page.waitForFunction(() => { const f = window.__ml.indoorFade(); return !f.inside && f.mix <= 0 && !f.exiting; }, null, { timeout: 120_000, polling: 100 }).catch(() => {});
      await settle();
      // the SAME spot, so the torch stands exactly where it stood
      await page.evaluate(([c, r]) => window.__ml.teleport(c, r), hop);
      await new Promise((r) => setTimeout(r, 1200));
      await parkCam();
      const wallDone = await measure("night wall settled, torch on");
      const a = wallMid.stats[sideKey], b = wallDone.stats[sideKey];
      if (!a || !b) {
        check(false, `the wall beside the door (${sideKey}, cell ${sideWall}) is in view to measure the torch mid-fade`);
      } else {
        const keep = luma(a) / Math.max(0.5, luma(b));
        console.log(`  night wall beside the door (${sideWall}): mid-fade ${luma(a).toFixed(1)} vs settled ${luma(b).toFixed(1)} = ${(keep * 100).toFixed(0)}%`);
        check(keep >= 0.5, `mid-fade my torch still lights the wall beside me — ${(keep * 100).toFixed(0)}% of its settled torch-lit value (it went black and snapped at the landing when my room's light block ran on every light)`);
      }
      southWall = keptS; eastWall = keptE;
    }
    //    d) THE LANDING, TRACED PER FRAME — a still frame cannot see a transient,
    //       and the pinned frames above were clean on the build he caught the
    //       flash on. An UNPINNED exit with winTrace sampling the roof cell's
    //       own light every frame (the CPU twin, the glow stamps included, the
    //       same rule the night pass draws): at the landing that build deleted
    //       the hearth from tenure (its gain at 0.01) and handed its pool stamp
    //       back at FULL alpha with the room mask gone — the roof's light
    //       jumped past its settled value, and warm. The stamp wears the
    //       room's gain now (stampsToDraw), so the roof never exceeds what it
    //       settles at.
    if (roofCell) {
      await at(inSpot[0], inSpot[1], "just inside the door at night, for the traced exit");
      await page.waitForFunction(() => { try { return window.__ml.sceneryIndoor().drawnRoofed > 0 && window.__ml.indoorLight().roomHasLight; } catch { return false; } }, null, { timeout: 120_000, polling: 500 }).catch(() => {});
      await page.evaluate(([c, r, z]) => window.__ml.winTrace(true, [c, r, z]), [roofCell[0], roofCell[1], roofL]);
      //    ...AND THE GROUND UNDER THE FADE LAYER, SAMPLED EVERY FRAME (the frame
      //    he caught): at the landing the per-cell repaint can only POISON the
      //    latch — the house's cells exceed half the ground texture after the
      //    splits, or a full paint is already owed — and the real roof lands
      //    with the next frame's full paint. The build he caught it on dropped
      //    the opaque roof layer in the landing frame regardless, so for that
      //    frame the cut state showed where the roof stands: the parquet floor
      //    and the wall stumps, lit as the street — a whole warm roof, one
      //    frame long. The layer now outlives the swap until the latch is valid
      //    and no slice is owed (easeIndoorMix's landing branch). A page-side
      //    sampler reads the fade probe after every Phaser step.
      await page.evaluate(() => {
        const w = window;
        w.__mlLand = [];
        const tick = () => { try { const f = w.__ml.indoorFade(); w.__mlLand.push({ n: w.__mlLand.length, mix: f.mix, inside: f.inside, exiting: f.exiting, debris: f.debris, owed: f.groundOwed, slices: f.groundSlices, cellFull: f.cellFull }); } catch {} if (w.__mlLand.length < 100000) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      await page.evaluate(() => window.__ml.indoorMixPin(null));
      const flippedT = await hopOut();
      check(flippedT, "the traced night hop starts the exit crossfade (unpinned)");
      const landedT = await page.waitForFunction(() => { const f = window.__ml.indoorFade(); return !f.inside && f.mix <= 0 && !f.exiting; }, null, { timeout: 120_000, polling: 100 }).then(() => true).catch(() => false);
      check(landedT, "the traced night exit lands");
      // ...and the room's pieces are dropped by the rebuild that follows, so the
      // last frames are the settled outdoors and not the window itself.
      await page.waitForFunction(() => { try { return window.__ml.sceneryIndoor().drawnRoofed === 0; } catch { return false; } }, null, { timeout: 60_000, polling: 200 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      const tr = await page.evaluate(() => window.__ml.winTrace(false));
      const frames = (tr?.scene ?? []).filter((r) => Array.isArray(r.lit) && r.lit.length === 3);
      const out = frames.filter((r) => !r.inside);
      const settledLit = out.length ? luma(out[out.length - 1].lit) : NaN;
      let peak = 0;
      let peakRow = null;
      for (const r of out) { const l = luma(r.lit); if (l > peak) { peak = l; peakRow = r; } }
      for (const r of out) console.log(`    f${r.f} mix ${r.mix} grade ${r.grade} roomOn ${r.roomOn} slots ${r.slots} lights ${r.lights} stamps drawn ${r.drawN}/${r.drawA} roofed ${r.roofed} lit ${r.lit.map((v) => v.toFixed(3)).join(",")}`);
      console.log(`  traced exit: ${frames.length} frames, ${out.length} after the flip; the roof cell's light settles at ${settledLit.toFixed(3)}, peak ${peak.toFixed(3)} at f${peakRow?.f} (mix ${peakRow?.mix}, grade ${peakRow?.grade}, roomOn ${peakRow?.roomOn}, stamps drawn ${peakRow?.drawN}/${peakRow?.drawA})`);
      check(out.length >= 3 && Number.isFinite(settledLit), `the trace holds the exit and its landing (${out.length} frames after the flip)`);
      check(
        peak <= settledLit * 1.15 + 0.02,
        `through the traced exit the roof cell's light never exceeds what it settles at (peak ${peak.toFixed(3)} vs settled ${settledLit.toFixed(3)}; a sealed room's pool stamp wears the room's gain)`,
      );
      const land = await page.evaluate(() => { const w = window; const s = w.__mlLand ?? []; w.__mlLand = null; return s; });
      const first = land.findIndex((r) => !r.inside);
      const after = first < 0 ? [] : land.slice(first);
      const fallback = after.length ? after[after.length - 1].cellFull - after[0].cellFull : 0;
      const gaps = after.filter((r) => r.debris === 0 && (r.owed || r.slices > 0));
      const landedAt = after.findIndex((r) => !r.exiting);
      console.log(`  landing sampler: ${land.length} frames, ${after.length} after the flip, landed at +${landedAt}; per-cell repaint fell back to a full paint ${fallback} time(s); frames with the roof layer gone over an unpainted ground: ${gaps.length}` +
        (gaps.length ? ` (first: ${JSON.stringify(gaps[0])})` : ""));
      for (const r of after.slice(Math.max(0, landedAt - 2), landedAt + 4)) console.log(`    +${r.n - after[0].n} mix ${r.mix} exiting ${r.exiting} debris ${r.debris} owed ${r.owed} slices ${r.slices} cellFull ${r.cellFull}`);
      check(after.length >= 3 && landedAt >= 0, `the landing sampler saw the exit land (${after.length} frames after the flip)`);
      check(gaps.length === 0, `the roof layer is never gone while the ground under it is still owed a paint (${gaps.length} such frames; the build he caught the flash on dropped it in the landing frame regardless)`);
      if (fallback === 0) console.log("  (the per-cell repaint landed in the frame on this viewport — the hold was not exercised here; it is exercised where the house's box exceeds half the ground texture)");
    }
  }
}

await browser.close(); stop();
console.log(fails.length ? `\nverify-indoorscenery: ${fails.length} FAILED` : "\nverify-indoorscenery: OK");
process.exit(fails.length ? 1 : 0);
