// Render a visual proof sheet for the manifest foot anchors: for every
// character x direction, draw idle/walk/run frames with a crosshair at the
// per-direction anchor from client/public/characters.json. The vertical line
// is where the drop-shadow centre lands; it should split the gap BETWEEN the
// feet, at mid-foot depth. Output: PNG path given as argv[2] (default
// anchor-proof.png in cwd). Run `npm run manifest` first.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GAME_ROOT = join(SCRIPT_DIR, "..");
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(GAME_ROOT, "..");
const OUT = process.argv[2] || "anchor-proof.png";

const manifest = JSON.parse(readFileSync(join(GAME_ROOT, "client/public/characters.json"), "utf8"));
const STATES = ["idle", "walk", "run"];
const SCALE = 3;
// Crop window (source px) — the feet area plus enough body for context.
const CX0 = 20, CX1 = 92, CY0 = 40, CY1 = 112;
const CW = (CX1 - CX0) * SCALE, CH = (CY1 - CY0) * SCALE, SEP = 2;

const chars = manifest.characters;
const cols = chars.length * STATES.length;
const rows = manifest.directions.length;
const sheet = new PNG({ width: cols * (CW + SEP), height: rows * (CH + SEP) });
sheet.data.fill(30); // dark grey background
for (let i = 3; i < sheet.data.length; i += 4) sheet.data[i] = 255;

const put = (x, y, r, g, b) => {
  if (x < 0 || y < 0 || x >= sheet.width || y >= sheet.height) return;
  const o = (y * sheet.width + x) * 4;
  sheet.data[o] = r; sheet.data[o + 1] = g; sheet.data[o + 2] = b; sheet.data[o + 3] = 255;
};

let col = 0;
for (const c of chars) {
  const animsDir = join(ASSETS_ROOT, "characters2", "humans", c.uid, "animations");
  for (const state of STATES) {
    let row = 0;
    for (const d of manifest.directions) {
      const n = c.animations[state]?.[d] ?? 0;
      const frame = state === "idle" ? 0 : n >> 1; // mid-stride for walk/run
      const p = join(animsDir, c.animSrc[state], d, `${frame}.png`);
      const ox = col * (CW + SEP), oy = row * (CH + SEP);
      if (n && existsSync(p)) {
        const img = PNG.sync.read(readFileSync(p));
        for (let y = CY0; y < CY1; y++)
          for (let x = CX0; x < CX1; x++) {
            const o = (y * img.width + x) * 4;
            if (img.data[o + 3] <= 64) continue;
            for (let dy = 0; dy < SCALE; dy++)
              for (let dx = 0; dx < SCALE; dx++)
                put(ox + (x - CX0) * SCALE + dx, oy + (y - CY0) * SCALE + dy,
                    img.data[o], img.data[o + 1], img.data[o + 2]);
          }
        const a = c.anchors[d];
        if (a) {
          const axp = ox + Math.round((a.x * c.frameW - CX0) * SCALE);
          const ayp = oy + Math.round((a.y * c.frameH - CY0) * SCALE);
          for (let y = oy; y < oy + CH; y++) put(axp, y, 255, 0, 255); // anchor x
          for (let x = axp - 12; x <= axp + 12; x++) put(x, ayp, 0, 255, 255); // sole y
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) put(axp + dx, ayp + dy, 0, 255, 0);
        }
      }
      row++;
    }
    col++;
  }
}
writeFileSync(OUT, PNG.sync.write(sheet));
console.log(`[anchors] proof sheet -> ${OUT} (cols: ${chars.map(c => `${c.uid} idle/walk/run`).join(" | ")}; rows: ${manifest.directions.join(", ")})`);
