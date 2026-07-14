import { readFileSync } from "node:fs";
const w = JSON.parse(readFileSync("/home/user/pixel/maps/world/world.json", "utf8"));
const grid = w.grid ?? w.cells ?? w;
console.log("keys:", Object.keys(w).slice(0, 10), "w x h:", w.width, w.height);
const get = (c, r) => (w.grid ? w.grid[r][c] : null);
// sample cells in the dark-blue region near volcano view (camera at 453,386; dark area is up-left = lower col+row)
for (const [c, r] of [[440, 370], [445, 372], [435, 365], [453, 386], [455, 390], [430, 360], [420, 375]]) {
  console.log(c, r, JSON.stringify(get(c, r)));
}
