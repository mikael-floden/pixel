// GLSL pow() NEVER SEES A BASE THAT CAN BE NEGATIVE (docs/lighting.md). The
// spec leaves pow(x, y) undefined for x < 0, and real GPUs take it at its
// word: the light loop squared the sample's height below the light with
// pow((lp.z - z) * 0.6, 2.0), which is a negative base for every wall pixel
// ABOVE the light — the desktop/SwiftShader harness returns the square and
// shows nothing, his phone returned NaN/0 and cut every point light off in a
// hard line at exactly the light's own height, torch lower than brazier
// (maintainer 2026-09-17, the ice cave at 207.4,206.4: "the shadow from the
// spotlight (the fire) can only cast a shadow on walls 2 levels above
// itself"). This reads the fragment sources off the client file and holds
// that every pow() base is wrapped in clamp/abs/max, or is a literal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "src", "nightlight.ts"), "utf8");

/** Every `pow(` call that is GLSL (not Math.pow, not inside a comment) with its first argument. */
function glslPows(text: string): { line: number; base: string }[] {
  const out: { line: number; base: string }[] = [];
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    const code = l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    let at = 0;
    for (;;) {
      const k = code.indexOf("pow(", at);
      if (k < 0) break;
      at = k + 4;
      if (code.slice(Math.max(0, k - 5), k).endsWith("Math.")) continue;
      // Skip a `pow(` inside a block comment's prose: the line must look like code.
      if (/^\s*\*/.test(code)) continue;
      // The first argument: balance parentheses up to the top-level comma.
      let depth = 0;
      let j = at;
      for (; j < code.length; j++) {
        const ch = code[j];
        if (ch === "(") depth++;
        else if (ch === ")") { if (depth === 0) break; depth--; }
        else if (ch === "," && depth === 0) break;
      }
      out.push({ line: i + 1, base: code.slice(at, j).trim() });
    }
  });
  return out;
}

test("every GLSL pow() in the night shaders has a base that cannot go negative", () => {
  const pows = glslPows(src);
  assert.ok(pows.length >= 1, "the shader's pow() calls were not found — the scan is broken");
  const bad = pows.filter((p) => !/^(clamp|abs|max|smoothstep|step)\(/.test(p.base) && !/^[0-9.]+$/.test(p.base));
  assert.deepEqual(bad, [], `pow() with a base that can be negative (undefined on a GPU): ${bad.map((b) => `line ${b.line}: pow(${b.base}, …)`).join("; ")}`);
});
