"""Build the self-contained monster review page (a claude.ai Artifact).

The review gallery is a CHAT deliverable, not a repo page: this script emits a
single HTML file (default: outside the repo) with every monster's animations
embedded as lossless WebP sprite sheets + a canvas animator that reproduces the
review behavior exactly — play the full animation facing one direction, then
turn one 45° step and play again, all the way around.

Why sheets + canvas instead of the repo's __rotating.gif files: the artifact
must be fully self-contained (no external requests), and the GIFs total ~9 MB
while lossless WebP sheets of the same pixels are ~40% smaller — and canvas
playback keeps frame timing exact instead of trusting GIF encoders.

Usage:
  python monsters/pipeline/review_artifact.py [-o /path/review.html]
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os

from PIL import Image

from mirror import ROOT, STATES, iter_manifests
from pixellab_client import DIRECTIONS_8

FRAME_MS = 120


def build_sheet(mid, key):
    """(w, h, dir_names, dir_frame_counts, webp_bytes) for one animation —
    a grid of frames (columns) x directions (rows, DIRECTIONS_8 order)."""
    adir = os.path.join(ROOT, mid, "animations", key)
    per_dir = []
    for d in DIRECTIONS_8:
        dd = os.path.join(adir, d)
        if not os.path.isdir(dd):
            continue
        frames = [Image.open(os.path.join(dd, f)).convert("RGBA")
                  for f in sorted(os.listdir(dd)) if f.endswith(".png")]
        if frames:
            per_dir.append((d, frames))
    if not per_dir:
        return None
    w, h = per_dir[0][1][0].size
    maxf = max(len(fr) for _, fr in per_dir)
    sheet = Image.new("RGBA", (w * maxf, h * len(per_dir)), (0, 0, 0, 0))
    for row, (_, frames) in enumerate(per_dir):
        for col, f in enumerate(frames):
            sheet.paste(f, (col * w, row * h))
    bio = io.BytesIO()
    sheet.save(bio, "WEBP", lossless=True, method=6)
    return w, h, [d for d, _ in per_dir], [len(fr) for _, fr in per_dir], bio.getvalue()


def collect():
    """Registry of monsters + deduped animation sheets (a fallback state row
    reuses its target animation's sheet — embedded once)."""
    monsters, sheets = [], {}
    for mid, meta in iter_manifests():
        anims = meta.get("animations") or {}
        smap = meta.get("states") or {}
        for key in anims:
            built = build_sheet(mid, key)
            if built:
                w, h, dnames, dcounts, blob = built
                sheets[f"{mid}/{key}"] = {
                    "w": w, "h": h, "dirs": dnames, "counts": dcounts,
                    "b64": base64.b64encode(blob).decode(),
                }
        rows = []
        for s in STATES:
            key = smap.get(s)
            rows.append({
                "state": s,
                "key": key,
                "sheet": f"{mid}/{key}" if key and f"{mid}/{key}" in sheets else None,
                "fallback": bool(key) and key != s,
                "source": (anims.get(key) or {}).get("source_name") if key else None,
            })
        buf = io.BytesIO()
        Image.open(os.path.join(ROOT, mid, "sprite.png")).save(buf, "PNG")
        monsters.append({
            "id": mid,
            "name": meta.get("name") or mid,
            "kind": meta.get("source", {}).get("kind"),
            "url": meta.get("source", {}).get("url"),
            "prompt": (meta.get("source", {}).get("prompt") or "").strip(),
            "lore": meta.get("lore") or "",
            "size": meta.get("size"),
            "sprite": base64.b64encode(buf.getvalue()).decode(),
            "rows": rows,
        })
    return monsters, sheets


PAGE = r"""<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monster review — every creature, every state</title>
<style>
  :root {
    --ground:#f2efe8; --card:#ffffff; --card-line:#e2dccd; --well:#eae5d8;
    --checker:#dfd9c9; --ink:#26221c; --muted:#7a7264; --accent:#3e7a4e;
    --accent-ink:#ffffff; --warn:#b57614; --bad:#c14a3a; --chip:#f0ece1;
  }
  @media (prefers-color-scheme: dark) { :root {
    --ground:#191d18; --card:#212721; --card-line:#313931; --well:#1c221c;
    --checker:#262d26; --ink:#e9ece4; --muted:#98a092; --accent:#8fd0a0;
    --accent-ink:#15241a; --warn:#d99a3d; --bad:#e07b6c; --chip:#2a312a;
  } }
  :root[data-theme="light"] {
    --ground:#f2efe8; --card:#ffffff; --card-line:#e2dccd; --well:#eae5d8;
    --checker:#dfd9c9; --ink:#26221c; --muted:#7a7264; --accent:#3e7a4e;
    --accent-ink:#ffffff; --warn:#b57614; --bad:#c14a3a; --chip:#f0ece1;
  }
  :root[data-theme="dark"] {
    --ground:#191d18; --card:#212721; --card-line:#313931; --well:#1c221c;
    --checker:#262d26; --ink:#e9ece4; --muted:#98a092; --accent:#8fd0a0;
    --accent-ink:#15241a; --warn:#d99a3d; --bad:#e07b6c; --chip:#2a312a;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--ground); color:var(--ink);
         font:15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .mono { font-family: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace; }
  header { position:sticky; top:0; z-index:5; background:var(--ground);
           border-bottom:1px solid var(--card-line); padding:10px 14px; }
  .hrow { max-width:960px; margin:0 auto; display:flex; gap:12px;
          align-items:center; flex-wrap:wrap; }
  h1 { font-size:17px; margin:0; letter-spacing:.01em; }
  .sum { color:var(--muted); font-size:12.5px; }
  #q { margin-left:auto; padding:6px 10px; border-radius:8px; font-size:13px;
       border:1px solid var(--card-line); background:var(--card); color:var(--ink);
       width:150px; }
  #playtoggle { padding:6px 12px; border-radius:8px; font-size:13px; border:1px solid
       var(--card-line); background:var(--accent); color:var(--accent-ink);
       cursor:pointer; font-weight:600; }
  main { max-width:960px; margin:0 auto; padding:14px 14px 60px; }
  .monster { background:var(--card); border:1px solid var(--card-line);
             border-radius:12px; margin:0 0 18px; overflow:hidden; }
  .mhead { display:flex; gap:12px; align-items:center; padding:12px 14px;
           border-bottom:1px solid var(--card-line); flex-wrap:wrap; }
  .spritechip { width:64px; height:64px; flex:none; border-radius:8px;
    background:
      repeating-conic-gradient(var(--checker) 0% 25%, var(--well) 0% 50%) 0 0/16px 16px;
    display:flex; align-items:center; justify-content:center; }
  .spritechip img { image-rendering:pixelated; max-width:56px; max-height:56px; }
  .mtitle { font-weight:700; font-size:16.5px; }
  .kind { font-size:10.5px; letter-spacing:.08em; text-transform:uppercase;
          padding:2px 8px; border-radius:99px; margin-left:8px; vertical-align:2px;
          background:var(--chip); color:var(--muted); }
  .mmeta { color:var(--muted); font-size:12px; margin-top:2px; }
  .mmeta a { color:var(--accent); text-decoration:none; }
  .lore { color:var(--ink); font-size:13px; max-width:62ch; margin-top:3px;
          font-style:italic; }
  .prompt { color:var(--muted); font-size:11.5px; max-width:62ch; margin-top:2px;
            opacity:.75; }
  .row { display:flex; gap:14px; padding:10px 14px; align-items:center;
         border-top:1px solid var(--card-line); }
  .row:first-of-type { border-top:none; }
  .rail { flex:0 0 128px; display:flex; flex-direction:column; gap:5px; }
  .state { font-size:12px; letter-spacing:.1em; text-transform:uppercase;
           font-weight:700; }
  .pill { font-size:11px; padding:2px 7px; border-radius:99px; width:max-content; }
  .pill.fb { background:color-mix(in srgb, var(--warn) 14%, transparent);
             color:var(--warn); }
  .pill.miss { background:color-mix(in srgb, var(--bad) 14%, transparent);
               color:var(--bad); font-weight:600; }
  .pill.part { background:color-mix(in srgb, var(--bad) 10%, transparent);
               color:var(--bad); }
  .facing { color:var(--muted); font-size:11px; min-height:14px; }
  .well { flex:1; border-radius:10px; min-height:72px; display:flex;
    align-items:center; padding:10px; overflow-x:auto;
    background:
      repeating-conic-gradient(var(--checker) 0% 25%, var(--well) 0% 50%) 0 0/16px 16px; }
  canvas { image-rendering:pixelated; display:block; }
  .nofile { color:var(--bad); font-size:13px; }
  footer { max-width:960px; margin:0 auto; padding:0 14px 40px;
           color:var(--muted); font-size:12px; }
  @media (max-width:560px) { .rail { flex-basis:96px; } }
</style>
<header><div class="hrow">
  <h1>Monster review</h1>
  <span class="sum" id="sum">…</span>
  <button id="playtoggle">Pause</button>
  <input id="q" type="search" placeholder="filter…">
</div></header>
<main id="list"></main>
<footer>Each clip plays its full animation facing one direction, then turns one
step (45°) and plays again — all 8 headings per loop. <span class="mono">angry
→ idle</span> means no angry animation exists on PixelLab and the game reuses
idle. Mirrored from PixelLab by the monsters agent; state contract:
<span class="mono">monsters/animation_map.json</span>.</footer>
<script>
const DATA = __DATA__;
const FRAME_MS = __FRAME_MS__;
const ABBR = { 'south':'S', 'south-east':'SE', 'east':'E', 'north-east':'NE',
               'north':'N', 'north-west':'NW', 'west':'W', 'south-west':'SW' };
const players = [];
let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;

const list = document.getElementById('list');
let nMiss = 0, nFb = 0;
for (const m of DATA.monsters) {
  const card = document.createElement('section');
  card.className = 'monster';
  card.dataset.name = (m.id + ' ' + m.name + ' ' + m.prompt).toLowerCase();
  const head = document.createElement('div');
  head.className = 'mhead';
  head.innerHTML = `
    <div class="spritechip"><img src="data:image/png;base64,${m.sprite}" alt=""></div>
    <div>
      <div class="mtitle">${m.name}<span class="kind">${m.kind}</span></div>
      <div class="mmeta mono">${m.id} · ${m.size.width}×${m.size.height}px ·
        <a href="${m.url}" target="_blank" rel="noopener">PixelLab ↗</a></div>
      <div class="lore">${m.lore}</div>
      <div class="prompt">${m.prompt}</div>
    </div>`;
  card.appendChild(head);
  for (const r of m.rows) {
    const row = document.createElement('div');
    row.className = 'row';
    const rail = document.createElement('div');
    rail.className = 'rail';
    let pills = '';
    if (!r.sheet) { pills += '<span class="pill miss">missing on PixelLab</span>'; nMiss++; }
    else if (r.fallback) { pills += `<span class="pill fb">→ ${r.key} (fallback)</span>`; nFb++; }
    const sh = r.sheet ? DATA.sheets[r.sheet] : null;
    if (sh && sh.dirs.length < 8)
      pills += `<span class="pill part">${sh.dirs.length}/8 directions</span>`;
    rail.innerHTML = `<div class="state mono">${r.state}</div>${pills}
      <div class="facing mono"></div>`;
    row.appendChild(rail);
    const well = document.createElement('div');
    well.className = 'well';
    if (sh) {
      const cv = document.createElement('canvas');
      cv.width = sh.w; cv.height = sh.h;
      const disp = Math.min(sh.h * 2, 192);
      cv.style.height = disp + 'px';
      cv.style.width = (disp / sh.h * sh.w) + 'px';
      well.appendChild(cv);
      players.push({ cv, sh, facing: rail.querySelector('.facing'),
                     dir: 0, frame: 0, visible: false, img: null });
    } else {
      well.innerHTML = `<span class="nofile">no ${r.state} animation — generate it
        on PixelLab and resync</span>`;
    }
    row.appendChild(well);
    card.appendChild(row);
  }
  list.appendChild(card);
}

const uniqueSheets = Object.keys(DATA.sheets).length;
document.getElementById('sum').textContent =
  `${DATA.monsters.length} monsters · ${uniqueSheets} animations · 8 directions` +
  (nFb ? ` · ${nFb} fallbacks` : '') + (nMiss ? ` · ${nMiss} missing` : '');

// decode each sheet once, share across rows (fallback rows reuse the target's)
const imgCache = {};
for (const p of players) {
  const key = Object.keys(DATA.sheets).find(k => DATA.sheets[k] === p.sh);
  if (!imgCache[key]) {
    const img = new Image();
    img.src = 'data:image/webp;base64,' + p.sh.b64;
    imgCache[key] = img;
  }
  p.img = imgCache[key];
}

const io = new IntersectionObserver(es => {
  for (const e of es) {
    const p = players.find(p => p.cv === e.target);
    if (p) p.visible = e.isIntersecting;
  }
}, { rootMargin: '120px' });
players.forEach(p => io.observe(p.cv));

function tick() {
  for (const p of players) {
    if (!p.visible || !p.img.complete) continue;
    const ctx = p.cv.getContext('2d');
    ctx.clearRect(0, 0, p.sh.w, p.sh.h);
    ctx.drawImage(p.img, p.frame * p.sh.w, p.dir * p.sh.h, p.sh.w, p.sh.h,
                  0, 0, p.sh.w, p.sh.h);
    p.facing.textContent = 'facing ' + (ABBR[p.sh.dirs[p.dir]] || p.sh.dirs[p.dir]);
    p.frame++;
    if (p.frame >= p.sh.counts[p.dir]) {          // played through -> turn 45°
      p.frame = 0;
      p.dir = (p.dir + 1) % p.sh.dirs.length;
    }
  }
}
let timer = null;
function setPlaying(on) {
  playing = on;
  document.getElementById('playtoggle').textContent = on ? 'Pause' : 'Play';
  if (on && !timer) timer = setInterval(tick, FRAME_MS);
  if (!on && timer) { clearInterval(timer); timer = null; }
}
document.getElementById('playtoggle').addEventListener('click', () => setPlaying(!playing));
setPlaying(playing);
if (!playing) tick();   // reduced motion: render first frames, paused

document.getElementById('q').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase();
  for (const c of list.children)
    c.style.display = !q || c.dataset.name.includes(q) ? '' : 'none';
});
</script>
"""


def main():
    ap = argparse.ArgumentParser(description="Emit the self-contained monster review HTML.")
    ap.add_argument("-o", "--out", default="/tmp/monster_review.html")
    args = ap.parse_args()
    monsters, sheets = collect()
    data = json.dumps({"monsters": monsters, "sheets": sheets})
    html = PAGE.replace("__DATA__", data).replace("__FRAME_MS__", str(FRAME_MS))
    with open(args.out, "w") as f:
        f.write(html)
    print(f"{args.out}: {len(monsters)} monsters, {len(sheets)} sheets, "
          f"{os.path.getsize(args.out) / 1048576:.1f} MB")


if __name__ == "__main__":
    main()
