// The Music page must list EVERY track written for the game — the music
// agent's and the composer's own beds (maintainer 2026-08-06: "he did 5 new
// songs and you are listing nothing but the old 2").
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
import { readFileSync, existsSync } from "node:fs";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const D = JSON.parse(readFileSync(`${ROOT}/wiki/site/data.json`, "utf8"));
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
const p = await (await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const bad = []; p.on("response", (r) => { if (!r.ok() && /\.(ogg|m4a|mp3|wav)/.test(r.url())) bad.push([r.url().split("/").pop(), r.status()]); });
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };

// ---------- data: both sources, and every file exists on disk
const comp = JSON.parse(readFileSync(`${ROOT}/games2/composer/music/tracks.json`, "utf8")).tracks;
const beds = D.domains.music.filter((t) => t.source === "composer");
const tracks = D.domains.music.filter((t) => t.source !== "composer");
console.log(`data: ${tracks.length} music-domain tracks + ${beds.length} composer beds`);
ok(beds.length === Object.keys(comp).length, `every composer track is listed (${beds.length}/${Object.keys(comp).length})`);
ok(tracks.length >= 2, `the music agent's tracks are still there (${tracks.length})`);
const newOnes = ["battle", "cave", "home", "town", "adventure"];
ok(newOnes.every((id) => beds.some((t) => t.id === id)), `the five new songs are all present (${newOnes.join(", ")})`);
const missing = beds.flatMap((t) => Object.values(t.files)).filter((f) => !existsSync(`${ROOT}/games2/${f}`));
ok(missing.length === 0, `every bed's audio exists on disk (${missing.join(", ") || "all present"})`);
ok(beds.every((t) => t.duration_s > 60 && t.bpm > 0 && t.key), "each carries its measured length, tempo and key");

// ---------- the page
await p.goto(W + "#/music", { waitUntil: "load" });
await p.waitForTimeout(2000);
const page = await p.evaluate(() => {
  const panels = [...document.querySelectorAll(".panel")];
  const heads = [...document.querySelectorAll("h2")].map((x) => x.textContent.replace(/\s+/g, " ").trim());
  return {
    panels: panels.length,
    heads,
    titles: panels.map((x) => x.querySelector(".panel-title")?.childNodes[0]?.textContent?.trim()),
    routed: panels.filter((x) => [...x.querySelectorAll(".pill")].some((y) => y.textContent === "not routed yet")).length,
    inGame: panels.filter((x) => [...x.querySelectorAll(".pill")].some((y) => y.textContent === "in game")).length,
  };
});
console.log("page:", JSON.stringify(page));
ok(page.panels === D.domains.music.length, `every track has a panel (${page.panels}/${D.domains.music.length})`);
ok(page.heads.some((t) => /^Tracks/.test(t)) && page.heads.some((t) => /^Situation beds/.test(t)),
  `the two sources are separate sections (${page.heads.join(" | ")})`);
ok(newOnes.every((id) => page.titles.some((t) => t?.toLowerCase() === id)), "the new songs are on the page by name");
// Counted from the DATA, not typed in. It was 5 when this was written; the
// composer then shipped 8 more beds with a blank `use` line (cave2/3/4,
// battle_day, battle_night, summit_vista/wind/triumph) and a hardcoded 5 turned
// a games-audio backlog item into a red wiki gate. What this check is actually
// for is that the page TELLS you which beds nothing plays — so it asserts the
// page agrees with the data, whatever that number is today.
const unrouted = beds.filter((t) => !t.routed).length;
ok(page.routed === unrouted, `every bed nothing routes says so, ${unrouted} of ${beds.length} (page shows ${page.routed})`);
ok(page.inGame === 2, `and the two the game plays today are chipped "in game" (${page.inGame})`);

// ---------- they actually PLAY (the whole point)
const played = await p.evaluate(async () => {
  const panel = [...document.querySelectorAll(".panel")].find((x) => x.querySelector(".panel-title").textContent.startsWith("Battle"));
  const btn = panel.querySelector(".play-btn");
  btn.click();
  await new Promise((r) => setTimeout(r, 1500));
  const a = document.querySelector("#shared-audio");
  return { src: a.src.split("/").slice(-3).join("/"), playing: !a.paused, t: a.currentTime, err: a.error?.code ?? null,
    label: btn.textContent };
});
console.log("playback:", JSON.stringify(played));
ok(/composer\/music\/battle\./.test(played.src), `Battle streams from the composer's own folder (${played.src})`);
ok(played.err === null && played.playing && played.t > 0.1, `and it is really playing (t=${played.t?.toFixed(2)}s)`);
ok(played.label === "⏸", "the button shows it is playing");

// stopping works, and a second track takes over cleanly
const second = await p.evaluate(async () => {
  const panels = [...document.querySelectorAll(".panel")];
  panels.find((x) => x.querySelector(".panel-title").textContent.startsWith("Cave")).querySelector(".play-btn").click();
  await new Promise((r) => setTimeout(r, 900));
  const a = document.querySelector("#shared-audio");
  return { src: a.src.split("/").pop(), playing: !a.paused,
    pauseLabels: panels.map((x) => x.querySelector(".play-btn").textContent).filter((t) => t === "⏸").length };
});
console.log("second:", JSON.stringify(second));
ok(/^cave\./.test(second.src) && second.playing, `switching to Cave plays it (${second.src})`);
ok(second.pauseLabels === 1, "only one track shows as playing at a time");

console.log("audio 404s:", bad.length ? bad : "none");
ok(bad.length === 0, "no audio 404s");
console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL MUSIC CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
