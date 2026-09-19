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
const OUT = process.env.OUT || "/tmp";
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
    // A: no places.json yet → the layer must NOT be offered. A row that
    // draws nothing is worse than no row, and this is the state the world
    // is in today, so it is the one that would ship unnoticed. The layers
    // live in the CHOOSER now (maintainer 2026-09-18: one "layers" button
    // and a multi-select dialog, because the ambient-zone layers are one per
    // effect); `mapLayerList()` is what the dialog is built from.
    const offered = () => page.evaluate(() => window.__mlMapLayers?.list() ?? null);
    const before = await offered();
    if (!before) fail("no __mlMapLayers probe — the chooser's data is not exposed");
    else if (!before.some((l) => l.id === "zones")) fail(`the chooser offers no zones layer: ${JSON.stringify(before)}`);
    else if (!before.some((l) => l.id === "dungeons")) ok("dungeons layer stays unoffered while the world publishes no caves");
    else ok("dungeons layer is offered — this world already publishes caves");

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
      // NO AMBIENT FIXTURE. maps2 PUBLISHES `ambient.json`
      // (pixel-maps3/ambient@1) and this gate reads THAT — the real 90 zones
      // and 32 effects, out of the tree the dev server is serving. The first
      // version of this section routed a fixture of a schema PROPOSED to maps2
      // and never adopted (`ambient_zones.json`), so the whole path passed
      // green here while production 404'd and the Ambient zones group was
      // simply absent on his phone (maintainer 2026-09-19: "THIS IS A CRITICAL
      // BUG! I AM ON YOUR NEW VERSION AND IT DOESN'T COME UP!"). A fixture may
      // stand in for data that is HARD TO STAGE; it may never stand in for the
      // producer's own published file, because then the one thing the gate
      // cannot see is the only thing that broke.
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
      // WHAT MAPS2 ACTUALLY PUBLISHES — fetched by the gate itself, so the
      // name and the schema are asserted rather than assumed. A rename on
      // their side turns this red instead of emptying the group in silence.
      const amb = await page.evaluate(async (w) => {
        const res = await fetch(`/assets/maps2/worlds3/${w}/ambient.json`);
        if (!res.ok) return { status: res.status };
        const doc = await res.json();
        const effects = [...new Set((doc.zones || []).flatMap((z) => Object.keys(z.effects || {})))].sort();
        return { status: 200, schema: doc.schema, zones: (doc.zones || []).length, effects };
      }, feed.world);
      amb.status === 200 && amb.schema === "pixel-maps3/ambient@1" && amb.zones > 0 && amb.effects.length > 0
        ? ok(`maps2 publishes ambient.json (${amb.schema}, ${amb.zones} zones, ${amb.effects.length} effects)`)
        : fail(`the ambient file this reader depends on is not there: ${JSON.stringify(amb).slice(0, 300)} — expected /assets/maps2/worlds3/${feed.world}/ambient.json, schema pixel-maps3/ambient@1`);
      const someEffect = amb.effects?.[0];
      let after = null;
      const hasLayer = (list, id) => Array.isArray(list) && list.some((l) => l.id === id);
      for (let i = 0; i < 40 && !(hasLayer(after, "dungeons") && hasLayer(after, `ambient:${someEffect}`)); i++) {
        await page.waitForTimeout(200);
        after = await offered();
      }
      hasLayer(after, "dungeons")
        ? ok("dungeons layer is offered once a cave is published")
        : fail("a cave is published and the dungeons layer is still not offered");
      // EVERY effect in the file becomes a layer — not just the one we looked
      // for. A reader that drops effects would pass a spot check.
      {
        const got = (after || []).filter((l) => l.group === "ambient").map((l) => l.id.slice(8)).sort();
        const missing = (amb.effects || []).filter((e) => !got.includes(e));
        missing.length === 0 && got.length === (amb.effects || []).length
          ? ok(`every one of the file's ${got.length} effects is offered as a layer`)
          : fail(`${missing.length} effect(s) in ambient.json have no layer: ${missing.slice(0, 8).join(", ")} (offered ${got.length} of ${amb.effects?.length})`);
      }
      // THE AMBIENT-ZONE LAYER: derived from the file, grouped "ambient",
      // drawn as a tinted parallelogram once on, listed under its own group
      // in the chooser.
      // ONE EFFECT, PICKED FROM THE FILE, drawn on the map. `rain` by name if
      // maps2 still places it, else whatever the file's first effect is — the
      // gate must not hardcode content it does not own.
      const pickEffect = (amb.effects || []).includes("rain") ? "rain" : someEffect;
      const rainRow = Array.isArray(after) && after.find((l) => l.id === `ambient:${pickEffect}`);
      rainRow && rainRow.group === "ambient"
        ? ok(`ambient.json yields an ambient:${pickEffect} layer in the ambient group`)
        : fail(`no ambient:${pickEffect} layer from the published file: ${JSON.stringify((after || []).map((l) => l.id))}`);
      if (rainRow) {
        await page.evaluate((e) => window.__ml.mapLayers(`ambient:${e}`, true), pickEffect);
        let wash = null;
        for (let i = 0; i < 20 && !wash; i++) {
          await page.waitForTimeout(150);
          wash = await page.evaluate(() => {
            // maps2's areas are POLYGONS (coastlines run to 830 points), so
            // the path is a long M…L…Z, never a four-corner quad.
            const p = [...document.querySelectorAll(".ml-maplayer-svg path")].find((e) => e.getAttribute("fill-opacity"));
            if (!p) return null;
            const b = p.getBoundingClientRect(), f = document.querySelector(".ml-map-frame").getBoundingClientRect();
            const svg = document.querySelector(".ml-maplayer-svg");
            const sb = svg.getBoundingClientRect(), cs = getComputedStyle(svg);
            return {
              fill: p.getAttribute("fill"), alpha: p.getAttribute("fill-opacity"),
              pts: (p.getAttribute("d").match(/L/g) || []).length + 1,
              w: Math.round(b.width), h: Math.round(b.height),
              // it must LAND ON the map — a zone whose geometry also runs past
              // the island is normal (the render is cropped to the island and
              // the seas are not), which is exactly what the clip is for.
              overlaps: b.right > f.left && b.left < f.right && b.bottom > f.top && b.top < f.bottom,
              // …and the clip is the thing to assert: the layer box is the
              // frame, and it hides what leaves it. Without this the outer
              // zones' lines escaped over the game view (measured 2026-09-11).
              clip: cs.overflow === "hidden" && Math.abs(sb.width - f.width) <= 1 && Math.abs(sb.height - f.height) <= 1 && Math.abs(sb.left - f.left) <= 1 && Math.abs(sb.top - f.top) <= 1,
            };
          });
        }
        wash && wash.w > 2 && wash.h > 2 && wash.overlaps && wash.pts >= 3
          ? ok(`the ${pickEffect} zones draw as tinted polygons on the map (${wash.pts} points, ${wash.w}x${wash.h}px, ${wash.fill} at ${wash.alpha})`)
          : fail(`${pickEffect} zones not drawn: ${JSON.stringify(wash)}`);
        wash && wash.clip
          ? ok("…and the layer box is the map frame with overflow hidden, so a sea zone running past the island crop is CLIPPED, not loose over the game view")
          : fail(`the overlay is not clipped to the map frame: ${JSON.stringify(wash)}`);
        const marksText = await page.evaluate(() => document.querySelector(".ml-maplayer-marks")?.textContent.trim() ?? "");
        marksText === "" ? ok("no text over the map for the zone (its pct is the fill's depth)") : fail(`zone layer wrote text over the map: "${marksText}"`);
        await page.evaluate(() => document.querySelector(".ml-maplayers .ml-plate-btn").click());
        await page.waitForTimeout(150);
        const grp = await page.evaluate((e) => ({
          groups: [...document.querySelectorAll(".ml-layers .ml-layers-h span")].map((x) => x.textContent.trim()),
          rain: !!document.querySelector(`.ml-layers [data-layer="ambient:${e}"]`),
        }), pickEffect);
        grp.groups.includes("Ambient zones") && grp.rain
          ? ok(`the chooser shows the Ambient zones group with ${pickEffect} (${grp.groups.join(" / ")})`)
          : fail(`chooser groups ${JSON.stringify(grp)}`);
        // AT MOST TEN LAYERS, AND TEN COLOURS NOBODY CAN CONFUSE (maintainer
        // 2026-09-19: "add a max 10 layers limit so you don't need to come up
        // with too many different colors"). The two are one claim: the cap is
        // what lets the palette be ten hand-picked colours instead of a
        // generated wheel, so the gate turns on as many as it is allowed and
        // measures what they are actually wearing — including against the two
        // FIXED marks, since a pill matching `dungeons` is just as wrong as
        // two pills matching each other.
        //
        // SEPARATION, NOT INEQUALITY. The wheel this replaced put rain at 36°
        // and snow at 35°: two different colours by any === test and one
        // colour to the eye. Over maps2's real 32 it put `ants` and `thunder`
        // on the identical pixel value.
        const MIN_RGB = 30;
        await page.evaluate(() => {
          for (const l of window.__mlMapLayers.list()) window.__ml.mapLayers(l.id, false);
        });
        const filled = await page.evaluate(() => {
          const offered = window.__mlMapLayers.list().map((l) => l.id);
          for (const id of offered) window.__ml.mapLayers(id, true); // ask for all of them
          return { on: window.__ml.mapLayers().filter((id) => offered.includes(id)), offered: offered.length };
        });
        filled.on.length === 10 && filled.offered > 10
          ? ok(`asking for all ${filled.offered} layers leaves exactly 10 on — the cap holds`)
          : fail(`${filled.on.length} layers on after asking for all ${filled.offered} — want the 10 cap`);
        await page.waitForTimeout(400);
        const worn = await page.evaluate(() =>
          [...document.querySelectorAll(".ml-maplayer-pill")].map((p) => ({
            id: p.dataset.layer,
            rgb: getComputedStyle(p.querySelector(".ml-maplayer-sw")).backgroundColor.match(/[\d.]+/g).slice(0, 3).map(Number),
          })),
        );
        let worst = { d: 1e9, a: null, b: null };
        for (let i = 0; i < worn.length; i++)
          for (let j = i + 1; j < worn.length; j++) {
            const d = Math.hypot(...worn[i].rgb.map((v, k) => v - worn[j].rgb[k]));
            if (d < worst.d) worst = { d, a: worn[i], b: worn[j] };
          }
        worn.length === 10 && worst.d >= MIN_RGB
          ? ok(`all 10 live layers wear a colour of their own — closest pair ${worst.a.id}/${worst.b.id} is ${worst.d.toFixed(0)} apart in RGB (floor ${MIN_RGB})`)
          : fail(`two live layers look the same: ${worst.a?.id} vs ${worst.b?.id}, ${worst.d.toFixed(1)} apart, want >=${MIN_RGB} (${worn.length} pills)`);
        // …and the eleventh is REFUSED rather than silently dropped
        const eleventh = await page.evaluate(() => {
          const off = window.__mlMapLayers.list().find((l) => !l.on);
          if (!off) return null;
          const before = window.__ml.mapLayers().length;
          window.__ml.mapLayers(off.id, true);
          return { id: off.id, on: window.__ml.mapLayers().includes(off.id), before, after: window.__ml.mapLayers().length };
        });
        eleventh && !eleventh.on
          ? ok(`the eleventh layer (${eleventh.id}) is refused, and the ten already on are untouched`)
          : fail(`an eleventh layer went on: ${JSON.stringify(eleventh)}`);
        // the dialog SAYS so rather than swallowing the tap
        await page.evaluate(() => window.__mlMapLayers.open());
        await page.waitForTimeout(200);
        const capUi = await page.evaluate(() => {
          const rows = [...document.querySelectorAll(".ml-layers [data-layer]")];
          const offRows = rows.filter((r) => !r.classList.contains("on"));
          return {
            cap: document.querySelector(".ml-layers-cap")?.textContent.trim() ?? "",
            full: !!document.querySelector(".ml-layers-cap.full"),
            blocked: offRows.filter((r) => r.classList.contains("blocked") && r.disabled).length,
            offRows: offRows.length,
            emptySwatch: offRows.filter((r) => r.querySelector(".ml-maplayer-sw.empty")).length,
          };
        });
        capUi.full && /10 of 10/.test(capUi.cap) && capUi.blocked === capUi.offRows && capUi.offRows > 0
          ? ok(`at the cap every row that cannot go on is disabled and says why ("${capUi.cap}", ${capUi.blocked}/${capUi.offRows} rows)`)
          : fail(`the cap is not visible in the chooser: ${JSON.stringify(capUi)}`);
        capUi.emptySwatch === capUi.offRows
          ? ok("a layer that is off shows an EMPTY swatch — a colour is only claimed once something wears it")
          : fail(`${capUi.offRows - capUi.emptySwatch} off row(s) claim a colour they do not hold`);
        await page.evaluate(() => window.__mlMapLayers.close());
        // back to a clean slate for the sections below
        await page.evaluate(() => {
          for (const l of window.__mlMapLayers.list()) window.__ml.mapLayers(l.id, false);
        });
        await page.evaluate(() => document.querySelector(".ml-maplayers .ml-plate-btn").click());
        await page.waitForTimeout(150);
      }
      await page.evaluate(() => window.__ml.mapLayers("dungeons", true));
      let pins = [];
      for (let i = 0; i < 40 && !pins.length; i++) {
        await page.waitForTimeout(200);
        pins = await page.evaluate(() => {
          const f = document.querySelector(".ml-map-frame").getBoundingClientRect();
          return [...document.querySelectorAll(".ml-maplayer-marks b.pin")].map((b) => {
            const d = b.querySelector("s").getBoundingClientRect();
            return {
              name: b.dataset.pin ?? "",
              // NO TEXT OVER THE MAP (maintainer 2026-09-12: "I don't want any
              // text over the dungeons … just icon is enough"). The name rides
              // the element as data; ink on the island is the regression.
              text: b.textContent.trim(),
              fx: (d.left + d.width / 2 - f.left) / f.width,
              fy: (d.top + d.height / 2 - f.top) / f.height,
            };
          });
        });
      }
      // NO EXPLAINING TEXT IN THE MAP VIEW AT ALL (maintainer 2026-09-14): the
      // row is its CONTROLS and nothing else. What he asked to be rid of was
      // the CAPTION that narrated each live layer's marks; the button and the
      // legend pills (2026-09-19) are things you press, each carrying its own
      // one-word name. So the law is still exact — the row's whole text must
      // be its controls' text, and a caption would put a stray word in it.
      const rowText = await page.evaluate(() => {
        const row = document.querySelector(".ml-maplayers");
        if (!row) return null;
        const chips = [...row.querySelectorAll(".ml-plate-btn, .ml-maplayer-pill")].map((b) => b.textContent.trim());
        return { all: row.textContent.trim(), chips };
      });
      if (!rowText) fail("no layer row on the Map page");
      else if (rowText.all !== rowText.chips.join(""))
        fail(`the Map tab's layer row says more than its controls (${JSON.stringify(rowText.all)}) — no explaining text on this page`);
      else ok(`the layer row is its controls only (${rowText.chips.join(", ")})`);
      // THE CHOOSER (maintainer 2026-09-18): the button opens a dialog listing
      // the offered layers by group; a tick applies at once (the map behind
      // redraws), all/none per group, Done closes. The count on the button is
      // the number of offered layers on.
      await page.evaluate(() => document.querySelector(".ml-maplayers .ml-plate-btn").click());
      await page.waitForTimeout(150);
      const dlg = await page.evaluate(() => {
        const card = document.querySelector(".ml-layers");
        if (!card) return null;
        return {
          groups: [...card.querySelectorAll(".ml-layers-h span")].map((e) => e.textContent.trim()),
          rows: [...card.querySelectorAll("[data-layer]")].map((b) => ({ id: b.dataset.layer, on: b.classList.contains("on"), label: b.textContent.trim() })),
          text: card.textContent.trim(),
        };
      });
      if (!dlg) fail("the layers button opened no dialog");
      else {
        dlg.groups[0] === "Map" && dlg.rows.some((r) => r.id === "zones") && dlg.rows.some((r) => r.id === "dungeons")
          ? ok(`chooser lists the Map group with zones + dungeons (${dlg.rows.map((r) => r.id).join(", ")})`)
          : fail(`chooser contents: ${JSON.stringify(dlg)}`);
        const wasOn = await page.evaluate(() => window.__ml.mapLayers().includes("zones"));
        await page.evaluate(() => document.querySelector('.ml-layers [data-layer="zones"]').click());
        await page.waitForTimeout(120);
        const nowOn = await page.evaluate(() => window.__ml.mapLayers().includes("zones"));
        const btnText = await page.evaluate(() => document.querySelector(".ml-maplayers .ml-plate-btn").textContent.trim());
        nowOn !== wasOn ? ok(`ticking zones in the chooser flips the layer (${wasOn} -> ${nowOn}); button reads "${btnText}"`) : fail(`ticking zones did nothing (${wasOn} -> ${nowOn})`);
        // THE BUTTON IS A GLYPH IN THE CORNER (maintainer 2026-09-19: "can
        // just be a small ⧉ icon at the bottom right corner in order to save
        // space"). The count went with the words, so what is asserted is that
        // it still NAMES itself for a screen reader and that it is the last
        // thing in the row, furthest right and lowest — the corner.
        const corner = await page.evaluate(() => {
          const row = document.querySelector(".ml-maplayers");
          const btn = row.querySelector(".ml-maplayer-open");
          const b = btn.getBoundingClientRect();
          const others = [...row.querySelectorAll(".ml-maplayer-pill")].map((p) => p.getBoundingClientRect());
          return {
            text: btn.textContent.trim(),
            label: btn.getAttribute("aria-label") || btn.title || "",
            last: row.lastElementChild === btn,
            w: Math.round(b.width),
            rightmost: others.every((o) => o.right <= b.right + 0.5),
            lowest: others.every((o) => o.bottom <= b.bottom + 0.5),
            pills: others.length,
          };
        });
        corner.text === "⧉" && corner.last && corner.rightmost && corner.lowest && corner.w <= 34 && /layer/i.test(corner.label)
          ? ok(`the chooser is a ${corner.w}px ⧉ in the row's bottom-right, after ${corner.pills} pill(s), and still names itself ("${corner.label}")`)
          : fail(`the layers button is not the corner glyph: ${JSON.stringify(corner)}`);
        await page.evaluate(() => document.querySelector('.ml-layers [data-layer="zones"]').click()); // restore
        await page.evaluate(() => document.querySelector(".ml-layers-done").click());
        await page.waitForTimeout(100);
        (await page.evaluate(() => !document.querySelector(".ml-layers")))
          ? ok("Done closes the chooser")
          : fail("the chooser stayed open after Done");
      }

      // ── THE LEGEND PILLS (maintainer 2026-09-19: "Once something has been
      //    selected here I still think we should have a pill for it so the
      //    user can see what color correspond to what layer … so we don't
      //    have to [show] every ambient effect as a pill for all users all the
      //    time"). Two claims, and the second is the one that rots: a pill
      //    exists for exactly the layers that are ON, and its swatch is a
      //    colour THE MAP ACTUALLY PAINTS. The second is asserted against the
      //    drawn overlay rather than against the probe — a legend that agrees
      //    with a constant it shares with nothing is no legend at all.
      {
        await page.evaluate(() => {
          window.__ml.mapLayers("zones", true);
          window.__ml.mapLayers("dungeons", true);
        });
        await page.waitForTimeout(400);
        const legend = await page.evaluate(() => {
          // normalise every colour through the engine, so an rgba() attribute
          // and a computed rgb() string can be compared at all
          const norm = (c) => {
            const d = document.createElement("div");
            d.style.color = c;
            document.body.appendChild(d);
            const out = getComputedStyle(d).color;
            d.remove();
            return out;
          };
          const row = document.querySelector(".ml-maplayers");
          const pills = [...row.querySelectorAll(".ml-maplayer-pill")].map((p) => {
            const sw = p.querySelector(".ml-maplayer-sw");
            const cs = sw && getComputedStyle(sw);
            return {
              id: p.dataset.layer,
              label: p.textContent.trim(),
              swatch: cs ? norm(cs.backgroundColor) : null,
              pinShape: !!sw && sw.classList.contains("pin"),
              hint: p.getAttribute("aria-label") || "",
            };
          });
          // every colour the overlay is painting right now
          const painted = new Set();
          for (const el of document.querySelectorAll(".ml-maplayer-svg path"))
            for (const a of ["fill", "stroke"]) {
              const v = el.getAttribute(a);
              if (v && v !== "none") painted.add(norm(v));
            }
          const pin = document.querySelector(".ml-maplayer-marks b.pin s");
          if (pin) painted.add(norm(getComputedStyle(pin).backgroundColor));
          return { pills, painted: [...painted], on: window.__ml.mapLayers() };
        });
        const ids = legend.pills.map((p) => p.id);
        ids.includes("zones") && ids.includes("dungeons")
          ? ok(`a pill per layer that is on (${ids.join(", ")})`)
          : fail(`pills ${JSON.stringify(ids)} for layers on ${JSON.stringify(legend.on)}`);
        legend.pills.every((p) => legend.on.includes(p.id))
          ? ok("…and no pill for a layer that is off — the whole point of the chooser")
          : fail(`a pill without its layer: ${JSON.stringify(legend.pills.map((p) => p.id))} vs ${JSON.stringify(legend.on)}`);
        // ANTI-DRIFT: the swatch is a colour the map is painting, not a guess
        const orphan = legend.pills.filter((p) => !legend.painted.includes(p.swatch));
        orphan.length === 0
          ? ok(`every swatch is a colour the overlay actually paints (${legend.pills.map((p) => `${p.id} ${p.swatch}`).join(", ")})`)
          : fail(`the legend claims a colour the map does not paint: ${JSON.stringify(orphan)} — painted ${JSON.stringify(legend.painted)}`);
        // the SHAPE is part of the answer: the dungeons layer draws diamonds
        const dung = legend.pills.find((p) => p.id === "dungeons");
        dung && dung.pinShape
          ? ok("the dungeons swatch is the pin's diamond, not a square — shape is what separates two layers of one hue")
          : fail(`the dungeons pill's swatch shape: ${JSON.stringify(dung)}`);
        legend.pills.every((p) => /^hide /.test(p.hint))
          ? ok("each pill says it is its layer's off switch")
          : fail(`a pill with no hint: ${JSON.stringify(legend.pills.map((p) => p.hint))}`);
        // pressing the pill is the way out of a layer
        await page.evaluate(() => document.querySelector('.ml-maplayer-pill[data-layer="dungeons"]').click());
        await page.waitForTimeout(250);
        const after = await page.evaluate(() => ({
          on: window.__ml.mapLayers(),
          pills: [...document.querySelectorAll(".ml-maplayer-pill")].map((p) => p.dataset.layer),
          btn: document.querySelector(".ml-maplayers .ml-plate-btn").textContent.trim(),
        }));
        !after.on.includes("dungeons") && !after.pills.includes("dungeons")
          ? ok(`pressing a pill turns its layer off and takes the pill with it (button now "${after.btn}")`)
          : fail(`after pressing the dungeons pill: ${JSON.stringify(after)}`);
        // …and put it back: the level-aware pin check further down needs this
        // layer drawing. A gate that leaves state behind fails its neighbour.
        await page.evaluate(() => window.__ml.mapLayers("dungeons", true));
        await page.waitForTimeout(250);
      }

      // ── SECTIONS LIKE SETTINGS' (maintainer 2026-09-19: "You can have
      //    sections in the dialog similar to the sections under settings").
      //    The rule above the heading IS the Settings recipe (.ml-amb-title),
      //    so it is compared against that element rather than to a literal —
      //    restyle Settings and this follows or fails loudly. ──
      {
        await page.evaluate(() => document.querySelector(".ml-maplayers .ml-plate-btn").click());
        await page.waitForTimeout(150);
        const sect = await page.evaluate(() => {
          const heads = [...document.querySelectorAll(".ml-layers-h")];
          const cs = (e) => {
            const g = getComputedStyle(e);
            return { border: g.borderTopWidth, style: g.borderTopStyle, transform: g.textTransform, weight: g.fontWeight, tracking: g.letterSpacing };
          };
          const settings = document.querySelector(".ml-amb-title");
          return {
            heads: heads.map(cs),
            names: heads.map((h) => h.querySelector("span").textContent.trim()),
            settings: settings ? cs(settings) : null,
            swatches: [...document.querySelectorAll(".ml-layers [data-layer] .ml-maplayer-sw")].length,
            rows: [...document.querySelectorAll(".ml-layers [data-layer]")].length,
          };
        });
        if (!sect.settings) fail("no .ml-amb-title in Settings to copy the section recipe from");
        else if (!sect.heads.length) fail("the chooser has no section headings");
        else {
          const later = sect.heads.slice(1);
          sect.heads[0].border === "0px"
            ? ok("the first section has no rule above it — the card's own edge is the divider")
            : fail(`the first section draws a ${sect.heads[0].border} rule under the card edge`);
          later.every((h) => h.border === sect.settings.border && h.style === sect.settings.style)
            ? ok(`every later section wears Settings' own divider (${sect.settings.border} ${sect.settings.style}; sections: ${sect.names.join(" / ")})`)
            : fail(`section dividers ${JSON.stringify(later)} vs Settings' ${JSON.stringify(sect.settings)}`);
          sect.heads.every((h) => h.transform === sect.settings.transform && h.weight === sect.settings.weight && h.tracking === sect.settings.tracking)
            ? ok(`…and its lettering (${sect.settings.transform}, ${sect.settings.weight}, ${sect.settings.tracking})`)
            : fail(`section lettering ${JSON.stringify(sect.heads)} vs Settings' ${JSON.stringify(sect.settings)}`);
          sect.swatches === sect.rows && sect.rows > 0
            ? ok(`every row in the chooser carries its layer's swatch (${sect.swatches}/${sect.rows}) — pick by colour, read it off the map`)
            : fail(`${sect.swatches} swatches for ${sect.rows} rows`);
        }
        await page.screenshot({ path: `${OUT}/map-layers-sections.png` });
        await page.evaluate(() => document.querySelector(".ml-layers-done")?.click());
      }

      const inked = pins.filter((p) => p.text);
      inked.length
        ? fail(`${inked.length} dungeon pin(s) print their name on the map (${inked.map((p) => p.name).join(", ")}) — the icon is the whole mark`)
        : ok(`no pin prints text over the map (${pins.length} pins)`);
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
