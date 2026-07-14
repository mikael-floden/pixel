// Crop + nearest-neighbour upscale a PNG region using pngjs.
import fs from "fs";
import { PNG } from "pngjs";
const [,, src, dst, xs, ys, ws, hs, zs] = process.argv;
const x0 = +xs, y0 = +ys, w = +ws, h = +hs, z = +(zs ?? 2);
const png = PNG.sync.read(fs.readFileSync(src));
const out = new PNG({ width: w * z, height: h * z });
for (let y = 0; y < h * z; y++) {
  for (let x = 0; x < w * z; x++) {
    const sx = Math.min(png.width - 1, x0 + Math.floor(x / z));
    const sy = Math.min(png.height - 1, y0 + Math.floor(y / z));
    const si = (sy * png.width + sx) * 4, di = (y * out.width + x) * 4;
    out.data[di] = png.data[si]; out.data[di+1] = png.data[si+1];
    out.data[di+2] = png.data[si+2]; out.data[di+3] = png.data[si+3];
  }
}
fs.writeFileSync(dst, PNG.sync.write(out));
console.log("wrote", dst, out.width, "x", out.height);
