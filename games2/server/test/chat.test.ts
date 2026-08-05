import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeChat, MAX_CHAT_LEN } from "@nangijala/shared";

test("sanitizeChat trims, strips control chars, and clamps length", () => {
  assert.equal(sanitizeChat("  hi there  "), "hi there");
  assert.equal(sanitizeChat("a\nb\tc"), "a b c"); // control chars -> spaces
  assert.equal(sanitizeChat(""), "");
  assert.equal(sanitizeChat(123 as unknown), "");
  assert.equal(sanitizeChat(null as unknown), "");
  const long = "x".repeat(MAX_CHAT_LEN + 50);
  assert.equal(sanitizeChat(long).length, MAX_CHAT_LEN);
});
