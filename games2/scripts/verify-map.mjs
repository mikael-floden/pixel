// THE MAP TAB — the image it loads, and whether the dot lands on the player.
//
// THE RENDER IS CROPPED TO THE ISLAND (maps2 d8a399b1a6): deep water is drawn
// as nothing and the transparent border cut away, so a fraction of the full
// iso canvas — which is how the client placed the dot for a year — is wrong by
// construction. maps2 publishes the arithmetic beside the image as
// `minimap.json` (pixel-maps3/minimap@1), and the client uses it verbatim.
//
// GROUND TRUTH HERE IS THAT DOC'S OWN WORKED SAMPLES, not a second evaluation
// of its formula: maps2 lists real land cells with the pixel each one lands
// on, asserted at build time against the alpha of the file itself. Teleport to
// each, and the dot must be there. A gate that re-ran the formula would agree
// with the client about a shared misreading of it — including the one thing
// worth being suspicious of, whether `col` means the same thing on both sides.
//
// Also pinned: the file NAME (overview.webp is deleted — asking for it only
// 404s), a ceiling on its size (it was once the 16300x7576 / 15 MB review
// render, fetched on a phone into a ~360px frame), and that the doc is not
// STALE — its `world` must be the grid the game actually loaded, or every
// sample below is describing a different island.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const MAX_MAP_W = 2400;
const TOL = 0.015; // 1.5% of the frame

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);

const ctx = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 90000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.click('.ml-tab[data-tab="map"]');
  await page.waitForFunction(() => {
    const i = document.querySelector(".ml-map-frame img");
    return i && i.naturalWidth > 0;
  }, null, { timeout: 20000 });

  const feed = await page.evaluate(() => window.__ml.minimap());
  const img = await page.evaluate(() => {
    const i = document.querySelector(".ml-map-frame img");
    return { src: i.getAttribute("src"), nat: [i.naturalWidth, i.naturalHeight] };
  });
  // The doc, fetched the same way the client does.
  const meta = await page.evaluate(async (src) => {
    const res = await fetch(src.replace(/minimap\.(webp|png)$/, "minimap.json"));
    return res.ok ? res.json() : null;
  }, img.src);

  // ── 1. the file ────────────────────────────────────────────────────────
  /minimap\.(webp|png)(\?|$)/.test(img.src)
    ? ok(`the Map tab asks for the only name there is (${img.src})`)
    : fail(`Map tab loaded "${img.src}" — overview.webp is deleted; minimap is the name`);
  img.nat[0] <= MAX_MAP_W
    ? ok(`…and it is the map render, not the review render (${img.nat.join("x")})`)
    : fail(`the map image is ${img.nat.join("x")} — over ${MAX_MAP_W}px wide is a QA render being scaled into a ~360px frame on a phone`);

  if (!meta) {
    fail("no minimap.json beside the image — a CROPPED render cannot be placed on without it");
  } else {
    // ── 2. the doc describes THIS world and THIS image ───────────────────
    meta.schema === "pixel-maps3/minimap@1"
      ? ok(`minimap.json is ${meta.schema}`)
      : fail(`minimap.json schema is "${meta.schema}"`);
    meta.size?.w === img.nat[0] && meta.size?.h === img.nat[1]
      ? ok(`…and its size is the image's own (${meta.size.w}x${meta.size.h})`)
      : fail(`doc says ${meta.size?.w}x${meta.size?.h}, image is ${img.nat.join("x")} — the two were not generated together`);
    !meta.world || (meta.world.w === feed.w && meta.world.h === feed.h)
      ? ok(`…for the grid the game loaded (${feed.w}x${feed.h})`)
      : fail(`doc is for a ${meta.world.w}x${meta.world.h} world, the game loaded ${feed.w}x${feed.h} — STALE, every sample describes a different island`);

    // ── 3. the dot, against maps2's own worked samples ───────────────────
    const dotAt = async (col, row) => {
      await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [col, row]);
      // WAIT FOR THE BODY TO BE THERE. A teleport across the island crosses
      // ZONE rooms, and during the hand-off there is no local body to ask —
      // `me()` is briefly undefined (a throw here skipped every check after
      // this section). Waiting for the body to be AT the asked-for cell is
      // what makes the settle below honest: poll it too early and the dot
      // reads two identical samples of where the player still is, calls that
      // settled, and the sample is judged against the previous cell.
      // Settle on the DOT: the map loop paints it from the avatar's render
      // position, which trails the teleport by frames — a fixed wait reads
      // the PREVIOUS sample on this harness.
      let landed = false;
      for (let i = 0; i < 60 && !landed; i++) {
        landed = await page.evaluate(([c, r]) => {
          const me = window.__ml.me();
          return !!me && Math.abs(me.x / 32 - c) <= 1.5 && Math.abs(me.y / 32 - r) <= 1.5;
        }, [col, row]);
        if (!landed) await page.waitForTimeout(250);
      }
      if (!landed) return null;
      let prev = "", cur = "";
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(150);
        cur = await page.evaluate(() => {
          const d = document.querySelector(".ml-map-dot");
          return d ? `${d.style.left}|${d.style.top}` : "";
        });
        if (cur && cur === prev) break;
        prev = cur;
      }
      // …and it can drop again while the dot settles, so the read itself
      // retries rather than throwing on a body that is mid-hand-off.
      for (let i = 0; i < 40; i++) {
        const got = await page.evaluate(() => {
          const d = document.querySelector(".ml-map-dot");
          const f = document.querySelector(".ml-map-frame")?.getBoundingClientRect();
          const me = window.__ml.me();
          if (!d || !f || !me) return null;
          const r = d.getBoundingClientRect();
          return { fx: (r.left + r.width / 2 - f.left) / f.width, fy: (r.top + r.height / 2 - f.top) / f.height,
                   col: +(me.x / 32).toFixed(1), row: +(me.y / 32).toFixed(1) };
        });
        if (got) return got;
        await page.waitForTimeout(250);
      }
      return null;
    };
    const samples = Array.isArray(meta.samples) ? meta.samples : [];
    samples.length >= 3 ? ok(`${samples.length} worked samples to check against`) : fail(`minimap.json ships ${samples.length} samples`);
    for (const s of samples) {
      const [cx, cy] = s.cell;
      const want = [s.px[0] / meta.size.w, s.px[1] / meta.size.h];
      const got = await dotAt(cx, cy);
      if (!got) {
        fail(`"${s.what}": no player after teleporting to (${cx},${cy}) — the zone hand-off never landed`);
        continue;
      }
      // The teleport has to have LANDED, or the dot is honestly reporting a
      // place the player is not (deep water is clamped to the world rim).
      if (Math.abs(got.col - cx) > 1.5 || Math.abs(got.row - cy) > 1.5) {
        fail(`"${s.what}": asked for cell (${cx},${cy}), the player is at (${got.col},${got.row}) — cannot judge the dot`);
        continue;
      }
      const dx = Math.abs(got.fx - want[0]), dy = Math.abs(got.fy - want[1]);
      dx <= TOL && dy <= TOL
        ? ok(`"${s.what}" (${cx},${cy}) → dot at ${got.fx.toFixed(3)},${got.fy.toFixed(3)} vs published ${want[0].toFixed(3)},${want[1].toFixed(3)}`)
        : fail(`"${s.what}" (${cx},${cy}): dot at ${got.fx.toFixed(3)},${got.fy.toFixed(3)}, maps2 says ${want[0].toFixed(3)},${want[1].toFixed(3)} — off by ${(dx * 100).toFixed(1)}%/${(dy * 100).toFixed(1)}% of the frame`);
    }

    // ── 4. THE DUNGEONS LAYER ───────────────────────────────────────────
    // The map shows maps2's named caves (maintainer 2026-09-11, relaying the
    // maps agent: the map should "display/show all dungeons" once the caves
    // being dug are done). Two halves, and the run proves both.
    //
    // A: no places.json yet → the chip must NOT be offered. A button that
    // draws nothing is worse than no button, and this is the state the world
    // is in today, so it is the one that would ship unnoticed.
    const chip = () =>
      page.evaluate(() => {
        const b = [...document.querySelectorAll(".ml-maplayers .ml-plate-btn")].find(
          (x) => x.textContent.trim() === "dungeons",
        );
        return b ? { hidden: !!b.hidden } : null;
      });
    const before = await chip();
    if (!before) fail("no dungeons chip in the Map tab's layer row at all");
    else if (before.hidden) ok("dungeons chip stays hidden while the world publishes no caves");
    else ok("dungeons chip is offered — this world already publishes caves");

    // B: with a cave published, the pin lands where maps2 says that cell
    // lands. GROUND TRUTH IS THE SAME WORKED SAMPLE THE DOT IS JUDGED BY —
    // the fixture's entrance IS sample 0's cell, so a pin that agrees with
    // the published pixel cannot be agreeing with a shared misreading of the
    // formula. The fixture rides ON TOP of whatever the world really ships,
    // so this check keeps working the day maps2 publishes real caves.
    if (samples.length) {
      const s0 = samples[0];
      await page.route("**/places.json*", async (route) => {
        let doc = { schema: "pixel-maps2/places@2", world: feed.world, places: [] };
        try {
          const r = await route.fetch();
          if (r.ok()) doc = await r.json();
        } catch {
          /* nothing published — the fixture alone */
        }
        doc.places = [
          ...(Array.isArray(doc.places) ? doc.places : []),
          {
            id: "gate_test_cave",
            name: "Gate Cave",
            kind: "cave",
            indoor: true,
            elev: [0, 0],
            anchor: s0.cell,
            entrance: s0.cell,
            cells: [], // empty on purpose: the SCENE's place lookup ignores it
          },
        ];
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(doc) });
      });
      // the loader reads places once per world, so the fixture needs a fresh page
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
      await page.evaluate(() => window.__mlSelect.commit());
      await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 90000 });
      await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 60000 });
      await page.click('.ml-tab[data-tab="map"]');
      await page.waitForFunction(() => {
        const i = document.querySelector(".ml-map-frame img");
        return i && i.naturalWidth > 0;
      }, null, { timeout: 20000 });
      let after = null;
      for (let i = 0; i < 40 && !(after && !after.hidden); i++) {
        await page.waitForTimeout(200);
        after = await chip();
      }
      after && !after.hidden
        ? ok("dungeons chip appears once a cave is published")
        : fail("a cave is published and the dungeons chip is still not offered");
      await page.evaluate(() => window.__ml.mapLayers("dungeons", true));
      let pins = [];
      for (let i = 0; i < 40 && !pins.length; i++) {
        await page.waitForTimeout(200);
        pins = await page.evaluate(() => {
          const f = document.querySelector(".ml-map-frame").getBoundingClientRect();
          return [...document.querySelectorAll(".ml-maplayer-marks b.pin")].map((b) => {
            const d = b.querySelector("s").getBoundingClientRect();
            return {
              name: b.querySelector("em")?.textContent ?? "",
              fx: (d.left + d.width / 2 - f.left) / f.width,
              fy: (d.top + d.height / 2 - f.top) / f.height,
            };
          });
        });
      }
      const mine = pins.find((p) => p.name === "Gate Cave");
      if (!mine) fail(`the dungeons layer drew no pin for the published cave (${pins.length} pins: ${pins.map((p) => p.name).join(", ")})`);
      else {
        const want = [s0.px[0] / meta.size.w, s0.px[1] / meta.size.h];
        const dx = Math.abs(mine.fx - want[0]);
        const dy = Math.abs(mine.fy - want[1]);
        dx <= TOL && dy <= TOL
          ? ok(`dungeon pin on "${s0.what}" (${s0.cell.join(",")}) at ${mine.fx.toFixed(3)},${mine.fy.toFixed(3)} vs published ${want[0].toFixed(3)},${want[1].toFixed(3)} (${pins.length} pin${pins.length === 1 ? "" : "s"} drawn)`)
          : fail(`dungeon pin at ${mine.fx.toFixed(3)},${mine.fy.toFixed(3)}, maps2 says ${want[0].toFixed(3)},${want[1].toFixed(3)} — off by ${(dx * 100).toFixed(1)}%/${(dy * 100).toFixed(1)}% of the frame`);
      }
      // …AND A PIN IS PLACED THE WAY THE PLAYER IS. maps2's projection lifts a
      // cell by its LEVEL (py = ky*(x+y) - kz*level + y0, kz = 1.05px per
      // storey here), and every published worked sample is a level-0 land
      // corner — so the samples above cannot tell a level-aware projection
      // from one that passes 0, and the first version of this layer passed 0.
      // Measured cost: a cave mouth 30 storeys up the massif landed 32px low
      // on a 478px image, 6.6% of the frame, out on the snowfield below the
      // hole he walks into (maintainer 2026-09-12).
      // GROUND TRUTH IS THE DOT, not a second evaluation of the formula: the
      // dot is independently gated against maps2's samples above, so standing
      // the player ON the mouth and requiring the pin to be under them tests
      // the one thing at issue through a different mechanism.
      const doc = await page.evaluate(
        async (src) => {
          const res = await fetch(src.replace(/minimap\.(webp|png)$/, "places.json"));
          return res.ok ? res.json() : null;
        },
        img.src,
      );
      const spots = [];
      for (const pl of doc?.places ?? []) {
        if (pl?.kind !== "cave") continue;
        const list = Array.isArray(pl.entrances) && pl.entrances.length ? pl.entrances : [pl.entrance];
        for (const e of list) if (Array.isArray(e)) spots.push({ name: pl.name ?? pl.id, cell: e });
      }
      if (!spots.length) console.log("note: the world publishes no caves yet — the level check has nothing to stand on");
      else {
        const lv = await page.evaluate(
          (cells) => cells.map(([x, y]) => window.__ml.levelAt((x + 0.5) * 32, (y + 0.5) * 32)),
          spots.map((s) => s.cell),
        );
        let best = 0;
        for (let i = 1; i < lv.length; i++) if (lv[i] > lv[best]) best = i;
        const high = { ...spots[best], level: lv[best] };
        if (!high.level)
          console.log(`note: the highest published cave mouth is at level 0 (${high.name}) — this run cannot tell the level apart`);
        else {
          const got = await dotAt(high.cell[0], high.cell[1]);
          // BY CELL, not by the rendered name: the crowded pins are the ones
          // whose name is dropped, and they are exactly the ones on the massif
          // where the level matters — looking them up by text made this check
          // skip itself on the one case it exists for.
          const pin = await page.evaluate((cell) => {
            const f = document.querySelector(".ml-map-frame").getBoundingClientRect();
            const b = document.querySelector(`.ml-maplayer-marks b.pin[data-cell="${cell}"]`);
            if (!b) return null;
            const d = b.querySelector("s").getBoundingClientRect();
            return { fx: (d.left + d.width / 2 - f.left) / f.width, fy: (d.top + d.height / 2 - f.top) / f.height };
          }, high.cell.join(","));
          if (!got) fail(`could not stand on ${high.name}'s mouth (${high.cell.join(",")}) to check its pin`);
          else if (!pin) fail(`no pin at ${high.name}'s mouth (${high.cell.join(",")}) — the layer published no mark for the cell it was asked to`);
          else {
            const dx = Math.abs(pin.fx - got.fx);
            const dy = Math.abs(pin.fy - got.fy);
            dx <= TOL && dy <= TOL
              ? ok(`${high.name}'s pin is under the player standing on it (level ${high.level}, ${(dy * 100).toFixed(2)}% apart)`)
              : fail(`${high.name}'s mouth is at level ${high.level}: the pin is at ${pin.fx.toFixed(3)},${pin.fy.toFixed(3)} and the player standing on it is at ${got.fx.toFixed(3)},${got.fy.toFixed(3)} — off by ${(dx * 100).toFixed(1)}%/${(dy * 100).toFixed(1)}% of the frame`);
          }
        }
      }

      // …and it is a LAYER: switching it off leaves nothing behind.
      await page.evaluate(() => window.__ml.mapLayers("dungeons", false));
      await page.waitForTimeout(600);
      const left = await page.evaluate(() => document.querySelectorAll(".ml-maplayer-marks b.pin").length);
      left === 0 ? ok("turning the layer off clears its pins") : fail(`${left} pin(s) survived the layer being turned off`);
    }
  }

  errors.length === 0 ? ok("no page errors") : fail(`page errors: ${errors.join(" | ")}`);
} finally {
  await browser.close();
}
console.log(bad ? "\nMAP: FAIL" : "\nMAP: PASS");
process.exit(bad ? 1 : 0);
