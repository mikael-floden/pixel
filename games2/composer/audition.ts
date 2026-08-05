/**
 * /#foley — the composer's AUDITION PAGE, mounted instead of the game.
 *
 * Round 3 lesson: the composer can measure (tonality, tail, crest) but
 * cannot HEAR material realism — after two blind iterations the maintainer
 * was still unhappy. This page closes the loop with human ears at minimal
 * cost: every generated candidate (the whole pool, best-ranked first, the
 * auto-shipped takes marked) is playable on the real deploy. The
 * maintainer listens, then tells the composer e.g. "grass: cand 3 and 7,
 * ui_confirm: cand 2" — the composer promotes those files to the live
 * takes. Selection by ear, promotion by agent.
 */

import { composerFoleyPools, composerFoleyTakes } from "./engine/foley";

export function mountFoleyAudition(): void {
  document.title = "Nangijala — foley audition";
  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;inset:0;overflow:auto;background:#14141c;color:#e8e8ee;" +
    "font:14px/1.5 system-ui,sans-serif;padding:24px;z-index:1000";
  const h = document.createElement("h1");
  h.textContent = "Composer foley audition";
  h.style.cssText = "font-size:20px;margin:0 0 4px";
  const sub = document.createElement("p");
  sub.textContent =
    "Every generated candidate per set, best-ranked first. ★ = currently shipped in the game. " +
    "Listen, then tell the composer which candidates to promote (e.g. “grass: cand 3 + 7”).";
  sub.style.cssText = "color:#9aa0b4;margin:0 0 20px";
  root.append(h, sub);

  const takes = composerFoleyTakes();
  const pools = composerFoleyPools();
  const sets = [...new Set([...takes.keys(), ...pools.keys()])].sort();
  if (sets.length === 0) {
    const none = document.createElement("p");
    none.textContent = "No composer foley bundled in this build yet.";
    root.appendChild(none);
  }
  for (const set of sets) {
    const sec = document.createElement("section");
    sec.style.cssText = "margin:0 0 18px;padding:12px;background:#1c1c28;border-radius:10px";
    const title = document.createElement("h2");
    title.textContent = set;
    title.style.cssText = "font-size:16px;margin:0 0 8px;color:#ffd678";
    sec.appendChild(title);

    const row = (label: string, url: string, shipped: boolean) => {
      const div = document.createElement("div");
      div.style.cssText = "display:flex;align-items:center;gap:10px;margin:4px 0";
      const tag = document.createElement("span");
      tag.textContent = (shipped ? "★ " : "") + label;
      tag.style.cssText = `min-width:220px;font-family:monospace;font-size:12px;${shipped ? "color:#ffd678" : "color:#c5cadb"}`;
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "none";
      audio.src = url;
      audio.style.height = "28px";
      div.append(tag, audio);
      return div;
    };

    // Shipped takes first, then the full pool.
    for (const t of takes.get(set) ?? []) sec.appendChild(row(t.name, t.url, true));
    const pool = pools.get(set) ?? [];
    if (pool.length) {
      const pl = document.createElement("div");
      pl.style.cssText = "margin-top:8px;padding-top:8px;border-top:1px solid #2c2c3c";
      for (const c of pool) pl.appendChild(row(c.name, c.url, false));
      sec.appendChild(pl);
    }
    root.appendChild(sec);
  }
  document.body.appendChild(root);
}
