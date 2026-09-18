// A NUMBER INTERPOLATED INTO GLSL IS A FLOAT LITERAL, OR THE SHADER DOES NOT
// COMPILE (docs/lighting.md). `${TOP_UNDER_FREE}` with the constant 1.0 emits
// `1` — an int to GLSL — and smoothstep(-2.50, -1, x) has no overload: the
// whole night pass failed to build ("shader night unavailable"), unseen by
// tsc (2026-09-18, the roof rule). A whole-number constant goes in through
// toFixed(); this reads the client source and holds every bare `${CONST}`
// whose value prints without a dot to that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "src", "nightlight.ts"), "utf8");

test("every whole-number constant interpolated into the shaders is emitted as a float literal", () => {
  const consts = new Map<string, number>();
  for (const m of src.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]*) = (-?\d+(?:\.\d+)?);/gm)) consts.set(m[1], Number(m[2]));
  const bad: string[] = [];
  const lines = src.split("\n");
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) {
      const v = consts.get(m[1]);
      if (v === undefined) continue;
      // Only GLSL lines: skip TypeScript template strings for keys/labels (a line with a GLSL call or operator).
      if (!/[;()]/.test(l)) continue;
      if (/^\s*\/\//.test(l)) continue;
      // An ARRAY SIZE or a LOOP BOUND is an int by nature (uLightPos[N], for (int i ...; i < N)).
      if (new RegExp(`\\[\\$\\{${m[1]}\\}\\]`).test(l) || /for \(int /.test(l)) continue;
      if (!String(v).includes(".")) bad.push(`${m[1]} (= ${v}) at line ${i + 1}: use \${${m[1]}.toFixed(2)}`);
    }
  });
  assert.deepEqual(bad, [], `whole numbers interpolated as GLSL ints:\n${bad.join("\n")}`);
});
