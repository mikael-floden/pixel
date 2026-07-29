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
// The game server's API (same origin in prod and dev — vite proxies /api).
const API = (path) => new URL(path, location.origin).href;

const FEEDBACK_DOMAINS = ["monsters", "characters", "tiles", "objects", "sounds", "music", "items"];
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
  const bucket = key.startsWith("feedback/") ? doc.entries : key === "tuning/monsters" ? doc.monsters : doc.overrides;
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
    localStorage.removeItem("wiki-admin-token");
    setAdmin(false);
    throw new Error("session expired — sign in again");
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
        im.src = assetUrl(`${clip.framesDir}/${i}.png`);
        return im;
      });
    }
  }
  function scaleFor(fw, fh) {
    if (cur.zoom) return cur.zoom;
    const target = 260;
    return Math.max(1, Math.min(6, Math.floor(target / Math.max(fw, fh)) || 1));
  }
  function draw() {
    const fw = clip?.fw ?? entity.frameW ?? 64, fh = clip?.fh ?? entity.frameH ?? 64;
    const s = scaleFor(fw, fh);
    // A hovering creature (butterfly_dragon) floats hoverPx above the ground
    // line — give the canvas that extra height so nothing is cropped: the
    // sprite draws at the top, the shadow sits hoverPx below its frame.
    const hover = (entity.hoverPx ?? 0) * s;
    const wantW = fw * s, wantH = fh * s + hover;
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW; canvas.height = wantH;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!clip) { frameNo.textContent = "—"; return; }
    if (cur.shadow && entity.shadow) {
      // The game's ground ellipse: centred, sitting at the art-measured foot line.
      ctx.fillStyle = "rgba(20,16,8,0.38)";
      ctx.beginPath();
      ctx.ellipse(canvas.width / 2, entity.artBottom * fh * s + hover, (entity.shadow.w * s) / 2, (entity.shadow.h * s) / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const f = Math.min(cur.frame, clip.frames - 1);
    if (img?.complete && img.naturalWidth) {
      ctx.drawImage(img, f * (img.naturalWidth / clip.frames), 0, img.naturalWidth / clip.frames, img.naturalHeight, 0, 0, fw * s, fh * s);
    } else if (frameImgs[f]?.complete && frameImgs[f].naturalWidth) {
      ctx.drawImage(frameImgs[f], 0, 0, fw * s, fh * s);
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
          loadClip(); renderStateSeg(); renderDirPad(); onStateChange?.(s);
        },
      }, s + (anims[s].fallback ? ` (→${anims[s].fallback})` : ""))));
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
  renderDirPad();

  const playBtn = h("button", { class: "ghost-btn", onclick: () => { cur.playing = !cur.playing; playBtn.textContent = cur.playing ? "⏸" : "▶"; } }, "⏸");
  const step = (dn) => { cur.playing = false; playBtn.textContent = "▶"; cur.frame = ((cur.frame + dn) % (clip?.frames ?? 1) + (clip?.frames ?? 1)) % (clip?.frames ?? 1); draw(); };
  const speedSeg = h("span", { class: "seg" }, ...[0.25, 0.5, 1, 2].map((sp) =>
    h("button", { class: sp === 1 ? "on" : "", onclick: (e) => { cur.speed = sp; e.target.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.target)); } }, `${sp}×`)));
  const zoomSeg = h("span", { class: "seg" }, ...[["auto", 0], ["1×", 1], ["2×", 2], ["4×", 4]].map(([lbl, z], i) =>
    h("button", { class: i === 0 ? "on" : "", onclick: (e) => { cur.zoom = z; e.target.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.target)); draw(); } }, lbl)));

  const controls2 = h("div", { class: "player-controls" },
    playBtn,
    h("button", { class: "ghost-btn", title: "Previous frame", onclick: () => step(-1) }, "⏮"),
    h("button", { class: "ghost-btn", title: "Next frame", onclick: () => step(1) }, "⏭"),
    frameNo, speedSeg, zoomSeg,
    entity.shadow ? h("label", { class: "chk" },
      Object.assign(h("input", { type: "checkbox" }), { checked: cur.shadow, onchange: (e) => { cur.shadow = e.target.checked; draw(); } }),
      `nadir shadow ${entity.shadow.w}×${entity.shadow.h}px`) : null,
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
  row.append(
    btn,
    h("span", { class: "take-name" }, take.id),
    take.chosen ? h("span", { class: "pill ok", title: "The take the game plays" }, "chosen") : null,
    ...extra,
    h("span", { class: "spacer" }),
    starsWidget(domain, id),
    verdictWidget(domain, id, { onchange: sync }),
  );
  sync();
  return row;
}

/* ----------------------------------------------------------------- views */
const NAV = [
  ["", "Overview", () => ""],
  ["monsters", "Monsters", (d) => d.counts.monsters],
  ["characters", "Characters", (d) => d.counts.characters],
  ["tiles", "Tiles", (d) => d.counts.tile_types],
  ["objects", "Objects", (d) => d.counts.objects],
  ["sounds", "Sounds", (d) => d.counts.sounds],
  ["music", "Music", (d) => d.counts.music],
  ["items", "Items", (d) => d.counts.items],
  ["tuning", "Tuning", (d) => d.counts.constants],
];
function renderNav() {
  const cur = location.hash.replace(/^#\/?/, "").split("/")[0];
  $("#nav").replaceChildren(...NAV.map(([slug, label, count]) =>
    h("a", { href: `#/${slug}`, class: cur === slug ? "active" : "" },
      label, h("span", { class: "count" }, String(count(state.data) || "")))));
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

function viewHome() {
  const c = state.data.counts;
  const tiles = [
    ["monsters", c.monsters, "monsters"], ["characters", c.characters, "player characters"],
    ["tiles", c.tiles, "tiles"], ["objects", c.objects, "objects"],
    ["sounds", c.sounds, "sounds"], ["music", c.music, "music tracks"],
    ["items", c.items, "items"], ["tuning", c.constants, "tunable constants"],
  ];
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
    h("div", { class: "stat-tiles" }, ...tiles.map(([slug, n, label]) =>
      h("a", { class: "stat-tile", href: `#/${slug}` }, h("div", { class: "n" }, String(n)), h("div", { class: "l" }, label)))),
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
  const list = state.data.domains.monsters.filter((m) => matches(q, m.id, m.name, m.kind));
  return h("div", {},
    h("h1", {}, "Monsters"),
    h("p", { class: "muted" }, state.admin
      ? `${list.length} creatures from the monsters agent. Click one to preview every animation, check its nadir shadow, edit its stats and loot.`
      : `${list.length} creatures roam Nangijala. Click one to watch every animation and study its stats.`),
    h("div", { class: "grid" }, ...list.map((m) =>
      h("a", { class: "card", href: `#/monsters/${m.id}` },
        h("div", { class: "thumb checker" }, h("img", { src: assetUrl(m.preview), alt: m.name, loading: "lazy" })),
        h("div", { class: "card-name" }, m.name),
        h("div", { class: "card-sub" }, `${m.frameW}×${m.frameH} · ${Object.keys(m.animations).length} states${m.inGame ? "" : " · not in game yet"}`),
        h("div", { class: "card-badges" }, ...entityBadge("monsters", m.path))))));
}
const STAT_FIELDS = [
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
    // Players see the creature's stats + drops as wiki lore, read-only.
    return h("div", {},
      h("div", { class: "stat-grid ro" }, ...STAT_FIELDS.map(([key, label]) =>
        h("label", {}, label, h("span", { class: "stat-value" }, String(stats[key] ?? t.defaults[key] ?? 0))))),
      (stats.loot ?? []).filter((l) => l.item).length
        ? h("div", { style: "margin-top:14px" },
            h("div", { class: "panel-title" }, "Drops"),
            ...stats.loot.filter((l) => l.item).map((l) =>
              h("div", { class: "loot-row" }, h("code", {}, l.item), h("span", { class: "muted" }, `${+(100 * (l.chance ?? 0)).toFixed(2)}%`))))
        : null);
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
function viewMonster(id) {
  const m = state.data.domains.monsters.find((x) => x.id === id);
  if (!m) return h("p", {}, "Unknown monster.");
  const player = makePlayer(m, "monster");
  activePlayers.push(player);
  const facetBox = h("div", {});
  const renderFacet = () => {
    const st = player.getState();
    facetBox.replaceChildren(
      h("div", { class: "panel-title" }, `Feedback on this animation (${st})`),
      feedbackRow("monsters", `${m.path}#${st}`));
  };
  player.onStateChange = renderFacet;
  renderFacet();
  return h("div", {},
    h("a", { class: "crumb", href: "#/monsters" }, "← Monsters"),
    h("div", { class: "detail-head" },
      h("div", { class: "portrait checker" }, h("img", { src: assetUrl(m.preview), alt: m.name })),
      h("div", { class: "meta" },
        h("h1", {}, m.name),
        h("p", { class: "muted" }, `${m.frameW}×${m.frameH}px (native ${m.nativeW}×${m.nativeH}, pad ${m.pad.x},${m.pad.y}) · kind: ${m.kind} · foot line at ${(m.artBottom * 100).toFixed(0)}% · footW ${m.footW ?? "?"}px · bodyW ${m.bodyW ?? "?"}px${m.hoverPx ? ` · hovers ${m.hoverPx}px` : ""}${m.inGame ? "" : " · not in the game manifest yet"}`),
        m.pixellab ? h("p", {}, h("a", { href: m.pixellab, target: "_blank", rel: "noopener" }, "Open on PixelLab ↗")) : null,
        h("div", { class: "panel-title" }, "Verdict on the whole monster"),
        feedbackRow("monsters", m.path))),
    h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "Animations", h("span", { class: "pill" }, `${Object.keys(m.animations).length} states × 8 directions`)),
      player.el,
      h("div", { style: "margin-top:12px" }, facetBox)),
    h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "Stats ",
        state.admin ? h("span", { class: "pill warn" }, "pushed live to the game — systems adopt them as the monster brain lands") : null),
      statsEditor(m.id)));
}

/* --- characters --- */
function viewCharacters() {
  const list = state.data.domains.characters.filter((c) => matches(state.query, c.id, c.name));
  return h("div", {},
    h("h1", {}, "Player characters"),
    h("p", { class: "muted" }, "The heroes from characters2 — every game state, all 8 directions."),
    h("div", { class: "grid" }, ...list.map((c) =>
      h("a", { class: "card", href: `#/characters/${c.id}` },
        h("div", { class: "thumb checker" }, h("img", { src: assetUrl(c.preview), alt: c.name, loading: "lazy" })),
        h("div", { class: "card-name" }, c.name),
        h("div", { class: "card-sub" }, `${c.id} · ${Object.keys(c.animations).length} states`),
        h("div", { class: "card-badges" }, ...entityBadge("characters", c.path))))));
}
function viewCharacter(id) {
  const c = state.data.domains.characters.find((x) => x.id === id);
  if (!c) return h("p", {}, "Unknown character.");
  const player = makePlayer(c, "character");
  activePlayers.push(player);
  const facetBox = h("div", {});
  const renderFacet = () => {
    const st = player.getState();
    facetBox.replaceChildren(
      h("div", { class: "panel-title" }, `Feedback on this animation (${st})`),
      feedbackRow("characters", `${c.path}#${st}`));
  };
  player.onStateChange = renderFacet;
  renderFacet();
  // The character's sounds (e.g. jump) live in the sounds domain — link them in.
  const related = state.data.domains.sounds.filter((s) => ["movement"].includes(s.category));
  return h("div", {},
    h("a", { class: "crumb", href: "#/characters" }, "← Characters"),
    h("div", { class: "detail-head" },
      h("div", { class: "portrait checker" }, h("img", { src: assetUrl(c.preview), alt: c.name })),
      h("div", { class: "meta" },
        h("h1", {}, c.name),
        h("p", { class: "muted" }, `${c.id} · ${c.frameW}×${c.frameH}px · ${Object.keys(c.animations).length} animation states`),
        h("div", { class: "panel-title" }, "Verdict on the whole character"),
        feedbackRow("characters", c.path))),
    h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "Animations"),
      player.el,
      h("div", { style: "margin-top:12px" }, facetBox)),
    h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "Movement sounds ", h("span", { class: "pill" }, "from the sounds agent — jump, footsteps, splash")),
      ...related.map((s) => h("div", {},
        h("h3", { style: "margin-top:10px" }, s.name, " ", h("span", { class: "pill" }, s.category)),
        ...s.takes.map((t) => takeRow("sounds", s.path, t))))));
}

/* --- tiles --- */
function viewTiles() {
  const list = state.data.domains.tiles.filter((t) => matches(state.query, t.id, t.name, t.description));
  return h("div", {},
    h("h1", {}, "Tiles"),
    h("p", { class: "muted" }, state.admin
      ? "The tiles2 ground library. Open a type to rate or remove individual tiles — rejected tiles tell the tiles agent (and the maps agent) to retire them."
      : "The ground the world is built from — every tile of every terrain type."),
    h("div", { class: "grid" }, ...list.map((t) => {
      const first = t.groups[0];
      return h("a", { class: "card", href: `#/tiles/${t.id}` },
        h("div", { class: "thumb checker" }, first ? h("img", { src: assetUrl(`${first.dir}/${first.tiles[0]}`), alt: t.name, loading: "lazy" }) : null),
        h("div", { class: "card-name" }, t.name),
        h("div", { class: "card-sub" }, `${t.tileCount} tiles · ${t.groups.length} sheets`),
        h("div", { class: "card-badges" }, ...entityBadge("tiles", t.path)));
    })));
}
function tileCell(group, file) {
  const id = `${group.dir}/${file}`.replace(/\.png$/, "");
  const cell = h("div", { class: "tile-cell" });
  const sync = () => {
    const e = fb("tiles", id);
    cell.classList.toggle("rejected", e.status === "rejected");
    cell.classList.toggle("approved", e.status === "approved");
  };
  cell.append(
    h("img", { src: assetUrl(`${group.dir}/${file}`), alt: file, loading: "lazy", title: id }),
    starsWidget("tiles", id),
    state.admin ? h("button", {
      class: "tile-x", title: "Reject this tile (toggles)",
      onclick: () => { setFb("tiles", id, { status: fb("tiles", id).status === "rejected" ? null : "rejected" }); sync(); },
    }, "✕") : null);
  sync();
  return cell;
}
function viewTileType(id) {
  const t = state.data.domains.tiles.find((x) => x.id === id);
  if (!t) return h("p", {}, "Unknown tile type.");
  const kinds = [["base", "Base tiles"], ["elevation", "Elevation objects"], ["transition", "Transitions"]];
  return h("div", {},
    h("a", { class: "crumb", href: "#/tiles" }, "← Tiles"),
    h("h1", {}, t.name),
    h("p", { class: "muted" }, `${t.description} · ${t.tilePx}px iso · ${t.tileCount} tiles`),
    h("div", { class: "fb-row" }, h("span", { class: "muted" }, "Whole type:"), starsWidget("tiles", t.path), verdictWidget("tiles", t.path)),
    ...kinds.map(([kind, label]) => {
      const groups = t.groups.filter((g) => g.kind === kind);
      if (!groups.length) return null;
      return h("div", {},
        h("h2", {}, label, " ", h("span", { class: "pill" }, `${groups.reduce((n, g) => n + g.tiles.length, 0)} tiles`)),
        ...groups.map((g, i) =>
          h("details", { class: "tile-group", ...(kind === "base" && i < 2 ? { open: "" } : {}) },
            h("summary", {}, `${g.label} · ${g.sheet} `, h("span", { class: "pill" }, String(g.tiles.length))),
            h("div", { class: "tile-grid" }, ...g.tiles.map((f) => tileCell(g, f))))));
    }));
}

/* --- objects --- */
function viewObjects() {
  const list = state.data.domains.objects.filter((o) => matches(state.query, o.id, o.name, o.category, o.description));
  const cats = [...new Set(list.map((o) => o.category))].sort();
  return h("div", {},
    h("h1", {}, "Objects"),
    h("p", { class: "muted" }, "Animated props and map objects from the objects agent."),
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
    h("a", { class: "crumb", href: "#/objects" }, "← Objects"),
    h("div", { class: "detail-head" },
      h("div", { class: "portrait checker" }, h("img", { src: assetUrl(o.preview), alt: o.name })),
      h("div", { class: "meta" },
        h("h1", {}, o.name),
        h("p", { class: "muted" }, `${o.description} · ${o.category}${o.placement ? ` · world height ${o.placement.world_height_m}m (${o.placement.world_px_height}px)` : ""}`),
        h("div", { class: "panel-title" }, "Verdict"),
        feedbackRow("objects", o.path))),
    hasAnims ? h("div", { class: "panel" }, h("div", { class: "panel-title" }, "Animations"), playerEl) : h("p", { class: "muted" }, "No animations."));
}

/* --- sounds --- */
function viewSounds() {
  const q = state.query;
  const list = state.data.domains.sounds.filter((s) => matches(q, s.id, s.name, s.category, s.description, s.usage));
  const cats = [...new Set(list.map((s) => s.category))].sort();
  return h("div", {},
    h("h1", {}, "Sounds"),
    h("p", { class: "muted" }, state.admin
      ? "Every take of every sound effect. ▶ to listen, ★ to rate, ✕ to have the sounds agent remove/regenerate that take. The chosen pill marks what the game currently plays."
      : "Every sound of the world — press ▶ to listen. The chosen pill marks what the game currently plays."),
    ...cats.map((cat) => h("div", {},
      h("h2", {}, cat, " ", h("span", { class: "pill" }, String(list.filter((s) => s.category === cat).length))),
      ...list.filter((s) => s.category === cat).map((s) =>
        h("div", { class: "panel" },
          h("div", { class: "panel-title" }, s.name,
            h("span", { class: "pill" }, fmtDur(s.duration_s)),
            s.loop ? h("span", { class: "pill" }, "loop") : null,
            h("span", { class: "spacer" }),
            starsWidget("sounds", s.path), verdictWidget("sounds", s.path)),
          h("p", { class: "muted", style: "margin:0 0 6px" }, `${s.description}${s.usage ? ` — ${s.usage}` : ""}`),
          ...s.takes.map((t) => takeRow("sounds", s.path, t)))))));
}

/* --- music --- */
function viewMusic() {
  const list = state.data.domains.music.filter((t) => matches(state.query, t.id, t.name, t.use));
  return h("div", {},
    h("h1", {}, "Music"),
    h("p", { class: "muted" }, "The score, from the music agent."),
    ...list.map((t) =>
      h("div", { class: "panel" },
        h("div", { class: "panel-title" }, t.name,
          h("span", { class: "pill" }, fmtDur(t.duration_s)),
          t.bpm ? h("span", { class: "pill" }, `${t.bpm} bpm`) : null,
          t.key ? h("span", { class: "pill" }, `${t.key.root} ${String(t.key.mode).replace(/_/g, " ")}`) : null,
          t.loopable ? h("span", { class: "pill ok" }, "loopable") : null),
        h("p", { class: "muted", style: "margin:0 0 8px" }, t.use),
        t.feeling?.length ? h("p", { class: "muted", style: "margin:0 0 8px" }, "feels: ", t.feeling.join(" · ")) : null,
        // Feedback id = the audio file's repo path sans extension (the
        // README contract), not meta.id — they can diverge.
        takeRow("music", t.files.wav.split("/").slice(0, -1).join("/"),
          { id: t.files.wav.split("/").pop().replace(/\.wav$/, ""), chosen: true, files: t.files }))));
}

/* --- items --- */
function viewItems() {
  // A future items agent's registry is foreign data — only render entries
  // that carry a usable id, and never produce feedback keyed "undefined".
  const list = (state.data.domains.items ?? []).filter((it) => it && (it.path || it.id))
    .map((it) => ({ ...it, path: it.path ?? `items/${it.id}`, name: it.name ?? it.id }));
  return h("div", {},
    h("h1", {}, "Items"),
    list.length
      ? h("div", { class: "grid" }, ...list.map((it) =>
          h("div", { class: "card" },
            it.preview ? h("div", { class: "thumb checker" }, h("img", { src: assetUrl(it.preview), alt: it.name, loading: "lazy" })) : null,
            h("div", { class: "card-name" }, it.name),
            h("div", { class: "card-sub" }, it.description ?? ""),
            feedbackRow("items", it.path, { note: false }))))
      : h("div", { class: "panel" },
          h("div", { class: "panel-title" }, "No items yet"),
          h("p", { class: "muted" }, "The items agent hasn't shipped anything — the moment an items/ domain lands in the repo, its loot appears here automatically (and monsters will show what they drop, with percentages, from live/tuning/monsters.json).")));
}

/* --- tuning --- */
function viewTuning() {
  const t = state.tuning.constants;
  const q = state.query;
  const rows = state.data.constants.filter((c) => matches(q, c.name, c.description, c.source));
  return h("div", {},
    h("h1", {}, "Tuning"),
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
  d.characters.forEach((c) => matches(q, c.id, c.name) && hits.push(["characters", c.name, `#/characters/${c.id}`, c.preview]));
  d.tiles.forEach((t) => matches(q, t.id, t.name, t.description) && hits.push(["tiles", t.name, `#/tiles/${t.id}`, t.groups[0] ? `${t.groups[0].dir}/${t.groups[0].tiles[0]}` : null]));
  d.objects.forEach((o) => matches(q, o.id, o.name, o.description) && hits.push(["objects", o.name, `#/objects/${o.id}`, o.preview]));
  d.sounds.forEach((s) => matches(q, s.id, s.name, s.description, s.usage) && hits.push(["sounds", s.name, "#/sounds", null]));
  d.music.forEach((t) => matches(q, t.id, t.name, t.use) && hits.push(["music", t.name, "#/music", null]));
  state.data.constants.forEach((c) => matches(q, c.name, c.description) && hits.push(["tuning", c.name, "#/tuning", null]));
  return h("div", {},
    h("h1", {}, `Search: “${q}”`),
    h("p", { class: "muted" }, `${hits.length} hits`),
    h("div", { class: "grid" }, ...hits.slice(0, 60).map(([domain, name, href, img]) =>
      h("a", { class: "card", href },
        img ? h("div", { class: "thumb checker" }, h("img", { src: assetUrl(img), loading: "lazy", alt: name })) : null,
        h("div", { class: "card-name" }, name),
        h("div", { class: "card-sub" }, domain)))));
}

/* ---------------------------------------------------------------- router */
function route() {
  destroyPlayers();
  const a = audioEl(); if (a && !a.paused) a.pause();
  const hash = location.hash.replace(/^#\/?/, "");
  const [page, id] = hash.split("/").map(decodeURIComponent);
  let view;
  if (state.query && !id) view = viewSearch();
  else if (page === "monsters") view = id ? viewMonster(id) : viewMonsters();
  else if (page === "characters") view = id ? viewCharacter(id) : viewCharacters();
  else if (page === "tiles") view = id ? viewTileType(id) : viewTiles();
  else if (page === "objects") view = id ? viewObject(id) : viewObjects();
  else if (page === "sounds") view = viewSounds();
  else if (page === "music") view = viewMusic();
  else if (page === "items") view = viewItems();
  else if (page === "tuning") view = viewTuning();
  else view = viewHome();
  $("#content").replaceChildren(view);
  renderNav();
  $("#sidebar").classList.remove("open");
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
  const [monTune, constTune, ...fbs] = apiState
    ? [fromApi((s) => s.tuning.monsters), fromApi((s) => s.tuning.constants),
       ...FEEDBACK_DOMAINS.map((d) => fromApi((s) => s.feedback[d]))]
    : await Promise.all([
        fetchJson(new URL("live/tuning/monsters.json", ROOT)),
        fetchJson(new URL("live/tuning/constants.json", ROOT)),
        ...FEEDBACK_DOMAINS.map((d) => fetchJson(new URL(`live/feedback/${d}.json`, ROOT))),
      ]);
  state.tuning.monsters = monTune ?? { format: "pixel-wiki-tuning-monsters@1", updated_at: "", defaults: {}, monsters: {} };
  state.tuning.constants = constTune ?? { format: "pixel-wiki-tuning-constants@1", updated_at: "", overrides: {} };
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
  d.tiles.forEach((t) => { add(t.path); t.groups.forEach((g) => g.tiles.forEach((f) => add(`${g.dir}/${f}`.replace(/\.png$/, "")))); });
  d.sounds.forEach((s) => { add(s.path); s.takes.forEach((t) => add(`${s.path}/${t.id}`)); });
}

function initChrome() {
  // theme
  const saved = localStorage.getItem("wiki-theme");
  if (saved) document.documentElement.dataset.theme = saved;
  $("#theme-toggle").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("wiki-theme", next);
  });
  // sidebar (mobile)
  $("#menu-btn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
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
  window.addEventListener("hashchange", route);
  window.addEventListener("beforeunload", (e) => { if (state.dirty.size) e.preventDefault(); });
}

function setAdmin(on) {
  state.admin = on;
  document.documentElement.classList.toggle("is-admin", on);
  const btn = $("#admin-btn");
  btn.textContent = on ? "Sign out (admin)" : "Admin";
  btn.title = on ? "Signed in as the game designer" : "Game-designer sign in";
  if (!on) { state.dirty.clear(); state.touched = {}; updateSavebar(); }
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
  $("#build-stamp").textContent = `built ${new Date(data.generated_at).toLocaleString()}`;
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
