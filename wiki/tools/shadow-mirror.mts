// Prints the GAME's own shadow-ellipse decomposition for a table of cases, so
// check-shadow.mjs can hold the wiki's JS implementation and the game's shared
// TS implementation (games2/shared/src/index.ts shadowScreenEllipse) equal.
// Run via the game's own toolchain:  npx tsx wiki/tools/shadow-mirror.mts
import { shadowScreenEllipse, shadowBodyRadius, ISO_DX, ISO_DY, DIRECTIONS } from "../../games2/shared/src/index";

const cases: Array<[number, number]> = [[25.5, 10], [10, 30], [40, 40], [8, 5]];
const out: Record<string, unknown> = { iso: { dx: ISO_DX, dy: ISO_DY } };
for (const [rx, ry] of cases) {
  for (const dir of DIRECTIONS) {
    const e = shadowScreenEllipse(rx, ry, dir);
    out[`${rx}x${ry}:${dir}`] = { p: +e.p.toFixed(4), q: +e.q.toFixed(4), theta: +e.theta.toFixed(4) };
  }
  out[`${rx}x${ry}:radius`] = +shadowBodyRadius(rx, ry).toFixed(4);
}
console.log(JSON.stringify(out));
