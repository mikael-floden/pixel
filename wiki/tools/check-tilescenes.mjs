#!/usr/bin/env node
// The tile page's five composition scenes must actually COMPOSE.
//
//     node wiki/tools/check-tilescenes.mjs        (needs the game server running)
//
// "On clean ground" and the two wall scenes draw this tile against the clean
// BASE tile, whose path comes from the committed wiki/clean_base.json snapshot.
// When tiles2 flipped to WebP that snapshot still said .png, so the base cells
// silently drew nothing: the scenes rendered a single lonely tile and nobody
// noticed for a day, because the game server was quietly rescuing .png →
// .webp (maintainer reported it the hour that middleware was deleted).
//
// So this measures PAINTED PIXELS per scene rather than trusting that an image
// resolved: a scene of nine tiles must contain visibly more than a scene of
// one, and no request may 404.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");

const ORIGIN = process.env.WIKI_URL ?? "http://127.0.0.1:8902";
const W = `${ORIGIN}/assets/wiki/site/index.html`;
const D = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await (await b.newContext({ viewport: { width: 426, height: 851 }, deviceScaleFactor: 2 })).newPage();
const bad = []; p.on("response", (r) => { if (!r.ok() && /\.(png|webp)(\?|$)/.test(r.url())) bad.push([r.url().split("/assets/")[1], r.status()]); });
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));

const look = async (typeId, rel) => {
  await p.goto(`${W}#/tiles/${typeId}/${encodeURIComponent(rel)}`, { waitUntil: "load" });
  await p.waitForTimeout(2200);
  return p.evaluate(() => ({
    pills: [...document.querySelectorAll(".pill")].map((x) => x.textContent),
    scenes: [...document.querySelectorAll(".stage-cell")].map((c) => {
      const cv = c.querySelector("canvas");
      if (!cv) return { scene: c.dataset.scene, opaque: 0 };
      const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
      return { scene: c.dataset.scene, opaque: n };
    }),
  }));
};

for (const t of D.domains.tiles) {
  const rels = t.groups.flatMap((g) => g.tiles.map((f) => `${g.dir}/${f}`));
  const plain = t.cleanBase?.plain;
  // The interesting tile is one that is NOT the clean base: only there do the
  // clean-base cells differ from the tile itself, so only there can a broken
  // base path hide.
  const other = rels.find((r) => r !== plain) ?? rels[0];
  const r = await look(t.id, other);
  const by = Object.fromEntries(r.scenes.map((s) => [s.scene, s.opaque]));
  const single = by["1"] / 9;                       // "tiled with itself" = 9 cells
  console.log(`${t.id} · ${other.split("/").pop()} — clean-ground ${by["0"]}, self ${by["1"]}, cliff ${by["2"]}, walls ${by["3"]}/${by["4"]}`);
  ok(by["0"] > single * 4, `${t.id}: "On clean ground" is a FIELD, not one tile (${by["0"]} px vs ${Math.round(single)} for a single)`);
  ok(by["3"] > single * 4 && by["4"] > single * 4, `${t.id}: both wall faces are built (${by["3"]}, ${by["4"]})`);
  ok(by["2"] > single * 4, `${t.id}: the cliff is stacked (${by["2"]})`);
  // The clean-base PILL is the other half of the same snapshot: it is drawn by
  // matching this tile against clean_base.json's lists, so a stale snapshot
  // drops it silently. Check it on the tile that must have it — the plain one.
  if (plain) {
    const pr = await look(t.id, plain);
    ok(pr.pills.some((x) => !/used|unused/.test(x)),
      `${t.id}: the clean-base tile is badged as one (${JSON.stringify(pr.pills)})`);
  }
}

console.log("image 404s:", bad.length ? bad.slice(0, 6) : "none");
ok(bad.length === 0, "no tile image 404s");
console.log("page errors:", errs.length ? errs : "none");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL TILE-SCENE CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
