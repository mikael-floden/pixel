// Inspect terrain cells around the crystal pillar (263,226) to sanity-check routes.
import { readFileSync } from "node:fs";
import { parseWorld, SURFACES } from "../shared/src/index.ts";

const world = parseWorld(JSON.parse(readFileSync(new URL("../../../maps/world/world.json", import.meta.url), "utf8")));
for (let row = 223; row <= 229; row++) {
  let line = `row ${row}: `;
  for (let col = 259; col <= 266; col++) {
    const c = world.rows[row][col];
    const surf = SURFACES[c.t];
    const solid = surf && !surf.standable && !surf.swimmable ? "SOLID" : "";
    line += `(${col}:${c.t}/l${c.l}${solid ? "/" + solid : ""}) `;
  }
  console.log(line);
}
