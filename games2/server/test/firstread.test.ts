// THE FIRST READ HAS A BUDGET (maintainer 2026-09-24): the law files Claude
// Code loads into every turn, the protocol, every board, every inbox and every
// domain README are size-gated by coordination/check_firstread.py — the inbox
// alone was 314 KB for the games agent before requests had a lifecycle. This
// runs the gate in the suite so a push that grows the first read is red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GATE = join(ROOT, "coordination", "check_firstread.py");

test("the first read stays within its budget (coordination/check_firstread.py)", { skip: !existsSync(GATE) && "no coordination/ in this checkout" }, () => {
  const py = spawnSync("python3", ["--version"]);
  if (py.error) return; // no python here: the gate runs where there is one (CI has it)
  const r = spawnSync("python3", [GATE], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, `first read over budget:\n${r.stdout}\n${r.stderr}`);
});
