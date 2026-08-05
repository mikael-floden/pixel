/* Nangijala game wiki — one page, two audiences.
   PLAYERS browse everything the art/audio agents produce (read-only).
   The ADMIN (game designer) additionally rates, approves/removes and tunes —
   after signing in. All admin writes go through the GAME SERVER's API
   (/api/wiki/*): the server checks the login, holds the GitHub token, commits
   to live/** on main and pushes the change to every connected game client
   over its WebSocket. No GitHub credentials ever live in a browser.
   Vanilla JS, no build step. Data comes from data.json (built by ../build.mjs);
   feedback/tuning come from GET /api/live/state (the server's always-fresh
   copy), with the static /assets/live files as offline fallback. */

"use strict";

// The directory that serves the art domains: /assets/ in the game (prod +
// vite dev), the repo root when served locally — always two levels up.
const ROOT = new URL("../../", location.href);
const assetUrl = (rel) => new URL(rel, ROOT).href;
/** A feedback id is a repo path WITHOUT the extension, which is what lets the
 *  maintainer's verdicts survive the art changing format underneath them (the
 *  fleet's PNG → lossless WebP migration, 2026-07-31). Strip every image
 *  extension, not just .png: the day tiles2 converts, `.png`-only stripping
 *  would rename every id and orphan every star, note and rejection on file. */
const stripExt = (rel) => rel.replace(/\.(png|webp)$/i, "");
// The game server's API (same origin in prod and dev — vite proxies /api).
const API = (path) => new URL(path, location.origin).href;

const FEEDBACK_DOMAINS = ["monsters", "characters", "tiles", "objects", "sounds", "music", "items", "lore", "composer"];
const state = {
  data: null,
  admin: false,          // signed in as the game designer? (server-verified)
  feedback: {},          // domain -> parsed pixel-wiki-feedback@1
  tuning: { monsters: null, constants: null },
  dirty: new Set(),      // "feedback/monsters" | "tuning/monsters" | "tuning/constants"
  // Per file: WHICH ids this session actually edited. Saves send exactly
  // these ids as a delta — the server merges them into the current document,
  // so a stale page can never clobber entries committed earlier.
  touched: {},           // key -> Set(ids)
  knownIds: new Set(),
  query: "",
};
function touch(key, id) {
  (state.touched[key] ?? (state.touched[key] = new Set())).add(id);
}
const adminToken = () => localStorage.getItem("wiki-admin-token") ?? "";

/* ---------------------------------------------------------- tiny helpers */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);
const fmtDur = (s) => {
  if (s == null) return "";
  if (s < 60) return `${s.toFixed(2)}s`;
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
const DIR_LABEL = { south: "S", "south-east": "SE", east: "E", "north-east": "NE", north: "N", "north-west": "NW", west: "W", "south-west": "SW" };
let toastTimer = null;
function toast(msg) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = h("div", { class: "toast" }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3200);
}

/* ------------------------------------------------------------- feedback */
function fb(domain, id) {
  return state.feedback[domain]?.entries?.[id] ?? {};
}
function setFb(domain, id, patch) {
  const f = state.feedback[domain] ?? (state.feedback[domain] = { format: "pixel-wiki-feedback@1", domain, updated_at: "", entries: {} });
  const entry = { ...(f.entries[id] ?? {}), ...patch, updated_at: new Date().toISOString() };
  // Drop cleared fields so "no rating" stays the true default.
  for (const k of ["rating", "status", "note"]) {
    if (entry[k] === null || entry[k] === undefined || entry[k] === "") delete entry[k];
  }
  if (Object.keys(entry).length <= 1) delete f.entries[id];
  else f.entries[id] = entry;
  f.updated_at = new Date().toISOString();
  touch(`feedback/${domain}`, id);
  markDirty(`feedback/${domain}`);
}
function markDirty(key) {
  state.dirty.add(key);
  updateSavebar();
}
function updateSavebar() {
  const bar = $("#savebar");
  if (!state.dirty.size) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  $("#savebar-text").textContent = `${state.dirty.size} file${state.dirty.size > 1 ? "s" : ""} with unsaved changes`;
}

// Every feedback widget has two faces: interactive for the signed-in admin,
// a quiet read-only badge (or nothing) for players.
function starsWidget(domain, id) {
  if (!state.admin) {
    const val = fb(domain, id).rating ?? 0;
    return val ? h("span", { class: "stars ro", "aria-label": `${val} stars` }, "★".repeat(val)) : h("span");
  }
  const wrap = h("span", { class: "stars", role: "radiogroup", "aria-label": "rating" });
  const render = () => {
    const val = fb(domain, id).rating ?? 0;
    wrap.replaceChildren(...[1, 2, 3, 4, 5].map((n) =>
      h("button", {
        class: n <= val ? "lit" : "", title: `${n} star${n > 1 ? "s" : ""}`,
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); setFb(domain, id, { rating: fb(domain, id).rating === n ? null : n }); render(); },
      }, n <= val ? "★" : "☆")));
  };
  render();
  return wrap;
}
function verdictWidget(domain, id, { onchange } = {}) {
  if (!state.admin) {
    const st = fb(domain, id).status;
    if (st === "approved") return h("span", { class: "pill ok" }, "approved");
    if (st === "rejected") return h("span", { class: "pill err" }, "slated for removal");
    return h("span");
  }
  const wrap = h("span", { class: "verdict" });
  const render = () => {
    const st = fb(domain, id).status;
    wrap.replaceChildren(
      h("button", { class: st === "approved" ? "approved" : "", onclick: (e) => { e.stopPropagation(); setFb(domain, id, { status: st === "approved" ? null : "approved" }); render(); onchange?.(); } }, "✓ approve"),
      h("button", { class: st === "rejected" ? "rejected" : "", title: "Reject = the producing agent removes/replaces this on its next run", onclick: (e) => { e.stopPropagation(); setFb(domain, id, { status: st === "rejected" ? null : "rejected" }); render(); onchange?.(); } }, "✕ remove"),
    );
  };
  render();
  return wrap;
}
function noteWidget(domain, id) {
  if (!state.admin) return null;
  const ta = h("textarea", { class: "fb-note", placeholder: "Note for the producing agent (optional)…", rows: "1" });
  ta.value = fb(domain, id).note ?? "";
  ta.addEventListener("change", () => setFb(domain, id, { note: ta.value.trim() || null }));
  return ta;
}
function feedbackRow(domain, id, opts = {}) {
  return h("div", { class: "fb-row" },
    starsWidget(domain, id),
    verdictWidget(domain, id, opts),
    opts.note === false ? null : noteWidget(domain, id));
}

/* ---------------------------------------------- saving (game server API) */
// The browser never talks to GitHub. Saves POST a per-entry DELTA to the
// game server, which merges it into the current document, commits live/**
// to main with ITS OWN token, and pushes the change to every game client.
const FILE_FOR = (key) => key.startsWith("feedback/")
  ? { path: `live/${key}.json`, get: () => state.feedback[key.split("/")[1]] }
  : { path: `live/tuning/${key.split("/")[1]}.json`, get: () => state.tuning[key.split("/")[1]] };

// The current local value of one touched id inside a file (null = deleted).
function valueOf(key, id) {
  const doc = FILE_FOR(key).get() ?? {};
  const bucket = key.startsWith("feedback/") ? doc.entries
    : key === "tuning/monsters" ? doc.monsters
    : key === "tuning/sfx_requests" ? doc.requests
    : doc.overrides;
  const v = bucket?.[id];
  return v === undefined ? null : v;
}
async function apiSaveFile(key) {
  const snapshot = new Set(state.touched[key] ?? []);
  if (!snapshot.size) { state.dirty.delete(key); return; }
  const set = Object.fromEntries([...snapshot].map((id) => [id, valueOf(key, id)]));
  const res = await fetch(API("/api/wiki/save"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken()}` },
    body: JSON.stringify({ file: key, set }),
  });
  if (res.status === 401) {
    // Session expired (server restarts wipe sessions — routine). KEEP the
    // unsaved edits: drop only the dead token; re-login then re-saves them.
    localStorage.removeItem("wiki-admin-token");
    setAdmin(false, { keepEdits: true });
    throw new Error("session expired — sign in again, your edits are kept");
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  // Only forget ids saved in THIS pass so edits made mid-save stay dirty.
  const t = state.touched[key];
  if (t) { for (const id of snapshot) t.delete(id); if (!t.size) delete state.touched[key]; }
  if (!state.touched[key]) state.dirty.delete(key);
}
async function saveAll() {
  if (!state.admin) { $("#login-dialog").showModal(); return; }
  const btn = $("#save-btn");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    for (const key of [...state.dirty]) {
      await apiSaveFile(key);
      updateSavebar();
    }
    toast("Saved — committed to the repo and pushed live to the game.");
    route();
  } catch (err) {
    console.error(err);
    toast(`Save failed: ${err.message}`);
    if (!state.admin) $("#login-dialog").showModal();
  } finally {
    btn.disabled = false; btn.textContent = "Save";
  }
}
function exportAll() {
  for (const key of state.dirty) {
    const { path, get } = FILE_FOR(key);
    const blob = new Blob([JSON.stringify(get(), null, 2) + "\n"], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: path.split("/").pop() });
    document.body.append(a); a.click(); a.remove();
  }
  toast("Exported — commit the files under live/ by hand.");
}
async function discardAll() {
  state.dirty.clear();
  state.touched = {};
  await loadLiveFiles();
  updateSavebar();
  route();
  toast("Discarded unsaved changes.");
}

/* --------------------------------------------------------------- player */
// One animation player: strips (monsters/objects) or per-frame urls
// (characters). Nearest-neighbour scaling, play/pause, frame-step, speed,
// and the game's nadir shadow for monsters.
function makePlayer(entity, kind) {
  const anims = entity.animations;
  const stateNames = Object.keys(anims);
  let cur = {
    state: stateNames.includes("idle") ? "idle" : stateNames[0],
    dir: "south", frame: 0, playing: true, speed: 1, zoom: 0 /* 0 = auto */,
    shadow: kind === "monster",
  };
  const baseFps = 8;
  const canvas = h("canvas", { width: 64, height: 64 });
  const stage = h("div", { class: "player-stage checker" }, canvas);
  // FIXED STAGE (maintainer 2026-07-30): one chessboard size for the whole
  // domain — the widest and tallest pose any of its entities needs — with the
  // creature centred in it. Paging next/next/next then swaps the creature
  // without the layout moving. The CANVAS stays cropped to the sprite, so a
  // rare oversized pose can overflow into the stage's own scroll rather than
  // inflating every page. `max-width:100%` keeps it inside narrow screens.
  const stageKind = kind === "monster" ? "monsters" : kind === "character" ? "characters" : "objects";
  function sizeStage() {
    const box = state.data.artBox?.[stageKind];
    if (!box) return;
    // The stage keeps its DEFAULT size whatever zoom is picked, and only
    // grows when a zoomed sprite genuinely will not fit (maintainer
    // 2026-07-30) — so 1x/2x/4x change the creature, not the layout.
    const base = state.data.artScale || 2;
    const sw = Math.max(box[0] * base, canvas.width);
    const sh = Math.max(box[1] * base, canvas.height);
    stage.style.width = `${sw + 18}px`;   // +18 = padding + border (border-box)
    stage.style.height = `${sh + 18}px`;
  }
  const ctx = canvas.getContext("2d");
  const frameNo = h("span", { class: "frame-no" });
  let img = null, frameImgs = [], clip = null, rafTimer = null, acc = 0, lastT = 0;

  function clipFor() {
    const a = anims[cur.state];
    return a?.dirs?.[cur.dir] ?? null;
  }
  function loadClip() {
    clip = clipFor();
    img = null; frameImgs = [];
    cur.frame = 0;
    if (!clip) { draw(); return; }
    if (clip.strip) {
      img = new Image();
      img.onload = draw;
      img.src = assetUrl(clip.strip);
    } else if (clip.framesDir) {
      frameImgs = Array.from({ length: clip.frames }, (_, i) => {
        const im = new Image();
        im.onload = () => { if (i === 0) draw(); };
        // The builder measured how this domain names its frames — "0.png" or
        // "00.webp". Never assume: the two domains differ.
        im.src = assetUrl(`${clip.framesDir}/${String(i).padStart(clip.framePad ?? 1, "0")}.${clip.frameExt ?? "png"}`);
        return im;
      });
    }
  }
  // ONE scale for every creature (maintainer 2026-07-30). Scaling by FRAME
  // size was really scaling by transparent PADDING: Lava Salamander and Lava
  // Salamander II are the same 30x35 creature but ship 78x48 and 48x48
  // frames, so they rendered 1.67x apart — and the 32x23 frog came out 2.5x
  // wider than the 77x121 mammoth. The padding is cropped away with each
  // clip's measured content box (wiki/tools/art-bounds.py) and everyone
  // draws at data.artScale: same creature = same size, bigger creature =
  // bigger. The crop is PER CLIP, so it stays put while a clip plays and the
  // animation's motion still shows. Zoom buttons override the scale.
  function draw() {
    const fw = clip?.fw ?? entity.frameW ?? 64, fh = clip?.fh ?? entity.frameH ?? 64;
    const bb = clip?.bb ?? [0, 0, fw, fh];   // content box in frame px
    const s = cur.zoom || state.data.artScale || 2;
    const cw = Math.max(1, bb[2] - bb[0]), ch = Math.max(1, bb[3] - bb[1]);
    // A hovering creature (butterfly_dragon) floats hoverPx above the ground,
    // so its shadow sits that much BELOW its foot line.
    const hover = (entity.hoverPx ?? 0) * s;
    const foot = (entity.artBottom ?? 1) * fh;          // ground line, frame px
    const showShadow = cur.shadow && entity.shadow;
    const shadowY = (foot - bb[1]) * s + hover;
    const wantW = Math.ceil(Math.max(cw * s, showShadow ? entity.shadow.w * s + 2 : 0));
    const wantH = Math.ceil(Math.max(ch * s, showShadow ? shadowY + (entity.shadow.h * s) / 2 + 2 : 0));
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW; canvas.height = wantH;
    }
    sizeStage();   // after the canvas is sized — the stage only grows for it
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!clip) { frameNo.textContent = "—"; return; }
    // The frame is drawn shifted so its content box lands centred at y=0 —
    // the padding simply falls outside the canvas.
    const dx = Math.round(canvas.width / 2 - ((bb[0] + bb[2]) / 2) * s);
    const dy = Math.round(-bb[1] * s);
    if (showShadow) {
      // The game's ground ellipse: centred, sitting at the art-measured foot line.
      ctx.fillStyle = "rgba(20,16,8,0.38)";
      ctx.beginPath();
      ctx.ellipse(canvas.width / 2, shadowY, (entity.shadow.w * s) / 2, (entity.shadow.h * s) / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const f = Math.min(cur.frame, clip.frames - 1);
    if (img?.complete && img.naturalWidth) {
      ctx.drawImage(img, f * (img.naturalWidth / clip.frames), 0, img.naturalWidth / clip.frames, img.naturalHeight, dx, dy, fw * s, fh * s);
    } else if (frameImgs[f]?.complete && frameImgs[f].naturalWidth) {
      ctx.drawImage(frameImgs[f], dx, dy, fw * s, fh * s);
    }
    frameNo.textContent = `${f + 1} / ${clip.frames}`;
  }
  function tick(t) {
    rafTimer = requestAnimationFrame(tick);
    if (!cur.playing || !clip) { lastT = t; return; }
    if (!lastT) lastT = t;
    acc += (t - lastT) * cur.speed; lastT = t;
    const ms = 1000 / baseFps;
    while (acc >= ms) { acc -= ms; cur.frame = (cur.frame + 1) % clip.frames; }
    draw();
  }
  rafTimer = requestAnimationFrame(tick);

  const stateSeg = h("span", { class: "seg" });
  // Keep the ACTIVE state visible inside the pannable row — scrollLeft only,
  // never scrollIntoView: that can drag the whole page along with it.
  function revealActiveState() {
    const on = stateSeg.querySelector("button.on");
    if (!on) return;
    const pad = 14;
    if (on.offsetLeft < stateSeg.scrollLeft + pad) stateSeg.scrollLeft = Math.max(0, on.offsetLeft - pad);
    else if (on.offsetLeft + on.offsetWidth > stateSeg.scrollLeft + stateSeg.clientWidth - pad)
      stateSeg.scrollLeft = on.offsetLeft + on.offsetWidth - stateSeg.clientWidth + pad;
  }
  function renderStateSeg() {
    stateSeg.replaceChildren(...stateNames.map((s) =>
      h("button", {
        class: s === cur.state ? "on" : "",
        onclick: () => {
          cur.state = s;
          // Direction availability differs per state (e.g. stone_golem's
          // angry ships 5/8 dirs) — refresh the pad and hop to an available
          // direction if the current one has no clip in this state.
          if (!anims[s]?.dirs?.[cur.dir]) {
            cur.dir = state.data.directions.find((d) => anims[s]?.dirs?.[d]) ?? cur.dir;
          }
          loadClip(); renderStateSeg(); revealActiveState(); renderDirPad(); onStateChange?.(s);
        },
      }, stateLabel(s) + (anims[s].fallback ? ` (→${stateLabel(anims[s].fallback)})` : ""))));
  }

  const dirPad = h("span", { class: "dirpad" });
  function renderDirPad() {
    dirPad.replaceChildren(...state.data.directions.map((d) =>
      h("button", {
        class: d === cur.dir ? "on" : "", title: d,
        disabled: clipForDir(d) ? null : "disabled",
        onclick: () => { cur.dir = d; loadClip(); renderDirPad(); },
      }, DIR_LABEL[d])));
  }
  const clipForDir = (d) => anims[cur.state]?.dirs?.[d];
  renderStateSeg();
  requestAnimationFrame(revealActiveState);
  renderDirPad();

  const playBtn = h("button", { class: "ghost-btn", onclick: () => { cur.playing = !cur.playing; playBtn.textContent = cur.playing ? "⏸" : "▶"; } }, "⏸");
  const step = (dn) => { cur.playing = false; playBtn.textContent = "▶"; cur.frame = ((cur.frame + dn) % (clip?.frames ?? 1) + (clip?.frames ?? 1)) % (clip?.frames ?? 1); draw(); };
  const speedSeg = h("span", { class: "seg" }, ...[0.25, 0.5, 1, 2].map((sp) =>
    h("button", { class: sp === 1 ? "on" : "", onclick: (e) => { cur.speed = sp; e.target.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.target)); } }, `${sp}×`)));
  const zoomSeg = h("span", { class: "seg", title: "“same” draws every creature at one scale, so sizes are comparable between pages" },
    ...[["same", 0], ["1×", 1], ["2×", 2], ["4×", 4]].map(([lbl, z], i) =>
    h("button", { class: i === 0 ? "on" : "", onclick: (e) => { cur.zoom = z; e.target.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.target)); draw(); } }, lbl)));

  const controls2 = h("div", { class: "player-controls" },
    playBtn,
    h("button", { class: "ghost-btn", title: "Previous frame", onclick: () => step(-1) }, "⏮"),
    h("button", { class: "ghost-btn", title: "Next frame", onclick: () => step(1) }, "⏭"),
    frameNo, speedSeg, zoomSeg,
    entity.shadow ? h("label", { class: "chk" },
      Object.assign(h("input", { type: "checkbox" }), { checked: cur.shadow, onchange: (e) => { cur.shadow = e.target.checked; draw(); } }),
      "Show shadow") : null,
  );

  let onStateChange = null;
  if (!anims[cur.state]?.dirs?.[cur.dir]) {
    cur.dir = state.data.directions.find((d) => anims[cur.state]?.dirs?.[d]) ?? cur.dir;
    renderDirPad();
  }
  loadClip();
  const rootEl = h("div", { class: "player" },
    h("div", { class: "player-controls" }, stateSeg),
    h("div", { class: "player-controls" }, dirPad),
    stage, controls2);
  return {
    el: rootEl,
    destroy: () => cancelAnimationFrame(rafTimer),
    getState: () => cur.state,
    set onStateChange(fn) { onStateChange = fn; },
  };
}
let activePlayers = [];
function destroyPlayers() { activePlayers.forEach((p) => p.destroy()); activePlayers = []; }

/* ---------------------------------------------------------------- audio */
const audioEl = () => $("#shared-audio");
let playingBtn = null;
function playTake(files, btn) {
  const a = audioEl();
  const src = files.m4a ?? files.ogg ?? files.wav;
  if (playingBtn === btn && !a.paused) { a.pause(); return; }
  if (playingBtn) { playingBtn.classList.remove("playing"); playingBtn.textContent = "▶"; }
  a.src = assetUrl(src);
  a.play().catch((e) => toast(`Playback failed: ${e.message}`));
  playingBtn = btn;
  btn.classList.add("playing"); btn.textContent = "⏸";
  a.onpause = a.onended = () => { btn.classList.remove("playing"); btn.textContent = "▶"; if (playingBtn === btn) playingBtn = null; };
}
function takeRow(domain, entityPath, take, extra = []) {
  const id = `${entityPath}/${take.id}`.replace(/\.(wav|ogg|m4a)$/, "");
  const row = h("div", { class: "take-row" });
  const sync = () => row.classList.toggle("rejected", fb(domain, id).status === "rejected");
  const btn = h("button", { class: "play-btn", "aria-label": "play", onclick: () => playTake(take.files, btn) }, "▶");
  // NB: skip null children explicitly — raw DOM append(null) renders a literal
  // "null" text node (players saw one on every non-chosen take, 2026-07-30).
  for (const c of [
    btn,
    h("span", { class: "take-name" }, take.id),
    take.chosen ? h("span", { class: "pill ok", title: "The take the game plays" }, "chosen") : null,
    ...extra,
    h("span", { class: "spacer" }),
    starsWidget(domain, id),
    verdictWidget(domain, id, { onchange: sync }),
  ]) if (c) row.append(c);
  sync();
  return row;
}

/* ----------------------------------------------------------------- views */
// ONE table for every section's player-facing NAME, icon and count. The
// route slugs stay as they are — they're URLs, and the feedback ids are
// repo paths — but nothing user-visible says "monsters" or "tiles" any more
// (maintainer 2026-07-30 named these). Add a section here and the nav, the
// start page, the headings and the back-links all follow.
const SECTIONS = {
  monsters:   { label: "Creatures",     noun: "creatures",  icon: "creatures",  count: (d) => d.counts.monsters },
  // "Races", not "Characters" (maintainer 2026-08-05: "Characters" reads too
  // close to "Creatures"). The nav counts RACES; the start tile keeps heroes.
  // "Races", not "Characters" (maintainer 2026-08-05: "Characters" reads too
  // close to "Creatures"). The count is the WHOLE cast — heroes and NPCs
  // together — because "2 heroes" undersold a section holding 193 people
  // (maintainer 2026-08-05). The word "characters" survives here, as the
  // count noun, which is exactly where it never collided with "creatures".
  characters: { label: "Races",         noun: "characters", icon: "characters",
                count: (d) => (d.counts.characters ?? 0) + (d.counts.npcs ?? 0) },
  tiles:      { label: "World",         noun: "tiles",      icon: "world",      count: (d) => d.counts.tiles, navCount: (d) => d.counts.tile_types },
  objects:    { label: "Scenery",       noun: "props",      icon: "objects",    count: (d) => d.counts.objects },
  sounds:     { label: "Sound Effects", noun: "sounds",     icon: "sounds",     count: (d) => d.counts.sounds },
  music:      { label: "Music",         noun: "tracks",     icon: "music",      count: (d) => d.counts.music },
  items:      { label: "Items",         noun: "items",      icon: "items",      count: (d) => d.counts.items },
  // "tales", not "chapters": the section holds 9 chapters AND one people
  // article, and a tile reading "10 chapters" over a page whose Chapters
  // group says 9 reads as a bug.
  lore:       { label: "Lore",          noun: "tales",      icon: "lore",       count: (d) => d.counts.lore },
  // ADMIN-ONLY (maintainer 2026-07-30): parameters are designer machinery,
  // not encyclopedia — players must not even see the read-only page.
  tuning:     { label: "Parameters",    noun: "constants",  icon: "parameters", count: (d) => d.counts.constants, adminOnly: true },
};
const SECTION_ORDER = ["monsters", "characters", "tiles", "objects", "sounds", "music", "items", "lore", "tuning"];
const label = (slug) => SECTIONS[slug]?.label ?? slug;
/** The maintainer's 48x48 pixel art, drawn ONLY at whole multiples of 48 and
 *  never resampled — `image-rendering: pixelated` plus an exact CSS size, so
 *  a phone's 2x/3x device pixels land on clean pixel boundaries. */
function sectionIcon(slug, size = 48) {
  const icon = SECTIONS[slug]?.icon;
  if (!icon) return null;
  return h("img", { class: "sect-icon", src: `icons/${icon}.webp`, alt: "", width: String(size), height: String(size), loading: "lazy" });
}
/** Page heading with its icon beside it. */
function sectionHead(slug) {
  return h("div", { class: "sect-head" }, sectionIcon(slug), h("h1", {}, label(slug)));
}
function renderNav() {
  const cur = location.hash.replace(/^#\/?/, "").split("/")[0];
  const rows = [h("a", { href: "#/", class: cur === "" ? "active" : "" }, "Overview", h("span", { class: "count" }, ""))];
  for (const slug of SECTION_ORDER) {
    const s = SECTIONS[slug];
    if (s.adminOnly && !state.admin) continue;
    rows.push(h("a", { href: `#/${slug}`, class: cur === slug ? "active" : "" },
      s.label, h("span", { class: "count" }, String((s.navCount ?? s.count)(state.data) || ""))));
  }
  $("#nav").replaceChildren(...rows);
}

function entityBadge(domain, id) {
  const e = fb(domain, id);
  const out = [];
  if (e.rating) out.push(h("span", { class: "pill warn" }, `${"★".repeat(e.rating)}`));
  if (e.status === "approved") out.push(h("span", { class: "pill ok" }, "approved"));
  if (e.status === "rejected") out.push(h("span", { class: "pill err" }, "remove"));
  return out;
}

const matches = (q, ...hay) => !q || hay.some((s) => (s ?? "").toLowerCase().includes(q));

/* --- usage in the game world (built by ../build.mjs) ---
   Stats are always measured on the game's default world. That there are
   OTHER worlds is a development detail — the wiki never names one
   (maintainer 2026-07-30: the finished game has a single world). */
const worldInfo = () => state.data.world ?? null;
const tileUses = (rel) => worldInfo()?.tiles?.[rel] ?? 0;
const monsterSpawns = (id) => worldInfo()?.monsters?.[id] ?? null;
// "Referenced by the game" — bindings.json events / composer lookups for
// sounds, the director's chosen bed for music (see build.mjs).
function usePill(usedBy, whatUnused) {
  if (usedBy?.length) {
    return h("span", { class: "pill ok", title: `Referenced by: ${usedBy.join(", ")}` },
      usedBy.length === 1 && usedBy[0] === "background bed" ? "plays in game" : `in game · ${usedBy.length}×`);
  }
  return h("span", { class: "pill warn", title: whatUnused }, "unused");
}

// ← back crumb + prev/next through the domain's full list (wraps around).
// Layout rule (maintainer 2026-07-30): the "X / N" counter sits LEFT of the
// buttons so they stay in the same spot when the number gets wider.
function crumbRow(backHref, backLabel, base, list, id) {
  const i = list.findIndex((x) => x.id === id);
  const prev = list[(i - 1 + list.length) % list.length];
  const next = list[(i + 1) % list.length];
  const nav = i >= 0 && list.length > 1
    ? h("span", { class: "detail-nav" },
        h("span", { class: "detail-count" }, `${i + 1} / ${list.length}`),
        h("a", { class: "nav-btn", href: `#/${base}/${prev.id}`, title: `Previous: ${prev.name}`, "aria-label": `Previous: ${prev.name}` }, "‹"),
        h("a", { class: "nav-btn", href: `#/${base}/${next.id}`, title: `Next: ${next.name}`, "aria-label": `Next: ${next.name}` }, "›"))
    : null;
  return h("div", { class: "crumb-row" }, h("a", { class: "crumb", href: backHref }, backLabel), nav);
}

function viewHome() {
  // Icon-led section tiles: the maintainer's pixel art carries each section,
  // the name is the headline and the count is the small print (2026-07-30 —
  // "the wiki start page looks so boring without icons").
  const tiles = SECTION_ORDER
    .filter((slug) => !SECTIONS[slug].adminOnly || state.admin)
    .map((slug) => [slug, SECTIONS[slug].count(state.data), SECTIONS[slug].noun]);
  // Feedback whose asset no longer exists = the producing agent acted on it.
  const resolved = [];
  for (const [domain, f] of Object.entries(state.feedback)) {
    for (const [id, entry] of Object.entries(f?.entries ?? {})) {
      if (entry.status === "rejected" && !state.knownIds.has(id.split("#")[0])) resolved.push({ domain, id });
    }
  }
  return h("div", {},
    h("h1", {}, "Nangijala Wiki"),
    h("p", { class: "muted" }, state.admin
      ? "Everything the art and audio agents have made for the game — browse it, rate it, approve or remove it, and tune gameplay. Saves commit to live/ on main and stream straight into the running game."
      : "Every creature, hero, sound and song of Nangijala — the living encyclopedia of the world, always as fresh as the game you just played."),
    h("div", { class: "stat-tiles" }, ...tiles.map(([slug, n, noun]) =>
      h("a", { class: "stat-tile", href: `#/${slug}` },
        sectionIcon(slug, 96),
        h("div", { class: "n" }, SECTIONS[slug].label),
        h("div", { class: "l" }, `${n} ${noun}`)))),
    ...(state.admin ? [
      h("h2", {}, "How feedback works"),
      h("p", {}, "★ ratings steer style (no rating is the default). ", h("code", {}, "✕ remove"), " tells the producing agent to delete or replace the asset on its next run. ", h("code", {}, "✓ approve"), " locks in a keeper. Notes travel with the entry. Press ", h("strong", {}, "Save"), " when you're done — the game server commits ", h("code", {}, "live/feedback/*.json"), " and ", h("code", {}, "live/tuning/*.json"), " to main and pushes tuning to every connected player instantly."),
      resolved.length ? h("div", { class: "panel" },
        h("div", { class: "panel-title" }, "Resolved removals ", h("span", { class: "pill ok" }, String(resolved.length))),
        h("p", { class: "muted" }, "Assets you rejected that no longer exist in the repo — the agents acted on them."),
        ...resolved.slice(0, 30).map((r) => h("div", { class: "muted" }, h("code", {}, r.id)))) : null,
    ] : []),
  );
}

/* --- monsters --- */
function viewMonsters() {
  const q = state.query;
  const list = state.data.domains.monsters.filter((m) => matches(q, m.id, m.name, m.kind, monsterLore(m), ...(m.loreStory ?? [])));
  return h("div", {},
    sectionHead("monsters"),
    h("p", { class: "muted" }, state.admin
      ? `${list.length} creatures from the monsters agent. Click one to preview every animation, check its shadow, edit its stats and loot.`
      : `${list.length} creatures roam Nangijala. Click one to watch every animation and study its stats.`),
    h("div", { class: "grid" }, ...list.map((m) => {
      // The card leads with what matters to a PLAYER — the creature's stats
      // (live/tuning/monsters.json), not image resolution (maintainer
      // 2026-07-30). "not in game yet" is dev info → admin only.
      const st = monsterStats(m.id);
      const sp = monsterSpawns(m.id);
      return h("a", { class: "card", href: `#/monsters/${m.id}` },
        h("div", { class: "thumb checker" }, h("img", { src: assetUrl(m.preview), alt: m.name, loading: "lazy" })),
        levelBadge(st),
        h("div", { class: "card-name" }, m.name),
        h("div", { class: "card-sub" },
          `HP ${st.max_hp ?? "?"} · DMG ${st.damage ?? "?"} · XP ${st.xp ?? "?"}${state.admin && !m.inGame ? " · not in game yet" : ""}`),
        h("div", { class: "card-sub" }, sp
          ? `${sp.spawned} roaming · ${sp.zones} ${sp.zones === 1 ? "habitat" : "habitats"}`
          : "not spawned"),
        h("div", { class: "card-badges" }, ...entityBadge("monsters", m.path)));
    })));
}
const monsterLore = (m) => m.loreDesc ?? m.lore ?? `Travellers tell of the ${m.name} roaming the wilds of Nangijala. What it wants — and what it guards — no chronicler has written down yet.`;
// The admin tail is folded INTO the accessor, not added as a second <p>:
// loreSlot reserves the height of the tallest blurb by mapping ONE function
// over the domain, so the visible text and the ghost list must come from the
// same accessor or the reserve stops being the true maximum.
const objectBlurb = (o) => `${o.loreDesc ?? o.description ?? ""}${o.category ? ` · ${o.category}` : ""}${state.admin && o.placement ? ` · world height ${o.placement.world_height_m}m (${o.placement.world_px_height}px)` : ""}`;
/** What a hero IS, in words a player understands — "Human · Female", never
 *  the pipeline folder id (maintainer 2026-07-30). */
const heroKind = (c) => [c.species, c.sex].filter(Boolean).join(" · ");
/** A game state as a READER sees it: "idle" → "Idle", "spell_wand" → "Spell
 *  wand". The keys are the game's own vocabulary, but they are still code —
 *  lowercase and underscored — and the viewer prints them on its buttons
 *  (maintainer 2026-08-01: "no technical names to the end user"). Anything
 *  genuinely technical is fixed where it is BUILT, not papered over here. */
const stateLabel = (s) => String(s).replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
/** Authored in characters2/metadata.json; the placeholder only runs for a
 *  hero the characters agent has not written up yet. */
const heroLore = (c) => c.loreDesc ?? c.lore ?? (c.kind === "npc"
  ? "One of the folk of Nangijala. Who they are — a name, a home, a grudge — has not been written down yet."
  : "One of the heroes you can set out as. Their story has not been written down yet — the chroniclers of Nangijala are still at work.");
/** A lore paragraph that always occupies the height of the LONGEST lore in
 *  its domain, so paging next/next/next can't move the animation viewer
 *  below it (maintainer 2026-07-30: "the animation preview jumps up and
 *  down constantly"). Blurbs run 2-4 lines and the line count also depends
 *  on the column width, so a hardcoded min-height would be wrong on some
 *  phone; instead every blurb is stacked in ONE grid cell with only the real
 *  one visible — the row is then exactly as tall as the tallest, measured by
 *  the browser at whatever width it actually has. */
function loreSlot(text, all) {
  const ghosts = [...new Set(all)].filter((t) => t !== text)
    .map((t) => h("p", { class: "muted lore ghost", "aria-hidden": "true" }, t));
  return h("div", { class: "lore-slot" }, h("p", { class: "muted lore" }, text), ...ghosts);
}
/* ------------------------------------------------------------------- lore */
// Set by a "Read next" link, consumed by the next navigation. Null for every
// other kind of link, which simply starts at the top.
let pendingScroll = null;
const loreList = () => state.data.domains.lore ?? [];   // build.mjs sorted it; never re-sort
// One table for every category decision — the group heading AND the chip under
// the picture. An unknown category never throws and never prints a raw slug.
/** The race a "people" entry is about, taken from the cast's own species so
 *  the day Elves ship their entry chips itself. */
function raceOfEntry(e) {
  const races = [...new Set((state.data?.domains?.characters ?? []).map((c) => c.species || "Human"))];
  return races.find((r) => new RegExp(`\\b${r}s?\\b`, "i").test(e?.name ?? "")) ?? null;
}
const LORE_CATEGORY = {
  chapter: { plural: "Chapters", chip: (e) => (Number.isInteger(e.chapter) ? `Chapter ${e.chapter}` : "A chapter") },
  // "The Human Race", not "A people" (maintainer 2026-08-05) — the section is
  // called Races now and the chip should say so. The race is DERIVED from the
  // cast, not hardcoded: the species whose name appears in the entry's title
  // ("The Human Dead" → Human). An entry about a people we have no cast for
  // still reads as a race rather than falling back to the old word.
  people:  { plural: "Races",    chip: (e) => { const r = raceOfEntry(e); return r ? `The ${r} Race` : "A race"; } },
  place:   { plural: "Places",   chip: () => "A place" },
  faction: { plural: "Factions", chip: () => "A faction" },
};
const loreCat = (e) => LORE_CATEGORY[e?.category] ?? { plural: "Writings", chip: () => "A tale" };
const chipText = (e) => loreCat(e).chip(e);
/** An entry's 48×48 emblem, drawn at 48 or 96 and never resampled. Entry icons
 *  are REPO-relative (unlike sectionIcon, which is site-relative), so they go
 *  through assetUrl(). The size comes from the MARKUP so the box is reserved
 *  before the image loads — an unsized img that pops in shifts the list. */
function loreIcon(e, size = 48) {
  const src = e?.icon ?? state.data.loreMeta?.default_icon;
  if (!src) return h("span", { class: "item-icon item-noart", style: `width:${size}px;height:${size}px` });
  const img = h("img", { class: "lore-icon item-icon", src: assetUrl(src), alt: "", width: String(size), height: String(size), loading: "lazy" });
  // Hidden, never display:none — the reserved box must survive a 404 or the row collapses.
  img.addEventListener("error", () => { img.style.visibility = "hidden"; });
  return img;
}

/* --- the paged long text: ONE component for the story card and the red line.
   Only the CURRENT page is in the DOM. Deliberately NOT loreSlot's ghost stack:
   story pages legitimately run ~110..710px tall, so reserving the tallest would
   leave ~600px of dead cream on the short ones. The pager lives in the panel
   TITLE row instead — above every variable-height thing — and the panel is
   always the LAST element on its page, so nothing can move while paging. */
const STORY_PAGE_CHARS = 700;
const STORY_ORPHAN_CHARS = 140;
/** Greedy fill by character budget. PARAGRAPHS ARE ATOMIC — one re-wraps
 *  differently on every page and reads as a bug — so an oversized paragraph
 *  becomes its own page. Never paginate by paragraph COUNT: they run 30 to
 *  1262 characters. A last page that is one short paragraph joins the one
 *  before it rather than dangling. */
/* Lore v2 (2026-08-05): a paragraph is a STRING, or an array of segments
   {t, ref?} — the lore agent's inline links, so a name in running prose can
   point straight at the entity it names. paraText() is the ONE flattener
   (search, budgets, dedupe all use it); paraNode() is the ONE renderer, and
   its links follow the established landing rules EXACTLY: a chapter ref
   starts the reader at the top, an entity ref lands on that page's story
   card (maintainer 2026-08-05: "maintain the logic we have"). Segment text
   stays a TEXT NODE — no markup path, same rule as before. */
const paraText = (p) => (typeof p === "string" ? p : (p ?? []).map((s) => s?.t ?? "").join(""));
function paraNode(p) {
  if (typeof p === "string") return h("p", {}, p);
  return h("p", {}, ...(p ?? []).map((seg) => {
    const t = seg?.t ?? "";
    if (!seg?.ref) return t;
    const r = resolveRef(seg.ref);
    if (!r) return t;                            // a stale ref reads as prose, never as a broken link
    const a = h("a", { class: "lore-inline", href: r.href }, t);
    a.addEventListener("click", () => { pendingScroll = seg.ref.domain === "lore" ? "top" : "story"; });
    return a;
  }));
}
function paginate(paras, budget = STORY_PAGE_CHARS) {
  const pages = [];
  let cur = [], n = 0;
  for (const raw of paras ?? []) {
    const len = paraText(raw).trim().length;     // budget by VISIBLE text, rich or plain
    if (!len) continue;
    if (cur.length && n + len > budget) { pages.push(cur); cur = []; n = 0; }
    cur.push(raw); n += len;
  }
  if (cur.length) pages.push(cur);
  const last = pages[pages.length - 1];
  if (pages.length > 1 && last.length === 1 && paraText(last[0]).length < STORY_ORPHAN_CHARS) {
    pages[pages.length - 2] = pages[pages.length - 2].concat(pages.pop());
  }
  return pages;
}
/** Put an element's top just under the sticky topbar. */
function scrollToTopOf(el) {
  const bar = $("#topbar")?.getBoundingClientRect().height ?? 0;
  window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - bar - 8));
}
/** A story card must ALWAYS be able to reach the top of the viewport, so a
 *  link can drop a reader straight into it (maintainer 2026-07-31). It is the
 *  last thing on its page, so without a tail there is nothing to scroll into
 *  and a short card stays stranded mid-screen. Sized exactly — zero tail once
 *  the card is taller than the viewport — and recomputed on every page turn,
 *  because turning a page changes the card's height. */
function fitStoryTail() {
  const content = $("#content"), card = $(".story-card");
  if (!content) return;
  if (!card) { content.style.paddingBottom = ""; return; }
  const bar = $("#topbar")?.getBoundingClientRect().height ?? 0;
  const need = window.innerHeight - card.getBoundingClientRect().height - bar - 8;
  content.style.paddingBottom = `${Math.max(120, Math.round(need))}px`;
}
/* --- Back returns you to your place ---------------------------------------
   You read half of Stumpling's story, follow "Read next" to Sprigling, then
   press Back — and the wiki used to drop you at the top of Stumpling, with the
   story you were reading three screens down and its page reset (maintainer
   2026-07-31). Where the reader stood is stamped onto the history entry they
   LEAVE, so the browser carries it for us and every entry remembers its own
   spot, however deep the trail goes. */
/** Stamp the outgoing entry. Anchored to the story card rather than to a raw
 *  pixel offset whenever there is one: the art above it loads lazily and the
 *  animation stage sizes itself late, so a bare scrollY would point at
 *  different content by the time the reader comes back. */
function rememberSpot() {
  const card = $(".story-card");
  history.replaceState({ ...history.state, spot: {
    hash: location.hash,
    y: Math.round(window.scrollY),
    cardOff: card ? Math.round(card.getBoundingClientRect().top) : null,
    page: card?.pageIndex?.() ?? null,          // which page of the story
  } }, "");
}
/** Put the reader back. False if the stamp isn't for this page, so the caller
 *  can fall back to the top. */
function restoreSpot(spot) {
  if (!spot || spot.hash !== location.hash) return false;
  const card = $(".story-card");
  // The page FIRST: it changes the card's height, which fitStoryTail measures,
  // which decides whether the scroll below is even reachable.
  if (card && spot.page != null) card.goToPage(spot.page);
  fitStoryTail();
  if (card && spot.cardOff != null)
    window.scrollTo(0, Math.max(0, card.getBoundingClientRect().top + window.scrollY - spot.cardOff));
  else window.scrollTo(0, spot.y);
  return true;
}
/** @param pages array of THUNKS returning Node[] — only the visible page exists.
 *  @param title a string or a Node (the story card heads with its entity). */
function pagedPanel({ title, pages, aside = null, klass = "" }) {
  if (!pages.length) return null;
  let i = 0;
  const body = h("div", { class: "story-body" });
  const count = h("span", { class: "detail-count" });
  const mk = (glyph, lbl, step) => {
    const b = h("button", { class: "nav-btn", type: "button", title: lbl, "aria-label": lbl }, glyph);
    // A plain button re-rendering IN PLACE. Never the hash: a hashchange re-runs
    // route(), which rebuilds the whole view and destroys the animation player.
    b.addEventListener("click", () => {
      const t = i + step;
      if (t < 0 || t >= pages.length) return;
      i = t; draw();
      // A new page starts at ITS top — the control is at the bottom, so
      // without this you would be left staring at the end of the page you
      // just turned to (maintainer 2026-07-31).
      if (panel) { fitStoryTail(); scrollToTopOf(panel); }
    });
    return b;
  };
  let panel = null;
  const prev = mk("‹", "Previous page", -1), next = mk("›", "Next page", +1);
  const draw = () => {
    body.replaceChildren(...pages[i]());
    count.textContent = `${i + 1} / ${pages.length}`;   // mutated in place — the
    prev.disabled = i === 0;                             // buttons are never rebuilt
    next.disabled = i === pages.length - 1;              // under the reader's finger
    // A page turn NEVER scrolls: you are mid-card, not navigating. Turning
    // from a long page to a short one shrinks the document, so a reader parked
    // at the very bottom is carried up by the browser's own scroll clamp —
    // unavoidable without reserving the tallest page, which would cost ~600px
    // of dead space on the short ones.
  };
  draw();
  // READING ORDER (maintainer 2026-07-31): title, then the prose, then the
  // page control at the BOTTOM RIGHT where the text ends, then "Read next"
  // last of all. The pager and the links used to sit above the prose, between
  // the reader and the thing they opened the card for.
  panel = h("div", { class: `panel${klass ? ` ${klass}` : ""}` },
    h("div", { class: "panel-title" }, title),
    body,
    // Counter LEFT of the buttons (crumbRow's rule) so ‹ › keep their spot as
    // "9 / 16" widens.
    pages.length > 1 ? h("div", { class: "page-rail" }, count, prev, next) : null,
    aside);
  panel.goToPage = (n) => { if (n >= 0 && n < pages.length) { i = n; draw(); } };
  panel.pageIndex = () => i;                     // for Back — see rememberSpot()
  return panel;
}

/* --- cross-references. ALWAYS resolved against the OWNING domain in data.json,
   never against lore.json: almost no item has a lore record, so a lore-sourced
   label would be blank for nearly all of them. --- */
let _loreIx = null, _charIx = null, _objIx = null, _tileIx = null;
const loreById      = (id) => (_loreIx ??= new Map(loreList().map((e) => [e.id, e]))).get(id);
const characterById = (id) => (_charIx ??= new Map((state.data.domains.characters ?? []).map((c) => [c.id, c]))).get(id);
const objectById    = (id) => (_objIx  ??= new Map((state.data.domains.objects ?? []).map((o) => [o.id, o]))).get(id);
const tileTypeById  = (id) => (_tileIx ??= new Map((state.data.domains.tiles ?? []).map((t) => [t.id, t]))).get(id);
const refPic = (x) => (x?.preview
  ? h("img", { class: "item-icon mon-icon", src: assetUrl(x.preview), alt: "", width: "48", height: "48", loading: "lazy" })
  : h("span", { class: "item-icon item-noart" }));
function resolveRef(ref) {
  const { domain, id } = ref ?? {};
  if (!domain || !id) return null;
  if (domain === "lore")       { const e = loreById(id);      return e  && { href: `#/lore/${e.id}`,       name: e.name,        art: loreIcon(e, 48),    where: chipText(e) }; }
  if (domain === "monsters")   { const m = monsterById(id);   return m  && { href: `#/monsters/${m.id}`,   name: m.name,        art: refPic(m),          where: label("monsters") }; }
  // A person's context is their RACE, not the section they live under
  // (maintainer 2026-08-05): Jehanne reads as "Human", the way a URL
  // /races/human/<id> would. Everything else names its section.
  if (domain === "characters") { const c = characterById(id); return c  && { href: `#/characters/${c.id}`, name: c.name,        art: refPic(c),          where: c.species || label("characters") }; }
  if (domain === "items")      { const it = itemById(id);     return it && { href: `#/items/${it.id}`,     name: itemLabel(it), art: itemSprite(it, 48), where: label("items") }; }
  if (domain === "objects")    { const o = objectById(id);    return o  && { href: `#/objects/${o.id}`,    name: o.name,        art: refPic(o),          where: label("objects") }; }
  if (domain === "tiles")      { const t = tileTypeById(id);  return t  && { href: `#/tiles/${t.id}`,      name: t.name,        art: h("span", { class: "item-icon item-noart" }), where: label("tiles") }; }
  return null;                                  // an unknown domain is dropped
}
/** A chapter's readable paragraphs. the_falling's body[0] repeats its summary
 *  verbatim; exact match only, so a rewritten summary can never silently
 *  swallow a paragraph. Shared with hasStory() so the page and the "Read next"
 *  filter can never disagree about whether a chapter has anything in it. */
const chapterParas = (e) => (e?.body ?? []).filter((p, n) => !(n === 0 && paraText(p) === e.summary));
/** The entity behind a reference, for the four domains that render a story
 *  card. Tiles, sounds and music are absent ON PURPOSE: their pages have no
 *  card, so no amount of loreStory in the record would give a reader anything
 *  to land on. */
function storyEntity(domain, id) {
  if (domain === "monsters")   return monsterById(id);
  if (domain === "characters") return characterById(id);
  if (domain === "objects")    return objectById(id);
  if (domain === "items")      return itemById(id);
  return null;
}
/** Does this reference lead to something you can actually READ? "Read next" is
 *  a promise, and a page with no story keeps none of it — the reader clicks
 *  expecting prose and gets a stat sheet (maintainer 2026-07-31). Answered by
 *  the same paginate() the target page will run, so the two cannot drift. */
function hasStory(ref) {
  const { domain, id } = ref ?? {};
  if (domain === "lore") return chapterParas(loreById(id)).length > 0;
  return paginate(storyEntity(domain, id)?.loreStory).length > 0;
}
/** "Read next". Author order preserved (the lore agent chose it), deduped. A
 *  reference that is unresolvable — or that resolves to a page with no story —
 *  is DROPPED for players and flagged for the admin, who is the one who can
 *  get it written. */
function loreLinks(related, { title = "Read next" } = {}) {
  const seen = new Set(), rows = [];
  for (const ref of related ?? []) {
    const key = `${ref?.domain}/${ref?.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = resolveRef(ref);
    if (r && hasStory(ref)) {
      const a = h("a", { class: "drop-row", href: r.href }, r.art,
        h("span", { class: "drop-name" }, r.name), h("span", { class: "drop-worth muted" }, r.where));
      // Where the reader should LAND. A chapter is a thing you read from the
      // top; another entity's story is the middle of its page, so go to that
      // card rather than making the reader hunt for it (maintainer
      // 2026-07-31).
      a.addEventListener("click", () => { pendingScroll = ref.domain === "lore" ? "top" : "story"; });
      rows.push(a);
    }
    else if (state.admin) rows.push(h("div", { class: "drop-row" },
      r?.art ?? h("span", { class: "item-icon item-noart" }),
      h("span", { class: "drop-name" }, r ? r.name : key,
        h("span", { class: "pill warn" }, r ? "no story yet" : "no such entry"))));
  }
  if (!rows.length) return null;
  return h("div", { class: "see-also" },
    h("div", { class: "panel-title see-also-title" }, title),
    h("div", { class: "drop-list" }, ...rows));
}
/** The long story, in a card at the BOTTOM of an entity's page — many readers
 *  will never open it, so it must cost them nothing (maintainer 2026-07-31).
 *  No story ⇒ NO CARD AT ALL, never a placeholder. */
function storyCard({ label: what, art, name, paras, related }) {
  const chunks = paginate(paras);
  if (!chunks.length) return null;
  // The card RE-INTRODUCES its entity (maintainer 2026-07-31): a link can drop
  // a reader straight onto this card with the rest of the page above the fold,
  // so the card has to say who it is about on its own. Thumbnail left, name
  // right — smaller than the page's own h1, because this is a reminder, not a
  // second title.
  const head = h("div", { class: "story-head" },
    art ?? null,
    h("div", { class: "story-who" },
      h("div", { class: "story-name" }, name ?? ""),
      h("div", { class: "story-what muted" }, what)));
  return pagedPanel({
    title: head, klass: "story-card",
    aside: loreLinks(related),                       // last in the card
    pages: chunks.map((ps) => () => ps.map(paraNode)),
  });
}
const heroStoryTitle = (c) => (c.sex === "Female" ? "Her story" : c.sex === "Male" ? "His story" : "Their story");

/** The level chip that sits under a monster's picture — on the cards AND on
 *  the monster page, where it also gives the portrait column a constant
 *  height so paging next/next/next doesn't shift the animation (maintainer
 *  2026-07-30). Levels live in live/tuning/monsters.json; see build.mjs. */
function levelBadge(stats) {
  return h("div", { class: "thumb-chip", title: "How hard this creature is to fight" },
    "Level ", h("b", {}, String(stats.level ?? "?")));
}
/* --- loot: the item ↔ creature join (build.mjs precomputes both ways) --- */
let _itemIx = null, _monIx = null;
const itemById = (id) => (_itemIx ??= new Map((state.data.domains.items ?? []).map((i) => [i.id, i]))).get(id);
const monsterById = (id) => (_monIx ??= new Map((state.data.domains.monsters ?? []).map((m) => [m.id, m]))).get(id);
/** A drop chance (a FRACTION) as a percentage a human can read. The data spans
 *  0.006..0.45, so a fixed precision either prints "1%" for three different
 *  odds or "45.0%" for none of them: keep one decimal below 10%, whole
 *  numbers above, and never round a real chance down to "0%". */
function pct(chance) {
  const n = Number(chance);
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = Math.min(100, n * 100);
  if (p < 0.1) return "<0.1%";
  return `${p < 10 ? +p.toFixed(1) : Math.round(p)}%`;
}
/** Is this item's type bound 1-to-1 to a creature? Asked of the ITEMS AGENT'S
 *  own type table (`one_per_monster`), never by testing for "SOUL" — a future
 *  type that declares it inherits the treatment for free. */
const oneToOne = (it) => !!state.data.itemTypes?.[it?.type]?.one_per_monster;
const itemSources = (it) => it?.droppedBy ?? [];
/** What KIND of thing this is, in the maintainer's words. The items agent's
 *  own table is the source, except where the maintainer has named a type
 *  differently for players (2026-07-31: MISC reads "Miscellaneous", not the
 *  pipeline's "Junk") — asked of the tag, so a retitle upstream can't
 *  silently change what players read. */
const TYPE_NAMES = { MISC: "Miscellaneous" };
/** Order: the maintainer's word, then the type's own SHARED NAME when it has
 *  one — a type where every item carries the same name ("Soulstone") is
 *  called that, not the pipeline's prettier label ("Soul Stone") — then the
 *  label, then the raw tag. */
const typeLabel = (t) => {
  const ty = state.data.itemTypes?.[t];
  return TYPE_NAMES[t] ?? ty?.shared_name ?? ty?.label ?? t ?? "Item";
};
/** The maintainer's generic emblem for a whole item TYPE (a pearl for the
 *  junk, a stone for the souls) — the at-a-glance "what kind of thing is
 *  this" that rides on the chip. Authored 32×32 at 1×, drawn at 32 and never
 *  resampled. Keyed by tag: a type with no emblem simply gets none, so a new
 *  type is a file drop, not a code change. */
const TYPE_ICONS = { MISC: "type-misc", SOUL: "type-soul" };
function typeIcon(t, size = 32) {
  const icon = TYPE_ICONS[t];
  return icon
    ? h("img", { class: "type-icon", src: `icons/${icon}.webp`, alt: "", width: String(size), height: String(size), loading: "lazy" })
    : null;
}
/** The chip under an item's picture. For a 1-to-1 type it names the creature —
 *  every Soulstone is literally called "Soulstone", so the creature is the
 *  only thing that tells two of them apart. Decisions key off the SOURCE
 *  COUNT, never off soulOf alone: that is null for "unbound" AND for the
 *  "bound twice" the data must never contain but might. */
function itemChip(it) {
  // A 1-to-1 type has something better to say than its own name: the
  // creature. Everything else just says WHAT IT IS — not how rare it is
  // (maintainer 2026-07-31: "I don't like the Common/Uncommon/Rare/Epic
  // thing. This should just say the item type").
  // Both chips carry the type's emblem, so the KIND reads at a glance even
  // on a stone whose text is a creature's name (maintainer 2026-07-31).
  // The label is always its own element so the chip can lay out as a grid:
  // emblem pinned left, text centred in the WHOLE chip (maintainer
  // 2026-07-31) — a bare text node would become an anonymous grid item that
  // no selector can address.
  return h("div", { class: "thumb-chip has-icon", title: typeLabel(it.type) },
    typeIcon(it.type),
    h("span", { class: "chip-text" }, oneToOne(it) ? soulChip(it, true) : typeLabel(it.type)));
}
/** The creature a 1-to-1 stone belongs to. ALWAYS its name — a Soulstone
 *  carries no other identity. Bare = inline pill; `plain` = chip contents. */
function soulChip(it, plain = false) {
  const src = itemSources(it);
  const names = src.map((s) => monsterById(s.monster)?.name ?? s.monster);
  const wrap = (title, ...kids) => plain
    ? h("span", { title }, ...kids)
    : h("span", { class: "pill soul", title }, ...kids);
  if (names.length === 1) return wrap(`The soul of ${names[0]}`, names[0]);
  if (names.length === 0) return wrap("No creature carries this soul", "Unbound");
  return wrap(names.join(", "), names.join(" · "));
}
/** What an item sells for: the maintainer's gold coin and the number, no
 *  sentence around it (2026-07-31 — "this is more clean and says it all").
 *  The coin is authored 32×32 at 1×, so it is drawn at 32 and never resampled. */
function goldTag(it) {
  const v = Number(it?.value);
  if (!Number.isFinite(v) || v <= 0) return null;
  return h("span", { class: "gold-tag", title: `Sells for ${v} gold` },
    h("img", { class: "gold-coin", src: "icons/gold.webp", alt: "gold", width: "32", height: "32" }),
    h("b", {}, String(v)));
}
/** An item's sprite at a WHOLE multiple of its authored 48px (never resampled). */
function itemSprite(it, size = 48) {
  return it?.preview
    ? h("img", { class: "item-icon", src: assetUrl(it.preview), alt: "", width: String(size), height: String(size), loading: "lazy" })
    : h("span", { class: "item-icon item-noart", style: `width:${size}px;height:${size}px` });
}
/** WHAT THIS CREATURE DROPS — icon, name, worth, chance, each row a link to
 *  the item's page (maintainer 2026-07-31: the old list printed the folder id
 *  in a monospace chip and went nowhere). */
function dropsPanel(monsterId) {
  const stats = monsterStats(monsterId);
  const rows = (stats?.loot ?? [])
    .filter((l) => l?.item)                              // "+ add drop" writes a blank row
    .map((l) => ({ l, it: itemById(l.item) }))
    .filter((r) => r.it || state.admin)                  // an id the registry lost: never shown to players
    .sort((a, b) => (Number(b.l.chance) || -1) - (Number(a.l.chance) || -1)
      || String(a.it?.name ?? a.l.item).localeCompare(String(b.it?.name ?? b.l.item)));
  if (!rows.length) {
    return h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "Drops"),
      h("p", { class: "muted" }, "Nothing yet — no loot has been assigned to this creature."));
  }
  return h("div", { class: "panel" },
    h("div", { class: "panel-title" }, "Drops", h("span", { class: "pill" }, String(rows.length))),
    h("div", { class: "drop-list" }, ...rows.map(({ l, it }) => {
      // A soul stone is named "Soulstone" everywhere, so its creature rides
      // beside it even here, on that very creature's own page (maintainer
      // 2026-07-31) — the row must stay readable wherever it is quoted.
      const bound = it && oneToOne(it) ? soulChip(it) : null;
      return h("a", { class: "drop-row", href: it ? `#/items/${it.id}` : "#/items" },
        itemSprite(it),
        h("span", { class: "drop-name" },
          it?.name ?? l.item,
          bound,
          !it ? h("span", { class: "pill warn" }, "unknown item") : null),
        h("span", { class: "drop-worth" }, goldTag(it) ?? ""),
        h("span", { class: "drop-pct" }, pct(l.chance) ?? "—"));
    })));
}
/** WHERE THIS ITEM COMES FROM — the same table reversed, each row a link to
 *  the creature's page. */
function droppedByPanel(it) {
  const src = itemSources(it);
  const soul = oneToOne(it);
  if (!src.length) {
    return h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "Dropped by", h("span", { class: "pill" }, "none")),
      h("p", { class: "muted" }, soul
        ? "No creature in Nangijala carries this soul."
        : "Nothing in Nangijala is known to carry this."));
  }
  return h("div", { class: "panel" },
    h("div", { class: "panel-title" }, "Dropped by",
      h("span", { class: "pill" }, src.length === 1 ? "1 creature" : `${src.length} creatures`),
      soul && src.length > 1 ? h("span", { class: "pill warn", title: "A soul stone is meant to belong to exactly one creature" }, "should be one") : null),
    h("div", { class: "drop-list" }, ...src.map((s) => {
      const m = monsterById(s.monster);
      const st = monsterStats(s.monster);
      return h("a", { class: "drop-row", href: m ? `#/monsters/${m.id}` : "#/monsters" },
        m?.preview
          ? h("img", { class: "item-icon mon-icon", src: assetUrl(m.preview), alt: "", loading: "lazy" })
          : h("span", { class: "item-icon item-noart" }),
        h("span", { class: "drop-name" },
          m?.name ?? s.monster,
          !m ? h("span", { class: "pill warn" }, "unknown creature") : null),
        h("span", { class: "drop-worth muted" }, m && st?.level ? `Lv ${st.level}` : ""),
        h("span", { class: "drop-pct" }, pct(s.chance) ?? "—"));
    })));
}
/** A monster's effective stats: its tuned entry over the shared defaults. */
function monsterStats(id) {
  const t = state.tuning.monsters;
  return { ...(t?.defaults ?? {}), ...(t?.monsters?.[id] ?? {}) };
}
const STAT_FIELDS = [
  ["level", "Level", 1],
  ["max_hp", "Max HP", 1], ["damage", "Damage", 1], ["speed_wu", "Speed (wu/s)", 1],
  ["aggro_radius_wu", "Aggro radius (wu)", 1], ["attack_cooldown_ms", "Attack cooldown (ms)", 10],
  ["xp", "XP reward", 1], ["scale", "Display scale", 0.05],
];
function statsEditor(monsterId) {
  const t = state.tuning.monsters;
  if (!t) return h("p", { class: "muted" }, "tuning/monsters.json not loaded.");
  // Render from a copy; only a real edit installs the entry (viewing a page
  // must never sneak an entry into the next save).
  const stats = t.monsters[monsterId] ?? { ...t.defaults, loot: [] };
  if (!state.admin) {
    // Players see the stats read-only; the drops are their own panel now
    // (dropsPanel — icons, real names and a link to each item's page).
    return h("div", { class: "stat-grid ro" }, ...STAT_FIELDS.map(([key, label]) =>
      h("label", {}, label, h("span", { class: "stat-value" }, String(stats[key] ?? t.defaults[key] ?? 0)))));
  }
  const edited = () => {
    t.monsters[monsterId] = stats;
    touch("tuning/monsters", monsterId);
    markDirty("tuning/monsters");
  };
  const grid = h("div", { class: "stat-grid" }, ...STAT_FIELDS.map(([key, label, step]) => {
    const input = h("input", { type: "number", step: String(step), value: String(stats[key] ?? t.defaults[key] ?? 0) });
    input.addEventListener("change", () => { stats[key] = Number(input.value); edited(); });
    return h("label", {}, label, input);
  }));
  const lootBox = h("div", {});
  function renderLoot() {
    lootBox.replaceChildren(
      h("div", { class: "panel-title" }, "Loot / drops ", h("span", { class: "pill" }, "items agent: future")),
      ...(stats.loot ?? []).map((entry, i) =>
        h("div", { class: "loot-row" },
          Object.assign(h("input", { type: "text", placeholder: "item id (e.g. tusk)" , value: entry.item ?? "" }), { onchange: (e) => { entry.item = e.target.value; edited(); } }),
          Object.assign(h("input", { type: "number", class: "chance", min: "0", max: "100", step: "0.1", title: "drop chance %", value: String(+(100 * (entry.chance ?? 0)).toFixed(2)) }), { onchange: (e) => { entry.chance = Number(e.target.value) / 100; edited(); } }),
          h("span", { class: "muted" }, "%"),
          h("button", { class: "ghost-btn", onclick: () => { stats.loot.splice(i, 1); edited(); renderLoot(); } }, "✕"))),
      h("button", { class: "ghost-btn", onclick: () => { (stats.loot ?? (stats.loot = [])).push({ item: "", chance: 0.1 }); edited(); renderLoot(); } }, "+ add drop"));
  }
  renderLoot();
  return h("div", {}, grid, h("div", { style: "margin-top:14px" }, lootBox));
}
// "Where it lives": the world's own minimap with this monster's spawn zones
// drawn on it. The zones arrive as CELL SPANS (wiki/tools/world-map.py) —
// never as an outline. Projecting a zone's OUTLINE is what shipped broken on
// 2026-07-30: each vertex carries its corner's terrain height, which makes
// the projection non-linear, so a provably simple polygon tore into
// self-crossing shards across cliffs. A span is a run of cells at ONE level,
// so it maps through the affine cell→pixel transform and its union is the
// true, terrace-hugging footprint.
function zoneMapPanel(monsterId) {
  const wm = worldInfo()?.map;
  const zones = wm?.monsters?.[monsterId];
  if (!wm?.proj || !zones?.length) return null;
  const CSS_W = 900, k = CSS_W / wm.mapW, DPR = 2, s = k * DPR;
  const P = wm.proj;
  const canvas = h("canvas", {
    class: "zone-map", width: Math.round(wm.mapW * s), height: Math.round(wm.mapH * s),
    style: `width:${CSS_W}px`,
  });
  const ctx = canvas.getContext("2d");
  // Cell corner → canvas px. `ax/ay` offset within the tile box (the diamond's
  // top vertex is at +tile/2, its side vertices at +dy, its bottom at +2dy).
  const pt = (c, r, lv, ax, ay) => [
    (P.s * (P.ox + (c - r) * P.dx + ax) + P.offx) * s,
    (P.s * (P.oy + (c + r) * P.dy - lv * P.levelPx + ay) + P.offy) * s,
  ];
  const img = new Image();
  img.onload = () => {
    // A 0.15x LANCZOS bake of the whole world — smooth it down, don't
    // nearest-neighbour it (this is a map thumbnail, not 1:1 pixel art).
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#d97757";

    // Paint every span SOLID on an offscreen layer first: overlapping
    // translucent diamonds would blotch at their shared edges.
    const layer = document.createElement("canvas");
    layer.width = canvas.width; layer.height = canvas.height;
    const lx = layer.getContext("2d");
    lx.fillStyle = accent;
    lx.beginPath();
    for (const z of zones) {
      for (const [r, lv, c0, c1] of z.spans ?? []) {
        const a = pt(c0, r, lv, P.tile / 2, 0);          // top vertex, first cell
        const b = pt(c1, r, lv, P.tile, P.dy);           // right vertex, last cell
        const c = pt(c1, r, lv, P.tile / 2, 2 * P.dy);   // bottom vertex, last cell
        const d = pt(c0, r, lv, 0, P.dy);                // left vertex, first cell
        lx.moveTo(a[0], a[1]); lx.lineTo(b[0], b[1]); lx.lineTo(c[0], c[1]); lx.lineTo(d[0], d[1]);
        lx.closePath();
      }
    }
    lx.fill();

    // A solid rim (the layer nudged 4 ways) under a translucent body, so the
    // habitat reads at a glance without hiding the terrain inside it.
    const ring = 2 * DPR;
    for (const [dx, dy] of [[ring, 0], [-ring, 0], [0, ring], [0, -ring]]) ctx.drawImage(layer, dx, dy);
    ctx.globalAlpha = 0.42;
    ctx.drawImage(layer, 0, 0);
    ctx.globalAlpha = 1;

    // How many roam this particular habitat, at its centre of mass.
    ctx.font = `600 ${13 * DPR}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const z of zones) {
      const spans = z.spans ?? [];
      if (!spans.length) continue;
      let n = 0, sx = 0, sy = 0;
      for (const [r, lv, c0, c1] of spans) {
        const w = c1 - c0 + 1;
        const [x, y] = pt((c0 + c1) / 2 + 0.5, r + 0.5, lv, P.tile / 2, P.dy);
        sx += x * w; sy += y * w; n += w;
      }
      ctx.lineWidth = 4 * DPR;
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.strokeText(String(z.num), sx / n, sy / n);
      ctx.fillStyle = "#fff";
      ctx.fillText(String(z.num), sx / n, sy / n);
    }
  };
  img.src = assetUrl(wm.minimap);
  const total = zones.reduce((n, z) => n + z.num, 0);
  return h("div", { class: "panel" },
    h("div", { class: "panel-title" }, "Where it lives ",
      h("span", { class: "pill" }, `${total} in ${zones.length} ${zones.length === 1 ? "habitat" : "habitats"}`)),
    h("div", { class: "zone-map-wrap" }, canvas),
    state.admin ? h("p", { class: "muted", style: "margin:8px 0 0" },
      "zones: ", zones.map((z) => `${z.id || "?"} (${z.num})`).join(" · ")) : null);
}

function viewMonster(id) {
  const m = state.data.domains.monsters.find((x) => x.id === id);
  if (!m) return h("p", {}, "Unknown monster.");
  const player = makePlayer(m, "monster");
  activePlayers.push(player);
  const facetBox = h("div", {});
  // Per-animation feedback widgets, WITHOUT the "Feedback on this animation
  // (state)" caption (maintainer 2026-07-30: remove the text).
  const renderFacet = () => {
    facetBox.replaceChildren(feedbackRow("monsters", `${m.path}#${player.getState()}`));
  };
  player.onStateChange = renderFacet;
  renderFacet();
  return h("div", {},
    crumbRow("#/monsters", `← ${label("monsters")}`, "monsters", state.data.domains.monsters, m.id),
    h("div", { class: "detail-head" },
      h("div", { class: "portrait-col" },
        h("div", { class: "portrait checker" }, h("img", { src: assetUrl(m.preview), alt: m.name })),
        levelBadge(monsterStats(m.id))),
      h("div", { class: "meta" },
        h("h1", {}, m.name),
        // How many roam the world, tucked under the name and above the
        // description (maintainer 2026-07-30).
        h("div", { class: "spawn-line" }, (() => {
          const sp = monsterSpawns(m.id);
          return sp
            ? h("span", { class: "pill ok" }, `${sp.spawned} roaming the world across ${sp.zones} ${sp.zones === 1 ? "habitat" : "habitats"}`)
            : h("span", { class: "pill warn", title: "No spawn zone places this creature in the world yet" }, "not spawned in the world");
        })()),
        // PLAYER-facing lore: the monsters domain's own blurb (monster.json
        // `lore`) when it ships one, else a generic placeholder until the
        // lore agent covers the stragglers (maintainer 2026-07-30). The lore
        // is the LAST thing in this column on purpose — the height it
        // reserves for the longest blurb then falls at the bottom of the
        // column, where it reads as the gap before the next panel instead of
        // opening a blank line in the middle of the page.
        loreSlot(monsterLore(m), state.data.domains.monsters.map(monsterLore)),
        // Art/render tech (resolution, pads, foot metrics) is admin-only.
        state.admin ? h("p", { class: "muted" }, `${m.frameW}×${m.frameH}px (native ${m.nativeW}×${m.nativeH}, pad ${m.pad.x},${m.pad.y}) · kind: ${m.kind} · foot line at ${(m.artBottom * 100).toFixed(0)}% · footW ${m.footW ?? "?"}px · bodyW ${m.bodyW ?? "?"}px${m.hoverPx ? ` · hovers ${m.hoverPx}px` : ""}${m.inGame ? "" : " · not in the game manifest yet"}`) : null,
        state.admin && m.pixellab ? h("p", {}, h("a", { href: m.pixellab, target: "_blank", rel: "noopener" }, "Open in PixelLab ↗")) : null,
        feedbackRow("monsters", m.path))),
    h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "Animations", h("span", { class: "pill" }, `${Object.keys(m.animations).length} states × 8 directions`)),
      player.el,
      h("div", { style: "margin-top:12px" }, facetBox)),
    zoneMapPanel(m.id),
    // What it drops, each row a link to that item's page.
    dropsPanel(m.id),
    h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "Stats"),
      statsEditor(m.id)),
    // This creature's own sound events (none in the game yet — the Game
    // Master can assign one to any of its actions from here).
    entitySoundsCard("monsters", m),
    // The long story, last on the page ALWAYS — the pager is the only control
    // above variable-height content, so nothing may be appended below it.
    storyCard({ label: "The story", art: refPic(m), name: m.name, paras: m.loreStory, related: m.loreRelated }));
}

/* --- characters --- */
const npcCard = (c) => h("a", { class: "card npc-card", href: `#/characters/${c.id}` },
  h("div", { class: "thumb checker" }, h("img", { src: assetUrl(c.preview), alt: c.name, loading: "lazy" })),
  // Real names (characters2 2026-08-01), said QUIETLY: one line of name, one
  // muted line of trade, both truncating — a tile that grows a second line
  // re-flows the whole grid and the block stops reading as secondary.
  h("div", { class: "npc-name" }, c.name),
  c.role ? h("div", { class: "npc-role muted" }, c.role) : null,
  state.admin ? h("div", { class: "card-sub" }, c.id) : null,
  h("div", { class: "card-badges" }, ...entityBadge("characters", c.path)));
/** The NPC block, paged INSIDE its card: 20 tiles a page with ‹ › (maintainer
 *  2026-08-05 — one race's full cast would bury the next race the day a
 *  second one ships). In-place redraw, same idiom as the story pager; no
 *  scroll on a page turn, the reader is already looking at the grid. */
function npcPagedBlock(npcs) {
  if (!npcs.length) return null;
  const PER = 20;
  const pages = Math.ceil(npcs.length / PER);
  let page = 0;
  const grid = h("div", { class: "grid npc-grid" });
  const count = h("span", { class: "detail-count" });
  const mk = (glyph, lbl, step) => h("button", {
    class: "nav-btn", type: "button", title: lbl, "aria-label": lbl,
    onclick: () => { const t = page + step; if (t < 0 || t >= pages) return; page = t; draw(); },
  }, glyph);
  const prev = mk("‹", "Previous NPCs", -1), next = mk("›", "Next NPCs", +1);
  const draw = () => {
    grid.replaceChildren(...npcs.slice(page * PER, (page + 1) * PER).map(npcCard));
    count.textContent = `${page + 1} / ${pages}`;
    prev.disabled = page === 0;
    next.disabled = page === pages - 1;
  };
  draw();
  return h("div", { class: "npc-block" },
    h("h2", {}, "NPCs", h("span", { class: "pill", style: "margin-left:8px" }, npcs.length.toLocaleString())),
    h("p", { class: "muted" }, state.admin
      ? "The tag-driven NPC mirror — name, sex and trade authored by the characters agent from the art itself. Review and prune from here."
      : "The folk you will meet along the way. You cannot set out as one of them."),
    grid,
    pages > 1 ? h("div", { class: "page-rail" }, count, prev, next) : null);
}
/** The lore agent's write-up of a race — its "people" entry, matched by name
 *  (Human → "The Human Dead"). Their text wins, as everywhere. */
const raceLore = (race) => (state.data.domains.lore ?? []).find((e) => e.category === "people" && new RegExp(race, "i").test(e.name));
function viewCharacters() {
  const all = state.data.domains.characters;
  const heroes = all.filter((c) => c.kind !== "npc" && matches(state.query, c.id, c.name));
  const npcs = all.filter((c) => c.kind === "npc" &&
    matches(state.query, c.name, c.sex, c.role, ...(state.admin ? [c.id, c.pixellabName] : [])));
  // RACES (maintainer 2026-08-05): the page is grouped by race, each an inner
  // topic with the race's own description. Only Humans exist today — the
  // structure is what matters, so a second race lands as a second block.
  const races = [...new Set(all.map((c) => c.species || "Human"))].sort();
  return h("div", {},
    sectionHead("characters"),
    h("p", { class: "muted" }, state.admin
      ? "Every race of Nangijala — its playable heroes first, then its NPCs. From characters2; every game state, all 8 directions."
      : "The races of Nangijala — the heroes you can set out as, and the folk you will meet."),
    ...races.map((race) => {
      const rl = raceLore(race);
      const rHeroes = heroes.filter((c) => (c.species || "Human") === race);
      const rNpcs = npcs.filter((c) => (c.species || "Human") === race);
      if (!rHeroes.length && !rNpcs.length) return null;
      return h("div", { class: "race-block" },
        h("h2", {}, `${race}s`,
          rHeroes.length ? h("span", { class: "pill ok", style: "margin-left:8px" }, `${rHeroes.length} playable`) : null),
        // The race's short description — the lore agent's "people" entry
        // where one exists, with the way into the full write-up.
        rl ? h("p", { class: "muted race-blurb" }, rl.summary, " ", h("a", { href: `#/lore/${rl.id}` }, "Read more →"))
           : h("p", { class: "muted race-blurb" }, "The chroniclers have not written this race up yet."),
        rHeroes.length ? h("div", { class: "grid" }, ...rHeroes.map((c) =>
          h("a", { class: "card", href: `#/characters/${c.id}` },
            h("div", { class: "thumb checker" }, h("img", { src: assetUrl(c.preview), alt: c.name, loading: "lazy" })),
            h("div", { class: "card-name" }, c.name),
            // What the hero IS, not what the folder is called.
            h("div", { class: "card-sub" }, heroKind(c)),
            state.admin ? h("div", { class: "card-sub" }, `${c.id} · ${Object.keys(c.animations).length} states`) : null,
            h("div", { class: "card-badges" }, ...entityBadge("characters", c.path))))) : null,
        npcPagedBlock(rNpcs));
    }));
}
function viewCharacter(id) {
  const c = state.data.domains.characters.find((x) => x.id === id);
  if (!c) return h("p", {}, "Unknown character.");
  const player = makePlayer(c, "character");
  activePlayers.push(player);
  const facetBox = h("div", {});
  // No "Feedback on this animation (state)" caption — same rule as monsters.
  const renderFacet = () => {
    facetBox.replaceChildren(feedbackRow("characters", `${c.path}#${player.getState()}`));
  };
  player.onStateChange = renderFacet;
  renderFacet();
  // (the old Movement-sounds panel listed catalog takes; the entity card
  //  below replaces it with the character's OWN sound events, played by the
  //  mirrored engine — maintainer 2026-08-05)
  // Paging stays INSIDE the group: ‹ › from a hero walks the heroes, from an
  // NPC walks the NPCs — 191 Villagers between Man and Woman would bury the
  // playable cast the page is foremost about. Same group feeds the lore
  // reserve, so the viewer's height is constant within what you can page to.
  const isNpc = c.kind === "npc";
  const group = state.data.domains.characters.filter((x) => (x.kind === "npc") === isNpc);
  return h("div", {},
    // Back-link names the RACE, not the section — the page reads as if it
    // sat at /races/human/<id> (maintainer 2026-08-05). It still LEADS to
    // the Races page; there is no per-race route to lead to.
    crumbRow("#/characters", `← ${c.species || label("characters")}`, "characters", group, c.id),
    h("div", { class: "detail-head" },
      // Species/sex rides under the thumbnail, exactly like a monster's level
      // chip — it balances the two columns (maintainer 2026-07-30).
      h("div", { class: "portrait-col" },
        h("div", { class: "portrait checker" }, h("img", { src: assetUrl(c.preview), alt: c.name })),
        heroKind(c) ? h("div", { class: "thumb-chip" }, heroKind(c)) : null),
      h("div", { class: "meta" },
        h("h1", {}, c.name),
        // The trade, quietly, under the name. Every NPC has one, so the line
        // is there on all 191 and paging cannot shift the viewer below it.
        c.role ? h("div", { class: "npc-trade muted" }, c.role) : null,
        // Folder id, frame size and state count are PIPELINE facts — admin
        // only (maintainer 2026-07-30). The NPC's PixelLab name is the same
        // class of fact: prompt junk a player must never meet.
        state.admin ? h("p", { class: "muted" }, `${c.id}${c.pixellabName ? ` · “${c.pixellabName}”` : ""} · ${c.frameW}×${c.frameH}px · ${Object.keys(c.animations).length} animation states`) : null,
        // Deduped: the 191 NPCs share one placeholder, and the reserve only
        // needs each DISTINCT height once, not 191 copies of the same ghost.
        loreSlot(heroLore(c), [...new Set(group.map(heroLore))]),
        feedbackRow("characters", c.path))),
    h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "Animations"),
      player.el,
      h("div", { style: "margin-top:12px" }, facetBox)),
    // The character's OWN sound events — their jump/fall voice today — with
    // the same cards, engine and admin features as the Sound Effects page.
    entitySoundsCard("characters", c),
    storyCard({ label: heroStoryTitle(c), art: refPic(c), name: c.name, paras: c.loreStory, related: c.loreRelated }));   // always last
}

/* --- tiles --- */
function viewTiles() {
  const list = state.data.domains.tiles.filter((t) => matches(state.query, t.id, t.name, t.description));
  return h("div", {},
    sectionHead("tiles"),
    h("p", { class: "muted" }, state.admin
      ? "The tiles2 ground library. Open a type to rate or remove individual tiles — rejected tiles tell the tiles agent (and the maps agent) to retire them."
      : "The ground the world is built from — every tile of every terrain type."),
    h("div", { class: "grid" }, ...list.map((t) => {
      const first = t.groups[0];
      return h("a", { class: "card", href: `#/tiles/${t.id}` },
        h("div", { class: "thumb checker" }, first ? h("img", { src: assetUrl(`${first.dir}/${first.tiles[0]}`), alt: t.name, loading: "lazy" }) : null),
        h("div", { class: "card-name" }, t.name),
        // own sheets only — foreign (incoming-transition) groups are another
        // type's art, listed on this page but never counted as this type's
        h("div", { class: "card-sub" }, `${t.tileCount} tiles · ${t.groups.filter((g) => !g.foreign).length} sheets`),
        h("div", { class: "card-badges" }, ...entityBadge("tiles", t.path)));
    })));
}
// Is this tile one of the maps agent's "clean base" palette for its type?
// (`solid` = the small set it paints regions + cliff walls with; `plain` =
// the single canonical one — see wiki/tools/clean-base.py.)
function cleanBaseRank(type, relPath) {
  const cb = type.cleanBase;
  if (!cb) return null;
  if (cb.plain === relPath) return "plain";
  if (cb.solid?.includes(relPath)) return "solid";
  return null;
}
function tileCell(type, group, file) {
  const rel = `${group.dir}/${file}`;
  const id = stripExt(rel);
  const cell = h("div", { class: "tile-cell" });
  const sync = () => {
    const e = fb("tiles", id);
    cell.classList.toggle("rejected", e.status === "rejected");
    cell.classList.toggle("approved", e.status === "approved");
  };
  const rank = cleanBaseRank(type, rel);
  const uses = tileUses(rel);
  if (!uses) cell.classList.add("unused-tile");
  // Skip null children — raw DOM append(null) renders a literal "null" text
  // node (players saw one under every tile, 2026-07-30).
  for (const c of [
    h("a", {
      href: `#/tiles/${type.id}/${encodeURIComponent(rel)}`, class: "tile-link",
      title: `${id}\n${uses ? `used ${uses.toLocaleString()}× in the world` : "unused"}`,
    }, h("img", { src: assetUrl(rel), alt: file, loading: "lazy" })),
    rank ? h("span", { class: "base-pill", title: "The maps agent paints clean ground and cliff walls with this tile" }, "clean base") : null,
    uses ? h("span", { class: "use-pill", title: `Placed ${uses.toLocaleString()}× in the world` }, `×${uses > 999 ? `${Math.round(uses / 1000)}k` : uses}`) : null,
    starsWidget("tiles", id),
    state.admin ? h("button", {
      class: "tile-x", title: "Reject this tile (toggles)",
      onclick: () => { setFb("tiles", id, { status: fb("tiles", id).status === "rejected" ? null : "rejected" }); sync(); },
    }, "✕") : null,
  ]) if (c) cell.append(c);
  sync();
  return cell;
}
function viewTileType(id) {
  const t = state.data.domains.tiles.find((x) => x.id === id);
  if (!t) return h("p", {}, "Unknown tile type.");
  const kinds = [["base", "Base tiles"], ["elevation", "Elevation objects"], ["transition", "Transitions"]];
  return h("div", {},
    crumbRow("#/tiles", `← ${label("tiles")}`, "tiles", state.data.domains.tiles, t.id),
    h("h1", {}, t.name),
    h("p", { class: "muted" }, `${t.description} · ${t.tilePx}px iso · ${t.tileCount} tiles`),
    // How much of this type the DEFAULT world actually uses.
    (() => {
      // The type's OWN tiles only — incoming (foreign) transitions belong to
      // the source type and are excluded from tileCount too.
      const all = t.groups.filter((g) => !g.foreign).flatMap((g) => g.tiles.map((f) => `${g.dir}/${f}`));
      const used = all.filter((rel) => tileUses(rel) > 0);
      const placements = used.reduce((n, rel) => n + tileUses(rel), 0);
      return h("p", { class: "muted" },
        h("span", { class: used.length ? "pill ok" : "pill warn" },
          `${used.length} of ${all.length} tiles used`),
        placements ? h("span", { class: "pill", style: "margin-left:6px" }, `${placements.toLocaleString()} placements`) : null);
    })(),
    h("div", { class: "fb-row" }, h("span", { class: "muted" }, "Whole type:"), starsWidget("tiles", t.path), verdictWidget("tiles", t.path)),
    ...kinds.map(([kind, label]) => {
      const groups = t.groups.filter((g) => g.kind === kind);
      if (!groups.length) return null;
      return h("div", {},
        h("h2", {}, label, " ", h("span", { class: "pill" }, `${groups.reduce((n, g) => n + g.tiles.length, 0)} tiles`)),
        ...groups.map((g, i) =>
          h("details", { class: "tile-group", ...(kind === "base" && i < 2 ? { open: "" } : {}) },
            h("summary", {}, `${g.label} · ${g.sheet} `, h("span", { class: "pill" }, String(g.tiles.length))),
            h("div", { class: "tile-grid" }, ...g.tiles.map((f) => tileCell(t, g, f))))));
    }));
}

/* --- tile instance (one tile, composed with the game's real iso geometry) --- */
// Draw a list of cells {c, r, lvl, img, top} onto a canvas: the WORLD_FORMAT
// projection (x=(c−r)·dx, y=(c+r)·dy − lvl·levelPx; a cell of elevation L
// stacks its tile L times, 16px apart, then draws the top). Painter order:
// back-to-front by (c+r), then by level.
/** Compose cells with the GAME's own iso geometry, at the GAME's own scale.
 *  scale is 1 on purpose: `data.iso` carries the real numbers (tile 64,
 *  dx 32 = ISO_DX, dy 15 = ISO_DY), so one art pixel is one CSS pixel and a
 *  3×3 field here measures what a 3×3 patch measures in the world. Drawing
 *  at 2 made every scene twice the size the game shows (maintainer
 *  2026-07-31) — and pushed the wider scenes past the column, where
 *  `max-width:100%` then RESAMPLED the pixel art by a fraction. */
/** [a, b] -> [a, divider, b]; a lone cell is left alone. */
const withDivider = (cells) => (cells.length > 1 ? [cells[0], h("div", { class: "pair-div" }), cells[1]] : cells);
function isoScene(cells, images, scale = 1, pad = 4) {
  const iso = state.data.iso ?? { tilePx: 64, dx: 32, dy: 15, levelPx: 16 };
  const draws = [];
  for (const cell of cells) {
    const lvl = cell.lvl ?? 0;
    // `stack[i]` overrides the tile drawn at face level i (the game stacks
    // ONE tile per level) — that's how a tile can sit mid-wall with a
    // different tile above AND below it.
    for (let i = 0; i < lvl; i++) draws.push({ ...cell, z: i, img: cell.stack?.[i] ?? cell.img });
    draws.push({ ...cell, z: lvl, img: cell.top ?? cell.img });
  }
  draws.sort((a, b) => (a.c + a.r) - (b.c + b.r) || a.r - b.r || a.z - b.z);
  const px = (d) => (d.c - d.r) * iso.dx - iso.tilePx / 2;
  const py = (d) => (d.c + d.r) * iso.dy - d.z * iso.levelPx - iso.dy;
  const minX = Math.min(...draws.map(px)), maxX = Math.max(...draws.map((d) => px(d) + iso.tilePx));
  const minY = Math.min(...draws.map(py)), maxY = Math.max(...draws.map((d) => py(d) + iso.tilePx));
  const canvas = h("canvas", {
    width: (maxX - minX + pad * 2) * scale,
    height: (maxY - minY + pad * 2) * scale,
    class: "iso-canvas",
  });
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  for (const d of draws) {
    const im = images[d.img];
    if (!im) continue;
    ctx.drawImage(im, (px(d) - minX + pad) * scale, (py(d) - minY + pad) * scale, iso.tilePx * scale, iso.tilePx * scale);
  }
  return canvas;
}
function loadImages(paths, cb) {
  // Count UNIQUE paths — the viewed tile can BE the clean base (T === B),
  // and a duplicate-based countdown would then never reach zero.
  const uniq = [...new Set(paths)];
  const out = {};
  let left = uniq.length;
  if (!left) { cb(out); return; }
  for (const p of uniq) {
    const im = new Image();
    im.onload = im.onerror = () => { out[p] = im.naturalWidth ? im : null; if (--left <= 0) cb(out); };
    im.src = assetUrl(p);
  }
}
function viewTileInstance(typeId, rel) {
  const t = state.data.domains.tiles.find((x) => x.id === typeId);
  if (!t) return h("p", {}, "Unknown tile type.");
  const all = t.groups.flatMap((g) => g.tiles.map((f) => ({ id: encodeURIComponent(`${g.dir}/${f}`), name: f, rel: `${g.dir}/${f}`, group: g })));
  const cur = all.find((x) => x.rel === rel);
  if (!cur) return h("p", {}, "Unknown tile.");
  const id = stripExt(rel);
  const plain = t.cleanBase?.plain ?? rel; // no classification → self-surround
  const rank = cleanBaseRank(t, rel);

  // The five composition scenes (maintainer 2026-07-30): clean-ground
  // surround, self surround, self stack (cliff), and the tile mid-wall with
  // clean-base flanks — both wall faces.
  const T = rel, B = plain;
  const grid3 = (centre, ring) => [
    ...[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => ({ c, r, img: c === 1 && r === 1 ? centre : ring }))),
  ];
  // Cliff corner: the front stack plus one arm up-left (c−1) and one
  // up-right (r−1) on screen — three 3-high stacks meeting in a V.
  const vCliff = [{ c: 1, r: 1 }, { c: 0, r: 1 }, { c: 1, r: 0 }]
    .map((p) => ({ ...p, lvl: 2, img: T, top: T }));
  // Mid-wall: 3 cells along the run × 3 face levels, the tile dead centre so
  // clean base sits above, below, both sides and on every diagonal.
  const wallStack = (mid) => (mid ? [B, T, B] : [B, B, B]);
  // Copy is short on purpose: two scenes share a row, so each caption gets
  // half the column (maintainer 2026-07-31).
  const scenes = [
    ["On clean ground", "Surrounded by the clean base — open terrain.", grid3(T, B)],
    ["Tiled with itself", "Only this tile — repetition and seams.", grid3(T, T)],
    ["Stacked — a cliff of itself", "Three 3-high stacks meeting at a corner.", vCliff],
    ["In a wall — face ↘", "Wall running down-right, the tile dead centre.", [0, 1, 2].map((c) => ({ c, r: 0, lvl: 3, img: B, stack: wallStack(c === 1), top: B }))],
    ["In a wall — face ↙", "The same wall running down-left.", [0, 1, 2].map((r) => ({ c: 0, r, lvl: 3, img: B, stack: wallStack(r === 1), top: B }))],
  ];
  // TWO SCENES PER ROW, sharing one chessboard (maintainer 2026-07-31: "we
  // can reuse the same chessbox to draw both examples ... this way we can
  // click next next next and see more on the same screen"). Pairs are chosen
  // so the two halves belong together — the two flat fields, then the two
  // wall faces — with the cliff standing alone between them.
  const PAIRS = [[0, 1], [2], [3, 4]];
  const sceneBox = h("div", { class: "iso-scenes" }, ...PAIRS.map((pair) =>
    h("div", { class: `iso-scene${pair.length > 1 ? " paired" : ""}` },
      // The divider is its own 1px GRID COLUMN, not a border on one cell —
      // a border would make the right half 1px + its padding narrower, and
      // these halves have to hold a 192px canvas each with nothing to spare.
      h("div", { class: "pair-row heads" }, ...withDivider(pair.map((i) => h("div", { class: "pair-cell" },
        h("div", { class: "panel-title" }, scenes[i][0]),
        h("p", { class: "muted iso-hint" }, scenes[i][1]))))),
      h("div", { class: "pair-row iso-stage checker" }, ...withDivider(pair.map((i) =>
        h("div", { class: "pair-cell stage-cell", "data-scene": String(i) },
          h("span", { class: "muted" }, "rendering…"))))))));
  loadImages([T, B], (imgs) => {
    // pad 0 on a shared row: the built-in 4px margin each side is what would
    // push two 3x3 fields (200px each) past a phone column, and trimming
    // transparent padding is free — unlike scaling, which resamples the art.
    for (const cell of sceneBox.querySelectorAll(".stage-cell")) {
      const i = Number(cell.dataset.scene);
      const paired = cell.parentElement.children.length > 1;
      cell.replaceChildren(isoScene(scenes[i][2], imgs, 1, paired ? 0 : 4));
    }
  });

  return h("div", {},
    crumbRow(`#/tiles/${t.id}`, `← ${t.name}`, `tiles/${t.id}`, all, cur.id),
    h("div", { class: "detail-head" },
      h("div", { class: "portrait checker tile-portrait" }, h("img", { src: assetUrl(rel), alt: cur.name })),
      h("div", { class: "meta" },
        h("h1", {}, stripExt(cur.name)),
        // ONE row of pills, not two stacked lines: a clean-base tile carries
        // an extra pill, and stacking made its header taller than an
        // ordinary tile's — so paging shifted the page (maintainer
        // 2026-07-31). The type name is already in the back-link above and
        // on the thumbnail; the group label is what the first pill says.
        h("div", { class: "pill-row" },
          rank ? h("span", { class: "pill ok", title: rank === "plain" ? `THE canonical clean tile of ${t.name}` : "In the maps agent's clean-base palette" }, cur.group.label) : null,
          (() => {
            const uses = tileUses(rel);
            return uses
              ? h("span", { class: "pill ok" }, `used ${uses.toLocaleString()}× ${uses === 1 ? "time" : "times"}`)
              : h("span", { class: "pill warn", title: "No cell or prop in the world uses this tile" }, "unused");
          })()),
        // Sheet id and file path are pipeline facts — admin only.
        state.admin ? h("p", { class: "muted" }, `${cur.group.label} · ${cur.group.sheet}`, " ", h("code", {}, id)) : null,
        feedbackRow("tiles", id))),
    sceneBox);
}

/* --- objects --- */
function viewObjects() {
  const list = state.data.domains.objects.filter((o) => matches(state.query, o.id, o.name, o.category, o.description));
  const cats = [...new Set(list.map((o) => o.category))].sort();
  return h("div", {},
    sectionHead("objects"),
    h("p", { class: "muted" }, "The scenery of the world — animated props and map objects."),
    ...cats.map((cat) => h("div", {},
      h("h2", {}, cat),
      h("div", { class: "grid" }, ...list.filter((o) => o.category === cat).map((o) =>
        h("a", { class: "card", href: `#/objects/${o.id}` },
          h("div", { class: "thumb checker" }, h("img", { src: assetUrl(o.preview), alt: o.name, loading: "lazy" })),
          h("div", { class: "card-name" }, o.name),
          h("div", { class: "card-sub" }, `${Object.keys(o.animations).length ? Object.keys(o.animations).join(", ") : "static"}`),
          h("div", { class: "card-badges" }, ...entityBadge("objects", o.path))))))));
}
function viewObject(id) {
  const o = state.data.domains.objects.find((x) => x.id === id);
  if (!o) return h("p", {}, "Unknown object.");
  const hasAnims = Object.keys(o.animations).length > 0;
  let playerEl = null;
  if (hasAnims) {
    const player = makePlayer(o, "object");
    activePlayers.push(player);
    playerEl = player.el;
  }
  return h("div", {},
    crumbRow("#/objects", `← ${label("objects")}`, "objects", state.data.domains.objects, o.id),
    h("div", { class: "detail-head" },
      h("div", { class: "portrait checker" }, h("img", { src: assetUrl(o.preview), alt: o.name })),
      h("div", { class: "meta" },
        h("h1", {}, o.name),
        loreSlot(objectBlurb(o), state.data.domains.objects.map(objectBlurb)),
        feedbackRow("objects", o.path))),
    hasAnims ? h("div", { class: "panel" }, h("div", { class: "panel-title" }, "Animations"), playerEl) : h("p", { class: "muted" }, "No animations."),
    entitySoundsCard("objects", o),
    storyCard({ label: "The story", art: refPic(o), name: o.name, paras: o.loreStory, related: o.loreRelated }));   // always last
}

/* --- sounds --- */
// Temporarily silence the RUNNING GAME while auditioning wiki audio
// (maintainer 2026-07-30). Only meaningful inside the game's wiki drawer —
// the parent (wikipanel.ts) flips gameAudio and RESTORES the player's real
// settings when the drawer closes, so this is never a persistent choice.
/* --- the game's SOUND ENGINE, mirrored -------------------------------------
   Playing a sound event here must sound EXACTLY like it does in the game
   (maintainer 2026-08-05), so this is a faithful mirror of the composer's
   one-shot player — games2/composer/engine/oneshot.ts — using the SAME data
   (the catalog, the composer's foley sets, and the engine constants build.mjs
   reads out of the composer's own source, drift-guarded):

   - take pick: round-robin, never the same take twice (oneshot.pickTake);
     "primary take only" where the composer pins one (pure-mode/EVENT_FOLEY).
   - pitch: 2^(semis/12) × the layer's rate. The jitter ranges in data.json
     are ALREADY scaled by the engine's gentleness factor (×0.35) at build.
   - gain: mix_gain_db + event trim + the bus fader, ± gentled gain jitter.
   - per-layer lowpass (grass's hi-hat shave), 30 ms retrigger debounce.
   - NOT mirrored, honestly: scale-snap (needs the running score), pan and
     distance (needs a world position), beat quantize. Those apply on top in
     the game; everything the maintainer tunes per sound is identical here.

   BufferSource, never HTMLAudio: an <audio> el pitch-PRESERVES on rate
   change by default — 2× would speed a voice up without raising it, which is
   exactly the wrong sound for the half-speed-authored vocal takes. */
const sfxPlays = [];                                // test/debug: what actually played
window.__sfxPlays = sfxPlays;
const sfxEngine = {
  ctx: null, buffers: new Map(), lastTake: new Map(), lastAt: new Map(),
  ac() { return (this.ctx ??= new (window.AudioContext || window.webkitAudioContext)()); },
  async buffer(rel) {
    if (this.buffers.has(rel)) return this.buffers.get(rel);
    const p = fetch(assetUrl(rel)).then((r) => r.arrayBuffer()).then((b) => this.ac().decodeAudioData(b)).catch(() => null);
    this.buffers.set(rel, p);
    return p;
  },
  pickTake(key, takes, primaryOnly) {
    if (primaryOnly || takes.length === 1) return 0;
    const last = this.lastTake.get(key) ?? -1;
    let idx = Math.floor(Math.random() * takes.length);
    if (idx === last) idx = (idx + 1) % takes.length;   // oneshot.pickFrom, verbatim
    this.lastTake.set(key, idx);
    return idx;
  },
  /** One LAYER of an event, with the engine's whole chain. */
  async playLayer(layer, over = {}) {
    const eng = state.data.sfx?.engine ?? {};
    const key = layer.set ?? layer.soundId;
    const now = performance.now();
    if (now - (this.lastAt.get(key) ?? -1e9) < (eng.debounceMs ?? 30)) return;  // oneshot.play debounce
    this.lastAt.set(key, now);
    const idx = this.pickTake(key, layer.takes, /primary/.test(layer.pick ?? ""));
    const take = layer.takes[idx];
    const buf = await this.buffer(take.file);
    if (!buf) { toast(`Could not load ${take.name}`); return; }
    const ctx = this.ac();
    const rand = (a, b) => a + Math.random() * (b - a);
    const semis = layer.jitterSemis ? rand(layer.jitterSemis[0], layer.jitterSemis[1]) : 0;
    const rate = Math.pow(2, semis / 12) * (layer.rate ?? 1) * (over.rate ?? 1);
    let db = (layer.mixGainDb ?? 0) + (layer.trimDb ?? 0) + (eng.busDb?.[layer.bus] ?? 0) + (over.gainDb ?? 0);
    if (layer.gainJitterDb) db += rand(layer.gainJitterDb[0], layer.gainJitterDb[1]);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    let head = src;
    if (layer.lowpassHz) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = layer.lowpassHz;
      head.connect(lp); head = lp;
    }
    const g = ctx.createGain();
    g.gain.value = Math.pow(10, db / 20);           // catalog.dbToGain
    head.connect(g); g.connect(ctx.destination);
    src.start();
    sfxPlays.push({ file: take.file, rate: +rate.toFixed(4), db: +db.toFixed(2), lowpassHz: layer.lowpassHz ?? null });
  },
  /** The whole EVENT: every layer at once — that is what the game does
   *  (grass footstep = the grass set AND dirt underneath, same instant). */
  playEvent(ev) { for (const l of ev.sounds) void this.playLayer(l); },
  /** The admin's all-sounds list: raw file, or the audition sliders. */
  async rawOrAudition(file, { rate = 1, gainDb = 0, maxSemis = 0 } = {}) {
    const buf = await this.buffer(file);
    if (!buf) { toast("Could not load the take"); return; }
    const ctx = this.ac();
    const semis = maxSemis ? (Math.random() * 2 - 1) * maxSemis : 0;
    const r = rate * Math.pow(2, semis / 12);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.playbackRate.value = r;
    const g = ctx.createGain();
    g.gain.value = Math.pow(10, gainDb / 20);
    src.connect(g); g.connect(ctx.destination);
    src.start();
    sfxPlays.push({ file, rate: +r.toFixed(4), db: +gainDb.toFixed(2), lowpassHz: null, raw: true });
  },
};

// A full-page wiki tab has no game to mute → no button.
let gameMuted = false;
function muteGameBtn() {
  if (window.parent === window) return null;
  const btn = h("button", { class: "ghost-btn mute-game" });
  const render = () => { btn.textContent = gameMuted ? "🔊 Unmute the game" : "🔇 Mute the game while listening"; };
  btn.addEventListener("click", () => {
    gameMuted = !gameMuted;
    window.parent.postMessage({ type: "wiki:muteGame", on: gameMuted }, location.origin);
    render();
  });
  render();
  return btn;
}
/* --- Sound Effects, organized by IN-GAME EVENT (maintainer 2026-08-05) ----
   The unit is the EVENT that triggers sound — "Footsteps · Grass", "Jump" —
   not the audio file. An event can layer several sounds at once (grass +
   dirt underneath) or alternate takes; ▶ on the event plays exactly what
   the game plays, ▶ on a row plays that one sound alone, both through the
   mirrored engine above. Players see only events that make sound; the
   silent events, the stars, the add-a-sound requests and the raw all-sounds
   list at the bottom are the Game Master's. */
const stFmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0$/, ""));
function sfxTakeFb(layer, take) {
  // Stars flow to the agent that OWNS the take: catalog takes to the sounds
  // agent (the ids it already consumes), composer takes to the composer.
  if (layer.source === "composer") return ["composer", take.file.replace(/\.\w+$/, "")];
  return ["sounds", take.file.replace(/\.\w+$/, "")];
}
function sfxLayerRow(ev, layer) {
  const totalDb = (layer.mixGainDb ?? 0) + (layer.trimDb ?? 0) + (state.data.sfx.engine.busDb?.[layer.bus] ?? 0);
  const jit = layer.jitterSemis;
  const jitTxt = jit ? (Math.abs(jit[0]) === Math.abs(jit[1]) ? `±${stFmt(Math.abs(jit[1]))} st` : `${stFmt(jit[0])}…${stFmt(jit[1])} st`) : null;
  const n = layer.takes.length;
  const rows = [
    h("div", { class: "sfx-layer-head" },
      h("button", { class: "play-btn", "aria-label": "play this sound alone", onclick: () => void sfxEngine.playLayer(layer) }, "▶"),
      h("span", { class: "take-name" }, layer.label),
      layer.voiceRate ? h("span", { class: "pill ok", title: "The vocal takes are authored at half speed — 2× is the true voice" }, `voice ×${stFmt(layer.voiceRate)}`) : null,
      layer.rate !== 1 && !layer.voiceRate ? h("span", { class: "pill", title: "playbackRate — pitch and speed together" }, `pitch ×${stFmt(layer.rate)}`) : null,
      h("span", { class: "pill", title: `mix ${stFmt(layer.mixGainDb ?? 0)} dB + event ${stFmt(layer.trimDb ?? 0)} dB + ${layer.bus} bus ${stFmt(state.data.sfx.engine.busDb?.[layer.bus] ?? 0)} dB` }, `${totalDb > 0 ? "+" : ""}${stFmt(totalDb)} dB`),
      jitTxt ? h("span", { class: "pill", title: "Random pitch on every play (already scaled by the engine's gentleness ×0.35)" }, `pitch jitter ${jitTxt}`) : null,
      layer.gainJitterDb ? h("span", { class: "pill", title: "Random volume on every play (gentled)" }, `vol ±${stFmt(Math.abs(layer.gainJitterDb[1]))} dB`) : null,
      layer.lowpassHz ? h("span", { class: "pill", title: "Fixed tone shaping" }, `lowpass ${layer.lowpassHz} Hz`) : null,
      // One sound is one sound (maintainer 2026-08-05/06): the engine BINDS
      // exactly what it plays, so `takes` is the whole truth — a single-take
      // layer with spare recordings means the set's other takes are unbound
      // and live only in the admin's All sounds library.
      h("span", { class: "pill muted-pill", title: n > 1
          ? "Each play picks a take at random, never the same one twice in a row"
          : layer.spareTakes ? `The one bound recording; the ${layer.spareTakes} other recording(s) of this set are unbound (see All sounds)`
          : "One recording" },
        n === 1 ? "1 take" : `${n} takes · equal 1/${n}`),
      layer.layerNote ? h("span", { class: "pill", title: layer.layerNote }, "layer") : null),
  ];
  for (const t of layer.takes) {
    const [dom, fid] = sfxTakeFb(layer, t);
    rows.push(h("div", { class: "take-row sfx-take" },
      h("button", { class: "play-btn", "aria-label": "play take", onclick: () => void sfxEngine.playLayer({ ...layer, takes: [t], pick: "primary take only" }) }, "▶"),
      h("span", { class: "take-name muted" }, t.name),
      t.dur ? h("span", { class: "pill" }, `${stFmt(t.dur)}s`) : null,
      h("span", { class: "spacer" }),
      state.admin ? starsWidget(dom, fid) : null,
      state.admin ? verdictWidget(dom, fid) : null));
  }
  if (layer.spareTakes > 0 && state.admin) {
    rows.push(h("p", { class: "muted sfx-unbound-note" },
      `${layer.spareTakes} more recording(s) of this set exist, unbound to any event — audition them under All sounds.`));
  }
  return h("div", { class: "sfx-layer" }, ...rows);
}
function setSfxRequest(id, val) {
  const doc = state.tuning.sfx_requests ?? (state.tuning.sfx_requests = { format: "pixel-wiki-sfx-requests@1", updated_at: "", requests: {} });
  if (val === null) delete doc.requests[id];
  else doc.requests[id] = val;
  doc.updated_at = new Date().toISOString();
  touch("tuning/sfx_requests", id);
  markDirty("tuning/sfx_requests");
}
function sfxAddForm(ev) {
  const opts = [
    ...state.data.domains.sounds.map((s) => h("option", { value: `cat:${s.id}` }, `${s.name} (catalog)`)),
    ...Object.keys(state.data.sfx.composerSets).map((set) => h("option", { value: `set:${set}` }, `${set} (composer)`)),
  ];
  const sel = h("select", { class: "sfx-pick" }, ...opts);
  const num = (val, min, max, step, title) => h("input", { type: "number", value: String(val), min: String(min), max: String(max), step: String(step), title, class: "sfx-num" });
  const pitch = num(1, 0.25, 4, 0.05, "pitch (playbackRate)");
  const vol = num(0, -24, 12, 1, "volume trim, dB");
  const rnd = num(0, 0, 6, 0.1, "max random pitch, semitones");
  const note = h("input", { type: "text", placeholder: "note to the composer (optional)", class: "sfx-note" });
  const btn = h("button", { class: "ghost-btn", onclick: () => {
    const id = `${ev.id}/${Date.now().toString(36)}`;
    setSfxRequest(id, {
      event: ev.id, sound: sel.value.replace(/^cat:/, "").replace(/^set:/, "composer/"),
      pitch: Number(pitch.value) || 1, volume_db: Number(vol.value) || 0,
      max_random_pitch_semis: Number(rnd.value) || 0,
      note: note.value.trim() || undefined, requested_at: new Date().toISOString(),
    });
    toast("Request queued — Save sends it to the composer.");
    route();
  } }, "Request this sound");
  return h("div", { class: "sfx-add" },
    h("div", { class: "muted", style: "font-size:12.5px" }, "Add a sound to this event — the composer agent wires it in:"),
    h("div", { class: "sfx-add-row" }, sel,
      h("label", { class: "muted" }, "pitch ", pitch),
      h("label", { class: "muted" }, "vol dB ", vol),
      h("label", { class: "muted" }, "±pitch ", rnd)),
    h("div", { class: "sfx-add-row" }, note, btn));
}
function sfxEventCard(ev) {
  const reqs = state.admin ? Object.entries(state.tuning.sfx_requests?.requests ?? {}).filter(([, r]) => r?.event === ev.id) : [];
  return h("div", { class: "panel sfx-event" },
    h("div", { class: "panel-title" },
      ev.sounds.length ? h("button", { class: "play-btn play-event", "aria-label": "play the event as the game plays it",
        onclick: () => sfxEngine.playEvent(ev) }, "▶") : null,
      ev.name,
      state.admin ? h("span", { class: "pill" }, ev.id) : null,
      state.admin ? h("span", { class: "pill" }, `${ev.bus} bus`) : null,
      ev.duck ? h("span", { class: "pill", title: "The music dips while this plays" }, "ducks music") : null,
      ev.sounds.length > 1 ? h("span", { class: "pill ok", title: "All of these play at the same time" }, `${ev.sounds.length} layered`) : null,
      !ev.sounds.length ? h("span", { class: "pill warn" }, "no sound yet") : null,
      state.admin && ev.bound && !ev.emitted ? h("span", { class: "pill", title: "Wired to a sound, but no game code fires this event yet" }, "not fired yet") : null),
    ev.note ? h("p", { class: "muted", style: "margin:0 0 6px" }, ev.note) : null,
    ...ev.sounds.map((l) => sfxLayerRow(ev, l)),
    ...reqs.map(([id, r]) => h("div", { class: "take-row sfx-req" },
      h("span", { class: "pill warn" }, "requested"),
      h("span", { class: "take-name" }, `${r.sound} · pitch ×${stFmt(r.pitch ?? 1)} · ${stFmt(r.volume_db ?? 0)} dB · ±${stFmt(r.max_random_pitch_semis ?? 0)} st${r.note ? ` — ${r.note}` : ""}`),
      h("span", { class: "spacer" }),
      h("button", { class: "x-btn", title: "withdraw this request", onclick: () => { setSfxRequest(id, null); route(); } }, "✕"))),
    state.admin ? sfxAddForm(ev) : null);
}
/** The Game Master's raw library: EVERY take, used or not, played raw —
 *  except voices, whose honest raw is 2× (authored at half speed) — with
 *  audition sliders for pitch / volume / max random pitch. */
function sfxAllSounds() {
  const rows = [];
  const slider = (min, max, step, val, unit, title) => {
    const out = h("code", { class: "sfx-val" }, `${stFmt(val)}${unit}`);
    const inp = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(val), title });
    inp.addEventListener("input", () => { out.textContent = `${stFmt(Number(inp.value))}${unit}`; });
    return { inp, out, get: () => Number(inp.value) };
  };
  const entryRow = (name, sub, takes, { voice = false, usedBy = [] } = {}) => {
    const pitch = slider(0.25, 4, 0.05, voice ? 2 : 1, "×", "pitch");
    const vol = slider(-24, 12, 1, 0, " dB", "volume");
    const rnd = slider(0, 6, 0.1, 0, " st", "max random pitch");
    rows.push(h("div", { class: "sfx-lib-row" },
      h("div", { class: "sfx-lib-head" },
        h("span", { class: "take-name" }, name),
        h("span", { class: "pill" }, sub),
        voice ? h("span", { class: "pill ok", title: "Vocal takes are authored at half speed — raw playback is 2×" }, "voice · raw ×2") : null,
        usedBy.length
          ? h("span", { class: "pill ok", title: usedBy.join(", ") }, `used · ${usedBy.length} event${usedBy.length > 1 ? "s" : ""}`)
          : h("span", { class: "pill warn", title: "No event or routing references this — auditionable, not played by the game" }, "unused")),
      h("div", { class: "sfx-lib-ctl" },
        h("label", { class: "muted" }, "pitch ", pitch.inp, pitch.out),
        h("label", { class: "muted" }, "vol ", vol.inp, vol.out),
        h("label", { class: "muted" }, "±pitch ", rnd.inp, rnd.out)),
      ...takes.map((t) => h("div", { class: "take-row sfx-take" },
        h("button", { class: "play-btn", "aria-label": "play raw with the sliders", onclick: () =>
          void sfxEngine.rawOrAudition(t.file, { rate: pitch.get(), gainDb: vol.get(), maxSemis: rnd.get() }) }, "▶"),
        h("span", { class: "take-name muted" }, t.name),
        h("span", { class: "spacer" }),
        starsWidget(t.dom, t.fid), verdictWidget(t.dom, t.fid)))));
  };
  for (const s of state.data.domains.sounds) {
    entryRow(s.name, s.category, s.takes.map((t) => ({
      name: t.id, file: t.files.m4a ?? t.files.ogg ?? t.files.wav,
      dom: "sounds", fid: `${s.path}/${t.id}`.replace(/\.\w+$/, ""),
    })), { usedBy: s.usedBy ?? [] });
  }
  for (const [set, cs] of Object.entries(state.data.sfx.composerSets)) {
    entryRow(set, "composer", cs.takes.map((t) => ({
      name: t.name, file: t.file,
      dom: "composer", fid: t.file.replace(/\.\w+$/, ""),
    })), { voice: cs.voice, usedBy: cs.usedBy ?? [] });
  }
  return h("div", { class: "sfx-lib" },
    h("h2", {}, "All sounds ", h("span", { class: "pill" }, "Game Master")),
    h("p", { class: "muted" }, "Every recording in the library, used or not, played raw — voices at their honest 2×. The sliders audition pitch, volume and a max random pitch without touching the game."),
    ...rows);
}
/* --- an ENTITY's sounds: the same cards, the same engine, the same admin
   features as the Sound Effects page — scoped to the one entity (maintainer
   2026-08-05). A hero shows their Jump and Fall (their OWN voice, routed by
   character in the game); a monster or prop with no sound yet shows nothing
   to players and an assign card to the Game Master. */
function entityAddCard(domain, ent) {
  const actions = Object.keys(ent.animations ?? {});
  if (!actions.length) return null;
  const evId = () => `${domain}.${ent.id}.${act.value}`;
  const act = h("select", { class: "sfx-pick" }, ...actions.map((a2) => h("option", { value: a2 }, stateLabel(a2))));
  const sel = h("select", { class: "sfx-pick" },
    ...state.data.domains.sounds.map((s2) => h("option", { value: `cat:${s2.id}` }, `${s2.name} (catalog)`)),
    ...Object.keys(state.data.sfx.composerSets).map((set) => h("option", { value: `set:${set}` }, `${set} (composer)`)));
  const num = (val, min, max, step, title) => h("input", { type: "number", value: String(val), min: String(min), max: String(max), step: String(step), title, class: "sfx-num" });
  const pitch = num(1, 0.25, 4, 0.05, "pitch (playbackRate)");
  const vol = num(0, -24, 12, 1, "volume trim, dB");
  const rnd = num(0, 0, 6, 0.1, "max random pitch, semitones");
  const note = h("input", { type: "text", placeholder: "note to the composer (optional)", class: "sfx-note" });
  const btn = h("button", { class: "ghost-btn", onclick: () => {
    setSfxRequest(`${evId()}/${Date.now().toString(36)}`, {
      event: evId(), scope: { domain, id: ent.id }, action: act.value,
      sound: sel.value.replace(/^cat:/, "").replace(/^set:/, "composer/"),
      pitch: Number(pitch.value) || 1, volume_db: Number(vol.value) || 0,
      max_random_pitch_semis: Number(rnd.value) || 0,
      note: note.value.trim() || undefined, requested_at: new Date().toISOString(),
    });
    toast("Request queued — Save sends it to the composer.");
    route();
  } }, "Request this sound");
  const pending = Object.entries(state.tuning.sfx_requests?.requests ?? {})
    .filter(([, r]) => r?.scope?.domain === domain && r?.scope?.id === ent.id);
  return h("div", { class: "panel sfx-entity-add" },
    h("div", { class: "panel-title" }, "Assign a sound ", h("span", { class: "pill" }, "Game Master")),
    h("p", { class: "muted", style: "margin:0 0 6px" }, "Pick one of this page's game actions and the sound it should play — the composer agent wires it into the engine."),
    h("div", { class: "sfx-add-row" }, h("label", { class: "muted" }, "action ", act), sel),
    h("div", { class: "sfx-add-row" },
      h("label", { class: "muted" }, "pitch ", pitch),
      h("label", { class: "muted" }, "vol dB ", vol),
      h("label", { class: "muted" }, "±pitch ", rnd)),
    h("div", { class: "sfx-add-row" }, note, btn),
    ...pending.map(([id, r]) => h("div", { class: "take-row sfx-req" },
      h("span", { class: "pill warn" }, "requested"),
      h("span", { class: "take-name" }, `${stateLabel(r.action ?? "")}: ${r.sound} · pitch ×${stFmt(r.pitch ?? 1)} · ${stFmt(r.volume_db ?? 0)} dB · ±${stFmt(r.max_random_pitch_semis ?? 0)} st${r.note ? ` — ${r.note}` : ""}`),
      h("span", { class: "spacer" }),
      h("button", { class: "x-btn", title: "withdraw this request", onclick: () => { setSfxRequest(id, null); route(); } }, "✕"))));
}
function entitySoundsCard(domain, ent) {
  const evs = (state.data.sfx?.events ?? [])
    .filter((e) => e.scope && e.scope.domain === domain && e.scope.id === ent.id)
    .filter((e) => state.admin || (e.sounds.length && e.emitted));
  const kids = evs.map((e) => sfxEventCard(e));
  if (state.admin) { const add = entityAddCard(domain, ent); if (add) kids.push(add); }
  if (!kids.length) return null;
  return h("div", { class: "sfx-entity" }, ...kids);
}
function viewSounds() {
  const q = state.query;
  const sfx = state.data.sfx;
  if (!sfx?.events?.length) return h("div", {}, sectionHead("sounds"), h("p", { class: "muted" }, "No sound-event table in this build."));
  // Entity-SCOPED events (a hero's jump, one day a monster's roar) live on
  // that entity's page, not here — this page is the GENERIC soundscape.
  let events = sfx.events.filter((e) => !e.scope)
    .filter((e) => matches(q, e.id, e.name, e.group, ...e.sounds.map((l) => l.label)));
  // Players hear what IS IN THE GAME: an event must have a sound AND be fired
  // by game code. Wired-but-never-fired bindings (chest_open, potions…) were
  // audible here before — "sounds I have never heard inside the game"
  // (maintainer 2026-08-05). The admin keeps seeing everything, flagged.
  if (!state.admin) events = events.filter((e) => e.sounds.length && e.emitted);
  const groups = [...new Set(events.map((e) => e.group))];
  const ORDER = ["Movement", "Interface", "Items", "Tools", "Combat", "Progress", "World", "Weather", "Ambience", "System"];
  groups.sort((a, b) => (ORDER.indexOf(a) + 99 * (ORDER.indexOf(a) < 0)) - (ORDER.indexOf(b) + 99 * (ORDER.indexOf(b) < 0)));
  return h("div", {},
    sectionHead("sounds"),
    h("p", { class: "muted" }, state.admin
      ? "Every in-game sound EVENT: ▶ plays it exactly as the game does (same engine, same processing). Rate takes, withdraw or file add-a-sound requests, and audition the raw library at the bottom."
      : "What the world sounds like, by the moment that triggers it — ▶ plays it exactly as it plays in the game."),
    muteGameBtn(),
    ...groups.map((g) => h("div", {},
      h("h2", {}, g, " ", h("span", { class: "pill" }, String(events.filter((e) => e.group === g).length))),
      ...events.filter((e) => e.group === g).map((e) => sfxEventCard(e)))),
    state.admin ? sfxAllSounds() : null);
}

/* --- music --- */
function viewMusic() {
  const list = state.data.domains.music.filter((t) => matches(state.query, t.id, t.name, t.use));
  return h("div", {},
    sectionHead("music"),
    h("p", { class: "muted" }, "The score, from the music agent."),
    muteGameBtn(),
    ...list.map((t) =>
      h("div", { class: "panel" },
        h("div", { class: "panel-title" }, t.name,
          h("span", { class: "pill" }, fmtDur(t.duration_s)),
          t.bpm ? h("span", { class: "pill" }, `${t.bpm} bpm`) : null,
          t.key ? h("span", { class: "pill" }, `${t.key.root} ${String(t.key.mode).replace(/_/g, " ")}`) : null,
          t.loopable ? h("span", { class: "pill" }, "loopable") : null,
          usePill(t.usedBy, "The score's director picks one catalog track as the background bed — this one isn't it")),
        h("p", { class: "muted", style: "margin:0 0 8px" }, t.use),
        t.feeling?.length ? h("p", { class: "muted", style: "margin:0 0 8px" }, "feels: ", t.feeling.join(" · ")) : null,
        // Feedback id = the audio file's repo path sans extension (the
        // README contract), not meta.id — they can diverge.
        takeRow("music", t.files.wav.split("/").slice(0, -1).join("/"),
          { id: t.files.wav.split("/").pop().replace(/\.wav$/, ""), chosen: true, files: t.files }))));
}

/* --- items --- */
/** Every item that carries a usable id, normalised. Foreign data: never
 *  produce a feedback key of "undefined". Ordered by type (the items agent's
 *  own table order), then by what it is worth, so a page opens on the
 *  headline loot rather than on whatever sorted first alphabetically. */
function itemOrder() {
  const typeRank = Object.keys(state.data.itemTypes ?? {});
  return (state.data.domains.items ?? [])
    .filter((it) => it && (it.path || it.id))
    .map((it) => ({ ...it, path: it.path ?? `items/${it.id}`, name: it.name ?? it.id }))
    .sort((a, b) => (typeRank.indexOf(a.type) - typeRank.indexOf(b.type))
      || (Number(b.value) || 0) - (Number(a.value) || 0)
      || String(a.name).localeCompare(String(b.name)));
}
/** A soul stone's display name is the same for all of them, so it is always
 *  followed by its creature — in the nav counter, in search hits, anywhere. */
const itemLabel = (it) => {
  if (!oneToOne(it)) return it.name;
  const src = itemSources(it);
  return src.length === 1 ? `${it.name} — ${monsterById(src[0].monster)?.name ?? src[0].monster}` : `${it.name} — unbound`;
};
const itemBlurb = (it) => it.loreDesc ?? it.description ?? "";
// The Items browser's own view state: which type, and how it is sorted.
// Kept across renders so coming back from an item keeps your place.
const itemView = { type: "", sort: "value", dir: -1 };
function viewItems() {
  const all = itemOrder();
  if (!all.length) {
    return h("div", {}, sectionHead("items"),
      h("div", { class: "panel" },
        h("div", { class: "panel-title" }, "No items yet"),
        h("p", { class: "muted" }, "Nothing has been forged yet — loot appears here as it is made.")));
  }
  // Only offer types that actually HAVE items — five of the seven are
  // contracted with no art yet, and an empty filter is a dead end.
  const present = Object.keys(state.data.itemTypes ?? {}).filter((t) => all.some((it) => it.type === t));
  if (itemView.type && !present.includes(itemView.type)) itemView.type = "";
  const list = all
    .filter((it) => !itemView.type || it.type === itemView.type)
    .filter((it) => matches(state.query, it.id, it.name, it.description, it.category, it.rarity, itemLabel(it)))
    .sort((a, b) => itemView.dir * (itemView.sort === "name"
      ? String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id))
      : (Number(a.value) || 0) - (Number(b.value) || 0) || String(a.name).localeCompare(String(b.name))));

  const typeSeg = h("span", { class: "seg" });
  for (const [t, text] of [["", "All"], ...present.map((t) => [t, typeLabel(t)])]) {
    const b = h("button", { title: t ? typeLabel(t) : "Everything" }, text);
    if (t === itemView.type) b.classList.add("on");
    b.addEventListener("click", () => { itemView.type = t; route(); });
    typeSeg.append(b);
  }
  // Sort control: icons, not words — a coin for price, letters for name,
  // and one arrow that flips the direction (maintainer 2026-07-31).
  const sortSeg = h("span", { class: "seg" });
  for (const [s, glyph, title] of [
    ["value", null, "Sort by what it sells for"],
    ["name", "A–Z", "Sort by name"],
  ]) {
    const b = h("button", { title }, s === "value"
      ? h("img", { class: "gold-coin", src: "icons/gold.webp", alt: "price", width: "32", height: "32" })
      : glyph);
    if (s === itemView.sort) b.classList.add("on");
    b.addEventListener("click", () => { itemView.sort = s; route(); });
    sortSeg.append(b);
  }
  const dirBtn = h("button", { class: "ghost-btn dir-btn", title: itemView.dir < 0
    ? (itemView.sort === "name" ? "Z to A" : "Most valuable first")
    : (itemView.sort === "name" ? "A to Z" : "Least valuable first") },
    itemView.dir < 0 ? "↓" : "↑");
  dirBtn.addEventListener("click", () => { itemView.dir = -itemView.dir; route(); });

  return h("div", {},
    sectionHead("items"),
    h("p", { class: "muted" }, state.admin
      ? `${all.length} items from the items agent. Click one to see what drops it, what it sells for, and to rate or remove it.`
      : "Everything you can pick up, sell or merge — and the creatures that carry it."),
    h("div", { class: "item-tools" }, typeSeg, sortSeg, dirBtn),
    h("div", { class: "grid" }, ...list.map((it) => {
      const src = itemSources(it);
      return h("a", { class: `card${src.length ? "" : " dim"}`, href: `#/items/${it.id}` },
        h("div", { class: "thumb checker" }, itemSprite(it, 96)),
        itemChip(it),
        h("div", { class: "card-name" }, it.name),
        goldTag(it) ? h("div", { class: "card-sub" }, goldTag(it)) : null,
        // Nothing at all when nothing drops it — silence reads better
        // than "not dropped yet" (maintainer 2026-07-31).
        src.length
          ? h("div", { class: "card-sub" }, `Dropped by ${src.length} ${src.length === 1 ? "creature" : "creatures"}`)
          : null,
        h("div", { class: "card-badges" }, ...entityBadge("items", it.path)));
    })));
}
function viewItem(id) {
  const all = itemOrder();
  const it = all.find((x) => x.id === id);
  if (!it) return h("p", {}, "Unknown item.");
  const type = state.data.itemTypes?.[it.type];
  return h("div", {},
    crumbRow("#/items", `← ${label("items")}`, "items", all.map((x) => ({ id: x.id, name: itemLabel(x) })), it.id),
    h("div", { class: "detail-head" },
      h("div", { class: "portrait-col" },
        h("div", { class: "portrait checker" }, itemSprite(it, 96)),
        itemChip(it)),
      h("div", { class: "meta" },
        h("h1", {}, it.name),
        goldTag(it) ? h("div", { class: "spawn-line" }, goldTag(it)) : null,
        // Pipeline facts stay behind the admin flag, as everywhere else.
        state.admin ? h("p", { class: "muted" },
          `${it.id} · ${it.type}${type?.label ? ` (${type.label})` : ""}${it.category ? ` · ${it.category}` : ""}${it.rarity ? ` · ${it.rarity}` : ""}${it.stackable ? ` · stacks to ${it.max_stack}` : ""}`) : null,
        // LAST variable-height element in this column — see loreSlot.
        loreSlot(itemBlurb(it), all.map(itemBlurb)),
        feedbackRow("items", it.path))),
    // NO "what it grants" panel: merging is not in the game yet, and the
    // wiki does not promise mechanics that do not exist (maintainer
    // 2026-07-31). It returns when the effects are real.
    droppedByPanel(it),
    storyCard({ label: "The story", art: itemSprite(it, 48), name: itemLabel(it), paras: it.loreStory, related: it.loreRelated }));   // always last
}

/* --- lore views --- */
function viewLore() {
  const list = loreList();
  if (!list.length) {
    return h("div", {}, sectionHead("lore"),
      h("div", { class: "panel" },
        h("div", { class: "panel-title" }, "Nothing written down"),
        h("p", { class: "muted" }, "No chapter of Nangijala is set down here.")));
  }
  // Groups in FIRST-APPEARANCE order of the already-sorted array, so Chapters
  // is always first and a future category appends with no code change.
  const groups = [];
  for (const e of list) {
    const key = e.category ?? "";
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, head: loreCat(e).plural, rows: [] }));
    g.rows.push(e);
  }
  const row = (e) => h("a", { class: "drop-row lore-row", href: `#/lore/${e.id}` },
    // Empty for a non-chapter, so every title still starts on the same x.
    h("span", { class: "lore-no" }, Number.isInteger(e.chapter) ? String(e.chapter) : ""),
    e.preview ? h("img", { class: "item-icon", src: assetUrl(e.preview), alt: "", width: "48", height: "48", loading: "lazy" }) : loreIcon(e, 48),
    h("span", { class: "drop-name lore-row-text" },
      h("span", { class: "lore-name" }, e.name),
      h("span", { class: "lore-sum" }, e.summary ?? "")),
    h("span", { class: "card-badges" }, ...entityBadge("lore", e.path)));
  return h("div", {},
    sectionHead("lore"),
    h("p", { class: "muted" }, state.admin
      ? `${list.length} tales from the lore agent — the one author who now writes every description in this wiki. Rate a chapter, approve it or send it back, and leave a note; the lore agent reads the verdicts on its next run.`
      // The second half must EARN the first (maintainer 2026-07-31): the old
      // "Nothing here is required" excused the reader from the page it was
      // trying to open. Promise them something instead.
      : "The chronicles of Nangijala — what the world still remembers of itself. Read them in order and it assembles itself; read one alone and it will still name something you have already walked past."),
    // The desk sits FIRST because it is the editor-in-chief's home screen and
    // the admin must not scroll the whole contents to reach the red line. It
    // costs players nothing — they never render it.
    state.admin ? loreDesk() : null,
    ...groups.flatMap((g) => [
      h("h2", {}, g.head, h("span", { class: "pill", style: "margin-left:8px" }, String(g.rows.length))),
      h("div", { class: "drop-list lore-list" }, ...g.rows.map(row)),
    ]));
}
/** Admin only — a progress report is legal here, and nowhere else. */
function loreDesk() {
  const list = loreList();
  const LORE_DOMS = ["monsters", "characters", "items", "objects", "tiles"];
  const hasLore = (e) => !!(e.loreDesc || e.loreStory?.length);
  // Derived from the entities actually rendered, so it can never claim
  // coverage the pages do not have.
  const row = (slug) => {
    const dom = state.data.domains[slug] ?? [];
    const covered = dom.filter(hasLore).length;
    const missing = dom.filter((e) => !hasLore(e)).map((e) => e.name ?? e.id);
    return h("a", { class: "drop-row", href: `#/${slug}`,
      title: missing.length && missing.length <= 12 ? `Still to write: ${missing.join(", ")}` : "" },
      sectionIcon(slug, 48),
      h("span", { class: "drop-name" }, label(slug)),
      h("span", { class: "drop-worth muted" }, `${covered} of ${dom.length}`),
      h("span", { class: "drop-pct" }, dom.length ? `${Math.round((100 * covered) / dom.length)}%` : "—"));
  };
  const unjudged = list.filter((e) => { const f = fb("lore", e.path); return !f.status && !f.rating; }).length;
  const rl = state.data.loreMeta?.redLine;
  return h("div", { class: "panel" },
    h("div", { class: "panel-title" }, "The lore agent's desk",
      h("span", { class: "pill" }, `${list.length} tales`),
      unjudged ? h("span", { class: "pill warn" }, `${unjudged} unjudged`) : null),
    h("p", { class: "muted" }, "One author writes all of it: the chapters below, and the short line and the long story on every creature, hero, prop and item page. Where the lore agent has written a description, it replaces the one the owning domain shipped."),
    h("h3", {}, "Written up"),
    h("div", { class: "drop-list" }, ...LORE_DOMS.map(row)),
    rl ? h("div", {},
      h("h3", {}, "The red line"),
      h("p", { class: "muted" }, "The Game Master's document — the backbone every chapter hangs off: five laws, three ages, one antagonist, and the questions it refuses to answer."),
      h("p", { class: "muted" }, RED_LINE_HONESTY),
      h("a", { class: "ghost-btn", href: "#/lore/red-line" }, "The red line →")) : null);
}
function viewLoreEntry(e) {
  const list = loreList();
  const i = list.findIndex((x) => x.id === e.id);
  const prev = list[(i - 1 + list.length) % list.length], next = list[(i + 1) % list.length];
  // the_falling's body[0] is byte-identical to its summary — without this the
  // same sentence prints twice, three lines apart, on the first chapter a
  // reader opens.
  const bodyParas = chapterParas(e);
  return h("div", { class: "lore-read" },
    crumbRow("#/lore", `← ${label("lore")}`, "lore", list, e.id),
    h("div", { class: "detail-head" },
      // No .checker behind the emblem: a chessboard says "here is a sprite's
      // alpha"; this is a plaque. The chip is load-bearing — it gives the left
      // column its own height so the summary's reserve lands beside something
      // taller instead of opening a hole.
      h("div", { class: "portrait-col" },
        h("div", { class: "portrait" }, loreIcon(e, 96)),
        h("div", { class: "thumb-chip" }, chipText(e))),
      h("div", { class: "meta" },
        h("h1", {}, e.name),
        state.admin ? h("p", { class: "muted" },
          `${e.id} · ${e.path} · ${e.category}${Number.isInteger(e.chapter) ? ` · chapter ${e.chapter}` : ""} · icon ${e.icon_id ?? "—"}${e.tags?.length ? ` · ${e.tags.join(", ")}` : ""} · ${(e.body ?? []).reduce((n, p) => n + paraText(p).split(/\s+/).length, 0).toLocaleString()} words in ${(e.body ?? []).length} paragraphs`) : null,
        loreSlot(e.summary ?? "", list.map((x) => x.summary ?? "")),
        feedbackRow("lore", e.path))),
    // Every paragraph is a TEXT NODE. No innerHTML, no markdown path for
    // lore.json content — "plain text only" is an authoring convention backed
    // by a partial checker, so markup that slips through must show up as
    // literal characters: obvious, and unmistakably the lore agent's bug.
    h("div", { class: "chapter-body" }, ...bodyParas.map(paraNode)),
    loreLinks(e.related) ? h("div", { class: "panel" }, loreLinks(e.related)) : null,
    // After three screens of prose the crumbRow is far off-screen; the rail
    // names the destination where the reader actually is.
    list.length > 1 ? h("div", { class: "read-rail" },
      h("a", { href: `#/lore/${prev.id}` }, h("span", { class: "rail-label" }, "Previous"), prev.name),
      h("a", { class: "to-next", href: `#/lore/${next.id}` }, h("span", { class: "rail-label" }, "Next"), next.name)) : null);
}

/* --- the red line: the Game Master's document, admin only --- */
// THE HONESTY SENTENCE. lore/RED_LINE.md is served at /assets/lore/RED_LINE.md
// by a bare express.static mount on an --allow-unauthenticated service, from a
// public repository. The wiki controls who is INVITED to read it, not who CAN.
// The words private/secret/secure/hidden may appear only inside a sentence
// that denies them, and there is no fake gate — no token, no obfuscation —
// because that would imply protection the server does not provide.
const RED_LINE_HONESTY = "Kept out of the player wiki, but not hidden: it is served at /assets/lore/RED_LINE.md and lives in the public repository. Treat it as unpublished, never as secret.";
let redLineText = null;
async function fetchText(url) {
  try { const r = await fetch(url, { cache: "no-cache" }); return r.ok ? await r.text() : null; }
  catch { return null; }
}
/** Split on the document's own `## ` boundaries. A character budget would cut a
 *  law in half; these never do. */
function redLineSections(md) {
  const out = [];
  let cur = { num: null, title: "The Red Line", lines: [] };
  for (const line of md.split(/\r?\n/)) {
    if (/^## /.test(line)) {
      out.push(cur);
      const t = line.slice(3).trim(), m = t.match(/^(\d+)\.\s*(.*)$/);
      cur = { num: m ? m[1] : null, title: m ? m[2] : t, lines: [] };
    } else if (/^# /.test(line) && !out.length && !cur.lines.length) {
      /* the page's own h1 already names the document */
    } else cur.lines.push(line);
  }
  out.push(cur);
  return out;
}
/* The ONLY markdown surface in the wiki, written against this one file's
   inventory. lore.json is plain text by contract and must NEVER reach it.
   No innerHTML anywhere: anything unhandled ships as literal characters. */
function mdInline(str) {
  const out = [];
  for (const part of String(str).split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|_[^_]+_)/g)) {
    if (!part) continue;
    if (/^\*\*[\s\S]+\*\*$/.test(part)) out.push(h("strong", {}, part.slice(2, -2)));
    else if (/^`[^`]+`$/.test(part)) out.push(h("code", {}, part.slice(1, -1)));
    else if (/^\*[^*]+\*$/.test(part) || /^_[^_]+_$/.test(part)) out.push(h("em", {}, part.slice(1, -1)));
    else out.push(document.createTextNode(part));
  }
  return out;
}
function mdBlocks(lines) {
  const out = [];
  let i = 0;
  const take = (re) => { const buf = []; while (i < lines.length && re.test(lines[i])) buf.push(lines[i++]); return buf; };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^#{1,2} /.test(line)) { out.push(h("h2", {}, ...mdInline(line.replace(/^#{1,2} /, "")))); i++; continue; }
    if (/^### /.test(line)) { out.push(h("h3", {}, ...mdInline(line.slice(4)))); i++; continue; }
    if (/^-{3,}$/.test(line.trim())) { out.push(h("hr", {})); i++; continue; }
    if (/^> ?/.test(line)) { out.push(h("blockquote", {}, ...take(/^> ?/).map((l) => h("p", {}, ...mdInline(l.replace(/^> ?/, "")))))); continue; }
    if (/^\s*[-*] /.test(line)) { out.push(h("ul", {}, ...take(/^\s*[-*] /).map((l) => h("li", {}, ...mdInline(l.replace(/^\s*[-*] /, "")))))); continue; }
    if (/^\s*\d+\. /.test(line)) { out.push(h("ol", {}, ...take(/^\s*\d+\. /).map((l) => h("li", {}, ...mdInline(l.replace(/^\s*\d+\. /, "")))))); continue; }
    if (/^\|/.test(line)) {
      const rows = take(/^\|/).map((l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()))
        .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)));
      if (rows.length) {
        out.push(h("div", { class: "table-scroll" }, h("table", { class: "tune" },
          h("thead", {}, h("tr", {}, ...rows[0].map((c) => h("th", {}, ...mdInline(c))))),
          h("tbody", {}, ...rows.slice(1).map((r) => h("tr", {}, ...r.map((c) => h("td", {}, ...mdInline(c)))))))));
      }
      continue;
    }
    const para = take(/^(?!\s*$|#{1,3} |-{3,}$|> ?|\s*[-*] |\s*\d+\. |\|)/);
    if (para.length) out.push(h("p", {}, ...mdInline(para.join(" "))));
    else i++;
  }
  return out;
}
/** How much of the backbone the published texts actually tell (lore v2,
 *  2026-08-05): the lore build maps every beat of the root as revealed,
 *  hinted or hidden and ships the COUNTS. Drawn as one segmented bar — the
 *  GM's one-glance answer to "how much has the story given away?". */
function redLineMeter() {
  const p = state.data.loreMeta?.redLineProgress;
  if (!p) return null;
  const total = (p.revealed ?? 0) + (p.hinted ?? 0) + (p.hidden ?? 0);
  if (!total) return null;
  const seg = (n, cls, label) => (n ? h("span", { class: `rl-seg ${cls}`, style: `flex:${n}`, title: `${n} ${label}` }) : null);
  return h("div", { class: "rl-meter-box" },
    h("div", { class: "rl-meter", role: "img", "aria-label": `${p.revealed} of ${total} beats revealed` },
      seg(p.revealed, "rl-revealed", "revealed"), seg(p.hinted, "rl-hinted", "hinted"), seg(p.hidden, "rl-hidden", "still hidden")),
    h("div", { class: "muted rl-meter-legend" },
      `${p.revealed} of ${total} beats revealed in the published texts · ${p.hinted} hinted · ${p.hidden} still hidden`));
}
function viewRedLine() {
  const box = h("div", {}, h("p", { class: "loading" }, "Opening the red line…"));
  const render = (md) => {
    if (md == null) {
      box.replaceChildren(h("p", { class: "muted" }, "The red line is not in this build. It lives at lore/RED_LINE.md in the repository."));
      return;
    }
    const secs = redLineSections(md);
    // The card title is the CONSTANT string: a varying section title plus the
    // counter and two buttons will not fit one flex row at drawer width, and
    // the pager would drop to a second row on some pages and not others.
    const panel = pagedPanel({
      title: "The red line",
      pages: secs.map((sec, n) => () => (n ? [h("h2", {}, sec.title), ...mdBlocks(sec.lines)] : mdBlocks(sec.lines))),
    });
    const jump = h("div", { class: "drop-list" }, ...secs.map((sec, n) => {
      const b = h("button", { class: "drop-row", type: "button" },
        h("span", { class: "lore-no" }, sec.num ?? ""),
        h("span", { class: "drop-name" }, sec.title));
      b.addEventListener("click", () => panel.goToPage(n));
      return b;
    }));
    box.replaceChildren(
      // A <details> is closed and constant-height, so opening it and paging
      // never moves anything.
      h("details", { class: "tile-group" }, h("summary", {}, `Jump to a section (${secs.length})`), jump),
      panel);
  };
  if (redLineText != null) render(redLineText);
  else fetchText(assetUrl("lore/RED_LINE.md")).then((md) => { if (md != null) redLineText = md; render(md); });
  return h("div", { class: "lore-read" },
    h("div", { class: "crumb-row" }, h("a", { class: "crumb", href: "#/lore" }, `← ${label("lore")}`)),
    h("h1", {}, "The Red Line"),
    h("div", { class: "pill-row" },
      h("span", { class: "pill" }, "Game Master"),
      h("span", { class: "pill warn" }, "not in the game yet")),
    h("p", { class: "muted" }, "Written for you, not for players — they are meant to find this out by reading the chapters and playing."),
    h("p", { class: "muted" }, RED_LINE_HONESTY),
    redLineMeter(),
    box);
}

/* --- tuning --- */
function viewTuning() {
  const t = state.tuning.constants;
  const q = state.query;
  const rows = state.data.constants.filter((c) => matches(q, c.name, c.description, c.source));
  return h("div", {},
    sectionHead("tuning"),
    h("p", { class: "muted" }, state.admin
      ? "Game constants discovered in games2/shared. Set an override and Save — it commits to live/tuning/constants.json and is pushed to the running game and every client over the WebSocket, no redeploy. (Each system adopts its overrides as the games agent wires them in.)"
      : "The knobs behind the game — live values the designer can tune while the world runs."),
    h("div", { class: "panel table-scroll" },
      h("table", { class: "tune" },
        h("thead", {}, h("tr", {},
          h("th", {}, "constant"), h("th", {}, "game value"), h("th", {}, "override"), h("th", {}, "what it does"), h("th", {}, "source"))),
        h("tbody", {}, ...rows.map((c) => {
          const cur = t?.overrides?.[c.name];
          let overrideCell;
          if (state.admin) {
            const input = h("input", { type: "number", step: "any", value: cur !== undefined ? String(cur) : "", placeholder: String(c.value), class: cur !== undefined ? "overridden" : "" });
            input.addEventListener("change", () => {
              if (input.value === "" || Number(input.value) === c.value) delete t.overrides[c.name];
              else t.overrides[c.name] = Number(input.value);
              input.classList.toggle("overridden", t.overrides[c.name] !== undefined);
              t.updated_at = new Date().toISOString();
              touch("tuning/constants", c.name);
              markDirty("tuning/constants");
            });
            overrideCell = input;
          } else {
            overrideCell = cur !== undefined ? h("span", { class: "pill warn" }, String(cur)) : h("span", { class: "muted" }, "—");
          }
          return h("tr", {},
            h("td", {}, h("code", {}, c.name)),
            h("td", { class: "num" }, String(c.value)),
            h("td", {}, overrideCell),
            h("td", { class: "muted" }, c.description ?? ""),
            h("td", { class: "muted" }, h("code", {}, `${c.source.replace("games2/shared/src/", "")}:${c.line}`)));
        })))));
}

/* --- search --- */
function viewSearch() {
  const q = state.query;
  if (!q) return viewHome();
  const d = state.data.domains;
  const hits = [];
  d.monsters.forEach((m) => matches(q, m.id, m.name) && hits.push(["monsters", m.name, `#/monsters/${m.id}`, m.preview]));
  // The whole cast is searchable now that every NPC has a real name (they
  // were excluded while all 191 were called "Villager" — 191 identical rows
  // would have drowned every query). Name, sex and trade for a player; the
  // folder key and the duplicate PixelLab name stay admin-only.
  d.characters.forEach((c) => {
    if (matches(q, c.name, ...(c.kind === "npc" ? [c.sex, c.role] : [c.id]),
                ...(state.admin ? [c.id, c.pixellabName] : []))) {
      hits.push(["characters", c.name, `#/characters/${c.id}`, c.preview]);
    }
  });
  d.tiles.forEach((t) => matches(q, t.id, t.name, t.description) && hits.push(["tiles", t.name, `#/tiles/${t.id}`, t.groups[0] ? `${t.groups[0].dir}/${t.groups[0].tiles[0]}` : null]));
  d.objects.forEach((o) => matches(q, o.id, o.name, o.description) && hits.push(["objects", o.name, `#/objects/${o.id}`, o.preview]));
  d.sounds.forEach((s) => matches(q, s.id, s.name, s.description, s.usage) && hits.push(["sounds", s.name, "#/sounds", null]));
  d.music.forEach((t) => matches(q, t.id, t.name, t.use) && hits.push(["music", t.name, "#/music", null]));
  // Entry ids and tags are pipeline slugs — admin only, so a player cannot
  // surface an entry by typing a folder id.
  (d.lore ?? []).forEach((e) => matches(q, e.name, e.summary, ...(e.body ?? []).map(paraText), ...(state.admin ? [e.id, ...(e.tags ?? [])] : []))
    && hits.push(["lore", e.name, `#/lore/${e.id}`, loreIcon(e, 96)]));
  // A soul stone's name is shared by all of them — search its creature too,
  // and label the hit with the creature so 28 identical rows never appear.
  (d.items ?? []).forEach((it) => matches(q, it.id, it.name, it.description, it.category, it.rarity, itemLabel(it))
    && hits.push(["items", itemLabel(it), `#/items/${it.id}`, it.preview]));
  if (state.admin) state.data.constants.forEach((c) => matches(q, c.name, c.description) && hits.push(["tuning", c.name, "#/tuning", null]));
  return h("div", {},
    h("h1", {}, `Search: “${q}”`),
    h("p", { class: "muted" }, `${hits.length} hits`),
    h("div", { class: "grid" }, ...hits.slice(0, 60).map(([domain, name, href, img]) =>
      h("a", { class: "card", href },
        // A repo-relative path OR a ready Node (the lore emblem, which gets
        // no chessboard — it is a plaque, not a sprite).
        img ? h("div", { class: typeof img === "string" ? "thumb checker" : "thumb" },
          typeof img === "string" ? h("img", { src: assetUrl(img), loading: "lazy", alt: name }) : img) : null,
        h("div", { class: "card-name" }, name),
        h("div", { class: "card-sub" }, label(domain))))));
}

/* ---------------------------------------------------------------- router */
function route() {
  destroyPlayers();
  const a = audioEl(); if (a && !a.paused) a.pause();
  const hash = location.hash.replace(/^#\/?/, "");
  const [page, id, sub] = hash.split("/").map(decodeURIComponent);
  let view;
  if (state.query && !id) view = viewSearch();
  else if (page === "monsters") view = id ? viewMonster(id) : viewMonsters();
  else if (page === "characters") view = id ? viewCharacter(id) : viewCharacters();
  else if (page === "tiles") view = id ? (sub ? viewTileInstance(id, sub) : viewTileType(id)) : viewTiles();
  else if (page === "objects") view = id ? viewObject(id) : viewObjects();
  else if (page === "sounds") view = viewSounds();
  else if (page === "music") view = viewMusic();
  else if (page === "items") view = id ? viewItem(id) : viewItems();
  else if (page === "lore") {
    // Resolve the ENTRY first so a future entry can never be shadowed by the
    // reserved slug — structurally impossible, not merely unlikely.
    const e = id ? loreList().find((x) => x.id === id) : null;
    if (e) view = viewLoreEntry(e);
    else if (id === "red-line") view = state.admin ? viewRedLine() : viewLore();
    else view = viewLore();          // an unknown id lands on the list, never a dead page
  }
  // Tuning is admin-only INCLUDING by direct link — players get the overview.
  else if (page === "tuning") view = state.admin ? viewTuning() : viewHome();
  else view = viewHome();
  $("#content").replaceChildren(view);
  renderNav();
  setMenu(false);
  // A story card must always be able to reach the top of the viewport.
  fitStoryTail();
}

// Open/close the mobile nav; keep the scrim and the hosting game drawer
// (when embedded — same-origin iframe) in sync.
function setMenu(open) {
  $("#sidebar").classList.toggle("open", open);
  $("#menu-scrim").classList.toggle("on", open);
  if (window.parent !== window) {
    window.parent.postMessage({ type: "wiki:menu", open }, location.origin);
  }
}

/* ----------------------------------------------------------------- boot */
async function fetchJson(url, fallback = null) {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) return fallback;
    return await res.json();
  } catch { return fallback; }
}
async function loadLiveFiles() {
  // The game server's live store is the always-fresh copy of live/** on main
  // (push-refreshed, see live/README.md). Static /assets/live files are the
  // offline fallback (viewing the wiki without the game server).
  const apiState = await fetchJson(API("/api/live/state"));
  const fromApi = (get) => { try { return get(apiState) ?? null; } catch { return null; } };
  const [monTune, constTune, sfxReq, ...fbs] = apiState
    ? [fromApi((s) => s.tuning.monsters), fromApi((s) => s.tuning.constants), fromApi((s) => s.tuning.sfx_requests),
       ...FEEDBACK_DOMAINS.map((d) => fromApi((s) => s.feedback[d]))]
    : await Promise.all([
        fetchJson(new URL("live/tuning/monsters.json", ROOT)),
        fetchJson(new URL("live/tuning/constants.json", ROOT)),
        fetchJson(new URL("live/tuning/sfx_requests.json", ROOT)),
        ...FEEDBACK_DOMAINS.map((d) => fetchJson(new URL(`live/feedback/${d}.json`, ROOT))),
      ]);
  state.tuning.monsters = monTune ?? { format: "pixel-wiki-tuning-monsters@1", updated_at: "", defaults: {}, monsters: {} };
  state.tuning.constants = constTune ?? { format: "pixel-wiki-tuning-constants@1", updated_at: "", overrides: {} };
  state.tuning.sfx_requests = sfxReq ?? { format: "pixel-wiki-sfx-requests@1", updated_at: "", requests: {} };
  FEEDBACK_DOMAINS.forEach((d, i) => {
    state.feedback[d] = fbs[i] ?? { format: "pixel-wiki-feedback@1", domain: d, updated_at: "", entries: {} };
  });
}
function buildKnownIds() {
  const d = state.data.domains;
  const add = (id) => state.knownIds.add(id);
  d.monsters.forEach((m) => add(m.path));
  d.characters.forEach((c) => add(c.path));
  d.objects.forEach((o) => add(o.path));
  d.music.forEach((t) => { add(t.path); add(`${t.path}/${t.id}`); });
  d.items.forEach((it) => add(it.path));
  (d.lore ?? []).forEach((e) => add(e.path));   // else a rejected chapter reads as "resolved"
  d.tiles.forEach((t) => { add(t.path); t.groups.forEach((g) => g.tiles.forEach((f) => add(stripExt(`${g.dir}/${f}`)))); });
  d.sounds.forEach((s) => { add(s.path); s.takes.forEach((t) => add(`${s.path}/${t.id}`)); });
  // Composer foley takes (feedback domain "composer") — ids are file paths.
  Object.values(state.data.sfx?.composerSets ?? {}).forEach((cs) => cs.takes.forEach((t) => add(t.file.replace(/\.\w+$/, ""))));
}

function initChrome() {
  // Theme: READ ONLY here. The wiki has no toggle of its own (maintainer
  // 2026-07-30) — light/dark is picked on the character-select screen, which
  // writes localStorage["wiki-theme"] and, while the wiki is open in the
  // game's drawer, mirrors data-theme straight onto this document
  // (games2/client/src/wikipanel.ts). Unset = follow the OS.
  const saved = localStorage.getItem("wiki-theme");
  if (saved) document.documentElement.dataset.theme = saved;
  // sidebar (mobile) — a drawer of its own: scrim right of it closes it, and
  // the game drawer hosting us mirrors the state (double-dark game strip that
  // closes the menu first; see wikipanel.ts).
  $("#menu-btn").addEventListener("click", () => setMenu(!$("#sidebar").classList.contains("open")));
  $("#menu-scrim").addEventListener("click", () => setMenu(false));
  window.addEventListener("message", (e) => {
    if (e.origin === location.origin && e.data?.type === "wiki:closeMenu") setMenu(false);
  });
  // search
  let debounce = null;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.query = e.target.value.trim().toLowerCase();
      route();
    }, 160);
  });
  // save / export / discard
  $("#save-btn").addEventListener("click", saveAll);
  $("#export-btn").addEventListener("click", exportAll);
  $("#discard-btn").addEventListener("click", discardAll);
  // admin login/logout
  const dlg = $("#login-dialog");
  $("#admin-btn").addEventListener("click", () => {
    if (state.admin) {
      if (state.dirty.size && !confirm("You have unsaved changes — sign out and discard them?")) return;
      localStorage.removeItem("wiki-admin-token");
      setAdmin(false);
      toast("Signed out.");
    } else {
      $("#login-error").textContent = "";
      dlg.showModal();
    }
  });
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#login-error").textContent = "";
    const btn = $("#login-submit");
    btn.disabled = true;
    try {
      const res = await fetch(API("/api/wiki/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: $("#login-user").value.trim(), password: $("#login-pass").value }),
      });
      if (!res.ok) {
        $("#login-error").textContent = res.status === 401 ? "Wrong username or password." : `Login failed (HTTP ${res.status}).`;
        return;
      }
      const { token } = await res.json();
      localStorage.setItem("wiki-admin-token", token);
      $("#login-pass").value = "";
      dlg.close();
      setAdmin(true);
      toast("Signed in — edit away.");
    } catch (err) {
      $("#login-error").textContent = `Login failed: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });
  // A NEW PAGE STARTS AT ITS BEGINNING (maintainer 2026-07-31): reaching the
  // end of a chapter and tapping the next one must not drop you at that one's
  // end. Bound to the NAVIGATION event, not to route() itself, so in-place
  // re-renders — the item filter and sort — leave the reader where they are.
  // Stamp the page the reader is leaving. Capture phase, so it runs before the
  // hash changes and while the old view is still measurable. Every in-app link
  // counts, not just the story card's: Back out of a creature should land you
  // where you were in the creature list too.
  document.addEventListener("click", (e) => {
    if (e.target?.closest?.("a[href^='#/']")) rememberSpot();
  }, true);
  // Ours to place, not the browser's — it would restore its own idea of the
  // scroll after we set ours, and race us for the last word.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  window.addEventListener("hashchange", () => {
    const want = pendingScroll; pendingScroll = null;
    // Only an entry we stamped on the way out carries a spot, so this is a
    // Back or a Forward to a page the reader has already stood on.
    const spot = history.state?.spot;
    route();
    // A "Read next" link that points at another ENTITY lands on that entity's
    // story card — the reader asked for a story, not for a stat block. Clear
    // of the sticky topbar. Anything else, including every chapter, starts at
    // the top.
    if (want === "story") {
      const card = $(".story-card");
      if (card) {
        const bar = $("#topbar")?.getBoundingClientRect().height ?? 0;
        window.scrollTo(0, Math.max(0, card.getBoundingClientRect().top + window.scrollY - bar - 8));
        return;
      }
    }
    if (restoreSpot(spot)) return;
    window.scrollTo(0, 0);
  });
  window.addEventListener("resize", fitStoryTail);
  window.addEventListener("beforeunload", (e) => { if (state.dirty.size) e.preventDefault(); });
}

function setAdmin(on, { keepEdits = false } = {}) {
  state.admin = on;
  document.documentElement.classList.toggle("is-admin", on);
  const btn = $("#admin-btn");
  btn.textContent = on ? "Sign out (Game Master)" : "Game Master";
  btn.title = on ? "Signed in as the game designer" : "Game-designer sign in";
  if (!on && !keepEdits) { state.dirty.clear(); state.touched = {}; }
  updateSavebar();
  if (state.data) route();
}

// Validate a stored session against the server (tokens expire / restart).
async function checkAdmin() {
  if (!adminToken()) return false;
  try {
    const res = await fetch(API("/api/wiki/me"), { headers: { Authorization: `Bearer ${adminToken()}` } });
    if (!res.ok) return false;
    return !!(await res.json()).admin;
  } catch { return false; }
}

(async function boot() {
  initChrome();
  const [data, admin] = await Promise.all([
    fetchJson(new URL("data.json", location.href)),
    checkAdmin(),
  ]);
  if (admin) setAdmin(true); // before first route() so widgets render editable
  else localStorage.removeItem("wiki-admin-token");
  if (!data) {
    $("#content").replaceChildren(h("p", {}, "data.json missing — run ", h("code", {}, "node wiki/build.mjs"), " and reload."));
    return;
  }
  state.data = data;
  await loadLiveFiles();
  buildKnownIds();
  // Topbar stamp: the build DATE on one line, the deployed git sha under it —
  // no "built" prefix (maintainer 2026-07-30). Fixed compact format so the
  // date can never wrap on a phone (toLocaleString did).
  {
    const d = new Date(data.generated_at);
    const p = (n) => String(n).padStart(2, "0");
    $("#build-stamp").replaceChildren(
      h("div", { class: "stamp-date" }, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`),
      ...(data.git_sha ? [h("div", { class: "stamp-sha" }, data.git_sha)] : []));
  }
  route();
  // Headless QA hook (mirrors the games2 __ml convention).
  window.__wiki = {
    state, route,
    counts: () => state.data.counts,
    fb, setFb,
    dirty: () => [...state.dirty],
    // Static-file QA only: flips the UI to admin (the server still rejects
    // every save without a real session token).
    forceAdmin: (on = true) => setAdmin(on),
  };
})();
