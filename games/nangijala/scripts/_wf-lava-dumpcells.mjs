import fs from "fs";
const w = JSON.parse(fs.readFileSync("/home/user/pixel/maps/world/world.json", "utf8"));
console.log("format:", w.format, "size:", w.width, "x", w.height);
const cats = w.categories;
const W = w.width;
const get = (col, row) => {
  const i = row * W + col;
  return { t: cats[w.terr[i]], v: w.variant[i], l: w.level[i] };
};
for (let row = 216; row <= 228; row++) {
  let line = `row ${row}: `;
  for (let col = 257; col <= 265; col++) {
    const c = get(col, row);
    line += `[${col}:${c.t}/${c.v}/L${c.l}] `;
  }
  console.log(line);
}
