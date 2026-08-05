/**
 * /#score — audition the composer's MUSIC BEDS, mounted instead of the game.
 *
 * Same idea as /#foley, one level up: the composer can measure a track
 * (loudness, loop seam, key, tempo) but cannot judge whether it is the RIGHT
 * music for a place. So every generated bed is playable here on the real
 * deploy, with the numbers next to it — the maintainer listens and then says
 * what plays where (2026-08-05: "I wanted to listen to them in the wiki before
 * telling you what to play where").
 *
 * Plain <audio> elements on purpose: this page must work with no game running,
 * no WebAudio unlock and no world loaded, and the browser's own transport gives
 * scrubbing and a position readout for free. The LOOP button is the one thing
 * worth more than a native control — it jumps to the measured loop point so the
 * seam can be judged in a couple of seconds instead of waiting two minutes for
 * the track to reach it.
 */

import { BED_NAMES } from "./engine/bedSelect";
import { bedTrack } from "./engine/contextMusic";

/** What each bed is FOR — so the ear has the intent to judge against. */
const INTENT: Record<string, string> = {
  adventure: "out in the world — the default, heard more than all the others together",
  town: "village, market, farmland — a place with people in it",
  cave: "underground: huge, hushed, awed rather than frightened",
  home: "the spawn bonfire — safe, small, you belong here",
  battle: "monsters on you — urgent but winnable, never grim",
  night: "the overworld after dark (in-world score today)",
  title: "the character-select screen (in-world score today)",
};

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function mountScoreAudition(): void {
  document.title = "Nangijala — score audition";
  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;inset:0;overflow:auto;background:#14141c;color:#e8e8ee;" +
    "font:14px/1.5 system-ui,sans-serif;padding:24px;z-index:1000";

  const h = document.createElement("h1");
  h.textContent = "Composer score audition";
  h.style.cssText = "font-size:20px;margin:0 0 4px";
  const sub = document.createElement("p");
  sub.innerHTML =
    "Every generated music bed, with what it was written for and what it measured. " +
    "<b>Loop</b> jumps to the measured loop point so you can hear the seam without waiting for it.<br>" +
    "Nothing here is routed to the game yet — tell the composer what should play where.";
  sub.style.cssText = "color:#9aa0b4;margin:0 0 20px";
  root.append(h, sub);

  // Beds first (the five new ones), then the two already scoring the game.
  const order = [...BED_NAMES.filter((n) => n !== "night"), "night", "title"];
  let found = 0;

  for (const name of order) {
    const track = bedTrack(name);
    if (!track) continue;
    found++;
    const { url, entry } = track;

    const sec = document.createElement("section");
    sec.style.cssText = "margin:0 0 14px;padding:12px 14px;background:#1c1c28;border-radius:10px";

    const title = document.createElement("h2");
    title.textContent = name;
    title.style.cssText = "font-size:16px;margin:0 0 2px;color:#ffd678;text-transform:capitalize";

    const intent = document.createElement("div");
    intent.textContent = INTENT[name] ?? "";
    intent.style.cssText = "color:#9aa0b4;margin:0 0 8px";

    const loop = entry.loop ?? { loop_start_s: 0, loop_end_s: 0, crossfade_ms: 0, score: 0 };
    const key = entry.musical?.root ? `${entry.musical.root} ${entry.musical.mode}` : "—";
    const facts = document.createElement("div");
    facts.textContent =
      `${fmt(entry.duration_s)} · ${entry.bpm ? `${Math.round(entry.bpm)} BPM` : "—"} · ${key} · ` +
      `loop ${fmt(loop.loop_start_s)}–${fmt(loop.loop_end_s)} (seam ${loop.score.toFixed(2)})`;
    facts.style.cssText = "font-family:monospace;font-size:12px;color:#c5cadb;margin:0 0 8px";

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none"; // a page of 7 beds must not pull ~10 MB on open
    audio.src = url;
    audio.style.cssText = "width:100%;max-width:680px";

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap";

    const btn = (label: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        "background:#2c2c3c;color:#e8e8ee;border:1px solid #3c3c50;border-radius:8px;" +
        "padding:6px 12px;font:13px system-ui,sans-serif;cursor:pointer";
      b.onclick = fn;
      return b;
    };

    // Land a few seconds BEFORE the loop end and let it run through the seam —
    // that is the moment the whole loop-point analysis exists to get right.
    row.append(
      btn("▶ from the top", () => {
        audio.currentTime = 0;
        void audio.play();
      }),
      btn("↻ hear the loop seam", () => {
        audio.currentTime = Math.max(0, loop.loop_end_s - 6);
        void audio.play();
      }),
      btn("■ stop", () => {
        audio.pause();
        audio.currentTime = 0;
      }),
    );

    // Jumping back to loop_start at loop_end is what the ENGINE does; doing it
    // here too means the seam you judge is the seam that would ship.
    audio.addEventListener("timeupdate", () => {
      if (loop.loop_end_s > 0 && audio.currentTime >= loop.loop_end_s)
        audio.currentTime = loop.loop_start_s;
    });

    sec.append(title, intent, facts, audio, row);
    root.appendChild(sec);
  }

  if (!found) {
    const none = document.createElement("p");
    none.textContent = "No composer music bundled in this build yet.";
    root.appendChild(none);
  }
  document.body.appendChild(root);
}
