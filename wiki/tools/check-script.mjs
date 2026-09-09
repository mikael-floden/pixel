// DOES wiki.js STILL PARSE AS A CLASSIC SCRIPT?
//
// index.html loads it with a plain <script src="wiki.js"></script>. One module
// keyword — `export`, `import` at top level — is a SyntaxError that stops the
// WHOLE file, so no wiki code runs at all and the page hangs on its boot
// overlay. That shipped on 2026-09-06: an `export` added in passing by the
// audio restructure took the wiki down for every visitor, player and Game
// Master alike, and the only symptom was "GATHERING THE WORLD…" forever.
//
// `node --check` does NOT catch it — Node 22 sees the export, decides the file
// is a module and parses it happily. The browser has no such freedom: the
// <script> tag already said classic. `new Function(src)` compiles it under
// exactly those rules, which is why this is the check and not the shorter one.
import { readFileSync } from "node:fs";
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : [new URL("../site/wiki.js", import.meta.url).pathname];
let bad = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  try {
    new Function(src);                     // classic-script rules, no execution
    console.log(`  ok: ${f} parses as a classic script (${(src.length / 1024).toFixed(0)} KB)`);
  } catch (e) {
    bad++;
    const m = /(\d+)\n(.*)/.exec(String(e.stack ?? ""));
    console.log(`  FAIL: ${f} does NOT parse — the page will hang on its boot overlay`);
    console.log(`        ${String(e.message)}${m ? `\n        line ${m[1]}: ${m[2].trim()}` : ""}`);
  }
}
console.log(bad ? "\nSCRIPT CHECK FAILED" : "\nALL SCRIPT CHECKS PASSED");
process.exit(bad ? 1 : 0);
