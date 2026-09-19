// THE FILE THE REPORTS LAND IN — perfDocMerge, the merge that must never
// reset the history and must keep the file where one contents-API GET serves
// it. On 2026-09-13 the file passed 1 MB, the GET answered with no content, and
// the handler rewrote it with the one report in hand: every earlier report was
// gone in one commit. These tests are that trap, made a gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { perfDocMerge } from "../src/perfreport.js";

const AT = "2026-09-19T21:00:00.000Z";
const rep = (i: number, pad = 0) => ({ id: `r${i}`, at: AT, frames: { n: i }, pad: "x".repeat(pad) });

test("a report is appended after the ones already there, newest last", () => {
  const cur = { format: "nangijala-client-perf@1", reports: [rep(1), rep(2)] };
  const { doc, dropped } = perfDocMerge(cur, rep(3), AT);
  assert.deepEqual(doc.reports.map((r) => (r as { id: string }).id), ["r1", "r2", "r3"]);
  assert.equal(dropped, 0);
  assert.equal(doc.updated_at, AT);
  assert.equal(doc.format, "nangijala-client-perf@1");
});

test("an unreadable or missing base is an EMPTY history, never a crash — and a 404 starts the file", () => {
  for (const cur of [null, undefined, {}, { reports: "junk" }, "text"]) {
    const { doc } = perfDocMerge(cur, rep(1), AT);
    assert.equal(doc.reports.length, 1);
  }
});

test("past `keep` reports the oldest go, one per new report", () => {
  const cur = { reports: Array.from({ length: 40 }, (_, i) => rep(i)) };
  const { doc, dropped } = perfDocMerge(cur, rep(40), AT, 40);
  assert.equal(doc.reports.length, 40);
  assert.equal((doc.reports[0] as { id: string }).id, "r1");
  assert.equal((doc.reports[39] as { id: string }).id, "r40");
  assert.equal(dropped, 1);
});

test("THE BYTE CAP: the file stays under it by dropping the OLDEST, never by dropping the new report", () => {
  // 30 reports of ~10 KB = ~300 KB; cap at 120 KB keeps the newest ~11.
  const cur = { reports: Array.from({ length: 30 }, (_, i) => rep(i, 10_000)) };
  const { doc, text, dropped } = perfDocMerge(cur, rep(30, 10_000), AT, 40, 120_000);
  assert.ok(text.length <= 120_000, `text is ${text.length} bytes`);
  assert.ok(doc.reports.length >= 10 && doc.reports.length < 31, `${doc.reports.length} reports kept`);
  assert.equal((doc.reports[doc.reports.length - 1] as { id: string }).id, "r30", "the new report is always kept");
  assert.equal(dropped, 31 - doc.reports.length);
  // The 2026-09-13 shape: a file already over the cap when the report arrives shrinks, it is not reset.
  const over = { reports: Array.from({ length: 12 }, (_, i) => rep(i, 10_000)) };
  const again = perfDocMerge(over, rep(12), AT, 40, 60_000);
  assert.ok(again.doc.reports.length > 1, "the history is trimmed, never replaced by the one report in hand");
  assert.ok(again.text.length <= 60_000);
});

test("one report that alone exceeds the cap is still kept — the cap trims, it never empties", () => {
  const { doc, text } = perfDocMerge({ reports: [rep(1, 50)] }, rep(2, 200_000), AT, 40, 1_000);
  assert.equal(doc.reports.length, 1);
  assert.equal((doc.reports[0] as { id: string }).id, "r2");
  assert.ok(text.length > 1_000);
});

test("the text is one report per line and parses back to the same document", () => {
  const { doc, text } = perfDocMerge({ reports: [rep(1)] }, rep(2), AT);
  assert.deepEqual(JSON.parse(text), doc);
  const lines = text.split("\n");
  assert.ok(lines[0].endsWith("\"reports\":["), "the header line ends where the reports begin");
  assert.equal(lines[1], JSON.stringify(rep(1)) + ",");
  assert.equal(lines[2], JSON.stringify(rep(2)));
  assert.equal(lines[3], "]}");
  assert.equal(lines[4], "", "a trailing newline");
  assert.ok(doc._comment.includes("perf-read.mjs"));
});
