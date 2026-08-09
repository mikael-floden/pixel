// Two test FILES must never listen on the same port.
//
// node:test runs each test file in its OWN process and runs several of those
// processes CONCURRENTLY (one per core). So two files that pick the same port
// are not merely untidy — they race to bind it, and the loser waits forever.
// There is no failure, no error output, no timeout: the run simply stops.
//
// This is not hypothetical. A new test file took a port timeofday.test.ts
// already used; the CI test job then hung for THREE HOURS before GitHub killed
// it, the deploy job timed out waiting on it, and main stopped going live for a
// day — for a one-digit collision that every local `--test-concurrency=1` run
// happily passed. The files even carried "unique per test file" comments; what
// was missing was something that CHECKS.
//
// Ports within ONE file may repeat freely (that file is one process, and its
// tests are sequential), so this only compares ACROSS files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

test("no two test files claim the same port", () => {
  const SELF = "ports.test.ts"; // this file only TALKS about ports; scanning it matches its own prose
  const owners = new Map<number, Set<string>>();
  for (const f of readdirSync(HERE).filter((n) => n.endsWith(".test.ts") && n !== SELF)) {
    const src = readFileSync(join(HERE, f), "utf8");
    // Matches the convention every server test uses: a `port` const assigned a
    // literal. A file that allocates dynamically (live.test.ts reads the
    // assigned port off the listening socket) has no literal and is correctly
    // ignored — that is the technique to prefer for anything new.
    for (const m of src.matchAll(/const\s+port\s*=\s*(\d{2,5})\s*;/g)) {
      const p = Number(m[1]);
      if (!owners.has(p)) owners.set(p, new Set());
      owners.get(p)!.add(f);
    }
  }

  const clashes = [...owners.entries()]
    .filter(([, files]) => files.size > 1)
    .map(([p, files]) => `  port ${p}: ${[...files].sort().join(", ")}`);

  assert.equal(
    clashes.length,
    0,
    `test files sharing a port will DEADLOCK the parallel run:\n${clashes.join("\n")}\n` +
      `Pick a port no other file uses, or bind port 0 and read it back.`,
  );

  // Guard the guard: if the convention is ever reworded, this test would
  // silently pass while checking nothing.
  assert.ok(owners.size >= 10, `only found ${owners.size} port literals — has the convention changed?`);
});
