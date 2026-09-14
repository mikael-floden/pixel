// THE LAW FILE HAS A BUDGET, AND A BUDGET NEEDS A GATE.
//
// `games2/CLAUDE.md` is loaded into EVERY turn of SIX agents (games, games-ui,
// games-audio, games-ambient, games-perf and their assistants), so its size is
// paid on every message any of them ever reads — 300 KB was once paid that way
// before the maintainer split it (2026-09-09: "the law file under 20 KB", root
// CLAUDE.md "Doc law"). Nothing measured that line, so it drifted past it
// unnoticed (20,648 bytes on 2026-09-14) — exactly the kind of slow leak a
// human never notices and a test catches on the commit that causes it.
//
// WHEN THIS FAILS, THE FIX IS NEVER TO DELETE A RULE. A rule is one or two
// lines here — the law, the reason in parentheses, the doc with the story —
// and its measurement, its trap's story and its rejected approaches move into
// the `games2/docs/<topic>.md` that already owns the subsystem. Check the
// receipt is really in that doc before you cut it from this one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GAMES2 = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIMIT = 20 * 1024;

test("the law file stays under 20 KB", () => {
  const n = statSync(join(GAMES2, "CLAUDE.md")).size;
  console.log(`  games2/CLAUDE.md: ${n} bytes, ${Math.abs(LIMIT - n)} ${n <= LIMIT ? "under" : "OVER"} the ${LIMIT} line`);
  assert.ok(
    n <= LIMIT,
    `games2/CLAUDE.md is ${n} bytes, ${n - LIMIT} over the ${LIMIT}-byte law-file budget. ` +
      "Move a measurement into the docs/<topic>.md that owns it — never a rule.",
  );
});
