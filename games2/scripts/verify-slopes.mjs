// SLOPES, PROVEN HEADLESS WITHOUT SHIPPED ART: a storey-height ramp set is
// routed into the client (the slopes index gains one grass set at elevation 15,
// the feedback doc approves its 16 tiles, the tiles come from RAMP_DIR), and the
// engine must (1) make the lower cell of a one-level grass rise wear it — kind
// "ramp", the taller frame — (2) lift the body's feet gradually along the
// incline while it crosses that cell, and (3) leave a two-level rise a cliff.
// Needs the dev stack (npm run dev). RAMP_DIR defaults to the set
// scripts/verify-slopes.mjs generates itself from the flat grass tile.
import { chromium } from "playwright-core";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = process.env.PORT || "5173";
const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");
const RAMP_DIR = process.env.RAMP_DIR || join(process.env.TMPDIR || "/tmp", "nangijala-ramp-dev");
const SET_DIR = "tiles/slopes/grass/ramp_dev";
const LH = 15;
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };

// THE SYNTHETIC SET: the flat grass tile lifted by the bilinear height over the
// corner mask, a wall painted under the raised front edges, 64x61 frames.
if (!existsSync(join(RAMP_DIR, "post", "tile_15.png"))) {
  mkdirSync(join(RAMP_DIR, "post"), { recursive: true });
  execFileSync("python3", ["-c", `
from PIL import Image
import os
base=Image.open(${JSON.stringify(join(REPO, "tiles/slopes/grass/a14_s01/tile_00.webp"))}).convert('RGBA')
W,H=base.size; LH=${LH}; bp=base.load()
def uv(x,y):
    u=((x+0.5-32)/32+(y+0.5)/14)/2; v=((y+0.5)/14-(x+0.5-32)/32)/2; return u,v
wall=(78,54,36,255)
for mask in range(16):
    nw,ne,sw,se=(mask>>3)&1,(mask>>2)&1,(mask>>1)&1,mask&1
    can=Image.new('RGBA',(W,H+LH),(0,0,0,0)); cp=can.load(); can.paste(base,(0,LH)); lowest={}
    for y in range(0,29):
        for x in range(W):
            u,v=uv(x,y)
            if u<0 or u>1 or v<0 or v>1: continue
            r,g,b,a=bp[x,y]
            if a==0: continue
            h=(1-u)*(1-v)*nw+u*(1-v)*ne+(1-u)*v*sw+u*v*se
            yy=y+LH-round(LH*h); sh=1.0-0.25*h
            cp[x,yy]=(int(r*sh),int(g*(0.9+0.1*h)),int(b*sh),255); lowest[x]=max(lowest.get(x,-1),yy)
    for x in range(W):
        yf=None
        for y in range(28,-1,-1):
            u,v=uv(x,y)
            if 0<=u<=1 and 0<=v<=1: yf=y+LH; break
        if yf is None or x not in lowest: continue
        for yy in range(lowest[x]+1, yf+1):
            if cp[x,yy][3]==0: cp[x,yy]=wall
    can.save(os.path.join(${JSON.stringify(join(RAMP_DIR, "post"))}, 'tile_%02d.png' % mask))
`]);
}
const POST = Array.from({ length: 16 }, (_, i) => `tile_${String(i).padStart(2, "0")}.png`);
const SET = { schema: "tiles3/slopes@1", kind: "slope_set", ground: "grass", boundary_amplitude: 0.14, boundary_seed: 99, elevation: LH, step_slope: 1, n_tiles: 16, complete: true, size: [64, 46 + LH], dir: SET_DIR, post_files: POST, note: "verify-slopes.mjs: a storey-height ramp set the harness routes in" };

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 540, height: 730 } });
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.route("**/api/perf", async (route) => { await route.fulfill({ status: 200, body: "{}" }); });
let routedIndex = 0, routedFeedback = 0, routedTiles = 0;
await page.route("**/tiles/slopes/index.json*", async (route) => {
  const res = await route.fetch(); const doc = await res.json();
  doc.sets = [...(doc.sets ?? []), SET]; routedIndex++;
  await route.fulfill({ response: res, body: JSON.stringify(doc), headers: { ...res.headers(), "content-type": "application/json" } });
});
await page.route("**/live/feedback/tiles.json*", async (route) => {
  const res = await route.fetch(); const doc = await res.json();
  const entries = doc.entries ?? doc;
  for (let i = 0; i < 16; i++) entries[`${SET_DIR}/tile_${String(i).padStart(2, "0")}`] = { status: "approved", rating: 1 };
  routedFeedback++;
  await route.fulfill({ response: res, body: JSON.stringify(doc), headers: { ...res.headers(), "content-type": "application/json" } });
});
await page.route(`**/${SET_DIR}/post/*`, async (route) => {
  const name = route.request().url().split("/").pop().split("?")[0];
  routedTiles++;
  await route.fulfill({ status: 200, contentType: "image/png", body: readFileSync(join(RAMP_DIR, "post", name)) });
});
await page.goto(`http://localhost:${PORT}/#the_game`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 120000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
await page.waitForFunction(() => !document.getElementById("ml-loading"), null, { timeout: 120000 });
await page.evaluate(() => { window.__ml.noAggro?.(true); window.__ml.worldTime?.(1); });
const go = async (col, row) => { await page.evaluate(([c, r]) => window.__ml.teleport(c, r, undefined, true), [col, row]); await page.waitForFunction(() => !window.__ml.relocate().active && !window.__ml.relocate().veil, null, { timeout: 60000 }).catch(() => {}); await page.waitForTimeout(2500); };
const cell = (c, r) => page.evaluate(([c, r]) => window.__ml.t3cell(c, r), [c, r]);
const me = () => page.evaluate(() => { const m = window.__ml.me(); return { col: m.x / 32, row: m.y / 32, elev: m.elev, lift: window.__ml.lift() }; });

// (1) THE CELL WEARS THE RAMP. (292,224) is grass at level 0 whose whole north
// row (290..294, 223) is grass at 1 and whose other neighbours are grass at 0:
// a pure single-edge rise with no material boundary on it (a boundary tile
// takes a cell instead of any slope — see the resolver's wangSurface).
await go(292.5, 224.85); // just inside the ramp cell's south edge: the harness walks at a few frames a second
if (!routedIndex || !routedFeedback) fail(`the routes did not fire (index ${routedIndex}, feedback ${routedFeedback}) — the docs' URLs changed`);
const c1 = await cell(292, 224);
console.log("cell (292,224):", JSON.stringify(c1));
if (!c1 || !c1.slope || !c1.slope.ramp) fail(`(292,224) does not wear a ramp: ${JSON.stringify(c1)}`);
else {
  if (c1.slope.index !== 12) fail(`the ramp's raised edge is not the north edge alone (index ${c1.slope.index}, want 12)`);
  if (c1.art?.kind !== "ramp" || c1.art?.h !== 46 + LH) fail(`the ramp art is not the taller raw frame: ${JSON.stringify(c1.art)}`);
}
await page.waitForTimeout(1500);
if (!routedTiles) fail("no ramp tile was fetched — the pick was made but the art never loaded");
await page.screenshot({ path: join(RAMP_DIR, "ramp-cell.png"), clip: { x: 70, y: 80, width: 400, height: 360 } });

// (2) THE LIFT FOLLOWS THE INCLINE: walk north across the ramp cell; the feet's
// lift must take values strictly between the two storeys while inside it, and
// the body must reach level 1 without a jump.
const seen = [];
await page.keyboard.down("KeyW"); await page.keyboard.down("KeyD");
const t0 = Date.now();
while (Date.now() - t0 < 40000) { await page.waitForTimeout(100); const m = await me(); seen.push(m); if (m.elev >= 1 && m.row < 224) break; }
await page.keyboard.up("KeyW"); await page.keyboard.up("KeyD");
const inside = seen.filter((m) => Math.floor(m.row) === 224 && m.elev === 0);
const mids = inside.filter((m) => typeof m.lift === "number" && m.lift > 2 && m.lift < LH - 2);
const last = seen[seen.length - 1];
console.log(`walk north: ${seen.length} samples, ${inside.length} inside the ramp row, ${mids.length} with a lift strictly between the storeys (${inside.map((m) => m.lift?.toFixed(1)).join(" ")}); ended at ${JSON.stringify(last)}`);
if (!inside.length) fail("the body never crossed the ramp cell (no sample inside it at level 0)");
else if (mids.length < 2) fail("the lift never took values between the two storeys inside the ramp cell — the incline is not followed");
if (!last || last.elev !== 1) fail(`the body did not reach the higher cell without a jump (elev ${last?.elev})`);
await page.screenshot({ path: join(RAMP_DIR, "ramp-top.png"), clip: { x: 70, y: 80, width: 400, height: 360 } });

// (3) A TWO-LEVEL RISE STAYS A CLIFF: (305,176) is grass at 0 with (305,175) at 2
// and flat grass east, west and south.
await go(305.5, 177.5);
const c2 = await cell(305, 176);
console.log("cell (305,176):", JSON.stringify(c2));
if (c2?.slope?.ramp) fail(`(305,176) wears a ramp toward a two-level rise: ${JSON.stringify(c2.slope)}`);
if (c2?.art?.kind === "ramp") fail("a two-level rise draws ramp art");
await page.screenshot({ path: join(RAMP_DIR, "cliff.png"), clip: { x: 70, y: 80, width: 400, height: 360 } });
await browser.close();
console.log(process.exitCode ? "slopes: FAIL" : `slopes: ok — ramp on the one-level rise (index ${c1?.slope?.index}, frame ${c1?.art?.h}), the lift climbed through ${mids.length} intermediate samples, the two-level rise is a cliff`);
