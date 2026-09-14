"""The review page for ONE animation slot of the approved candidates — a
claude.ai Artifact with the clips PLAYING (maintainer: "send the page as an
artifact so I can see the real animation"), one row of eight canvases per
monster, a machine verdict under each direction and a redo toggle that collects
`id:direction` pairs to paste back into chat.

Self-contained: every clip is embedded as a lossless WebP sheet (columns =
frames, rows = the 8 directions) cropped to the clip's union box, so a 39-monster
slot stays a few MB under the 16 MB artifact ceiling. Output stays OUT of git
(same rule as review_artifact.py — the review gallery is a chat deliverable).

  python monsters/pipeline/review_slot.py --slot die_v1 -o /tmp/die_v1.html
  python monsters/pipeline/review_slot.py --slot die_v1 --only orc_warrior,basilisk
"""
from __future__ import annotations

import argparse
import base64
import html
import io
import json
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import candidates as cand  # noqa: E402
import mirror  # noqa: E402
from pixellab_client import DIRECTIONS_8  # noqa: E402

# a die plays once into the game's 1.1 s corpse window; on the page each clip
# plays through at this pace, holds its last frame, then starts over
FRAME_MS = 160
HOLD_MS = 900


def load_frames(cid, slot, d):
    p = os.path.join(cand.cdir(cid), "animations", slot, d)
    if not os.path.isdir(p):
        return []
    fs = sorted(f for f in os.listdir(p) if f.endswith(mirror.ART_EXT))
    return [Image.open(os.path.join(p, f)).convert("RGBA") for f in fs]


def build_sheet(cid, slot):
    """(w, h, counts, b64) — frames as columns, DIRECTIONS_8 as rows, every
    frame cropped by ONE union box so relative motion is untouched."""
    per = {d: load_frames(cid, slot, d) for d in DIRECTIONS_8}
    frames = [f for fs in per.values() for f in fs]
    if not frames:
        return None
    box = None
    for f in frames:
        b = f.getbbox()
        if b:
            box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
    box = box or (0, 0, frames[0].width, frames[0].height)
    w, h = box[2] - box[0], box[3] - box[1]
    cols = max(len(fs) for fs in per.values())
    sheet = Image.new("RGBA", (w * cols, h * len(DIRECTIONS_8)), (0, 0, 0, 0))
    for r, d in enumerate(DIRECTIONS_8):
        for c, f in enumerate(per[d]):
            sheet.alpha_composite(f.crop(box), (c * w, r * h))
    buf = io.BytesIO()
    sheet.save(buf, "WEBP", lossless=True, method=6, exact=True)
    return w, h, [len(per[d]) for d in DIRECTIONS_8], base64.b64encode(buf.getvalue()).decode()


def collect(slot, only=None):
    cfg = cand.load_cfg()
    out = []
    for design in cfg["candidates"]:
        cid = design["id"]
        if only and cid not in only:
            continue
        man = cand.load_manifest(cid)
        if not man or man.get("review") != "approved":
            continue
        rec = (man.get("animations") or {}).get(slot)
        built = build_sheet(cid, slot)
        if not rec and not built:
            continue
        dirs = {}
        for d in DIRECTIONS_8:
            q = ((rec or {}).get("directions") or {}).get(d) or {}
            dirs[d] = {"status": q.get("status") or "missing", "reasons": q.get("reasons") or [],
                       "rolls": q.get("rolls"), "rung": q.get("rung"), "mirrored": bool(q.get("mirrored")),
                       "loop": q.get("loop"), "end_area": q.get("end_area"), "action": q.get("action")}
        w, h, counts, b64 = built or (0, 0, [0] * 8, "")
        out.append({"id": cid, "name": design.get("name", cid), "tier": design.get("tier"), "scale": design.get("scale"),
                    "action": (rec or {}).get("action") or design.get(f"{slot.split('_')[0]}_action") or "",
                    "w": w, "h": h, "counts": counts, "b64": b64, "dirs": dirs})
    return out


PAGE = r"""<title>__TITLE__</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Silkscreen&family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono&display=swap">
<style>
  /* a bench for judging pixel art: cool slate neutrals that stay out of the
     art's way, a checker well for the transparency, verdicts by colour AND word */
  :root { --bg:#eef0f3; --fg:#1b1f26; --muted:#5f6772; --card:#f8f9fb; --line:#d6dae1;
          --well:#dfe3e9; --checker:#cfd4dc; --ok:#1f7a45; --warn:#9a6300; --bad:#b3261e; --acc:#2f56b5; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --bg:#14171c; --fg:#e6e9ee; --muted:#98a0ab; --card:#1c2027; --line:#2b313a;
    --well:#262b33; --checker:#30363f; --ok:#5fcf8a; --warn:#e0a92f; --bad:#ef6b62; --acc:#8fa8ff; } }
  :root[data-theme="dark"] { --bg:#14171c; --fg:#e6e9ee; --muted:#98a0ab; --card:#1c2027; --line:#2b313a;
    --well:#262b33; --checker:#30363f; --ok:#5fcf8a; --warn:#e0a92f; --bad:#ef6b62; --acc:#8fa8ff; }
  body { background:var(--bg); color:var(--fg); font:14px/1.45 "IBM Plex Sans", system-ui, sans-serif; padding:0 16px 120px; }
  header { position:sticky; top:0; background:var(--bg); padding:12px 0 8px; border-bottom:1px solid var(--line); z-index:2;
           display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  h1 { font:400 15px/1 "Silkscreen", "IBM Plex Mono", monospace; margin:0; letter-spacing:.02em; text-transform:uppercase; }
  .sum { color:var(--muted); font-size:13px; font-variant-numeric:tabular-nums; }
  button, input, label { font:inherit; }
  button, input[type=search] { padding:5px 10px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); }
  button:focus-visible, input:focus-visible { outline:2px solid var(--acc); outline-offset:1px; }
  .m { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; margin:12px 0; }
  .mh { display:flex; flex-wrap:wrap; gap:6px 14px; align-items:baseline; }
  .mh b { font-size:16px; font-weight:600; }
  .mono { font-family:"IBM Plex Mono", ui-monospace, monospace; font-size:12px; color:var(--muted); }
  .act { color:var(--muted); font-size:13px; margin:4px 0 8px; max-width:65ch; }
  .row { display:flex; flex-wrap:wrap; gap:8px; }
  .cell { display:flex; flex-direction:column; align-items:center; gap:4px; min-width:0; }
  .well { border-radius:6px; padding:6px; background:repeating-conic-gradient(var(--checker) 0% 25%, var(--well) 0% 50%) 0 0/16px 16px; }
  canvas { image-rendering:pixelated; display:block; max-width:100%; }
  .lab { font-size:12px; display:flex; gap:6px; align-items:center; }
  .pill { font-size:11px; padding:1px 6px; border-radius:999px; font-weight:600; letter-spacing:.02em; }
  .pass { color:var(--ok); background:color-mix(in srgb, var(--ok) 12%, transparent); }
  .warn { color:var(--warn); background:color-mix(in srgb, var(--warn) 14%, transparent); }
  .fail, .missing { color:var(--bad); background:color-mix(in srgb, var(--bad) 12%, transparent); }
  .why { font-size:11px; color:var(--muted); max-width:150px; text-align:center; }
  label.redo { font-size:12px; cursor:pointer; }
  #bar { position:fixed; left:0; right:0; bottom:0; background:var(--card); border-top:1px solid var(--line);
         padding:10px 16px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  #bar textarea { flex:1; min-width:200px; font:12px "IBM Plex Mono", ui-monospace, monospace; height:44px; background:var(--bg); color:var(--fg);
                  border:1px solid var(--line); border-radius:6px; padding:6px; }
  @media (prefers-reduced-motion: reduce) { * { transition:none !important; } }
</style>
<header>
  <h1>__TITLE__</h1><span class="sum" id="sum"></span>
  <button id="play">Pause</button>
  <input id="q" type="search" placeholder="filter…">
  <label><input type="checkbox" id="onlybad"> only warn/fail</label>
</header>
<main id="list"></main>
<div id="bar"><b>redo</b><textarea id="out" readonly placeholder="tick ✕ redo under a direction; the pairs land here — paste them back"></textarea><button id="copy">Copy</button></div>
<script>
const DATA = __DATA__, FRAME_MS = __FRAME_MS__, HOLD_MS = __HOLD_MS__;
const DIRS = __DIRS__;
const ABBR = {'south':'S','south-east':'SE','east':'E','north-east':'NE','north':'N','north-west':'NW','west':'W','south-west':'SW'};
const list = document.getElementById('list'), players = [];
let n = {pass:0, warn:0, fail:0, missing:0};
for (const m of DATA) {
  const card = document.createElement('section'); card.className = 'm';
  card.dataset.name = (m.id + ' ' + m.name + ' ' + m.tier).toLowerCase();
  card.dataset.bad = DIRS.some(d => m.dirs[d].status !== 'pass') ? '1' : '';
  card.innerHTML = `<div class="mh"><b>${m.name}</b><span class="mono">${m.id} · ${m.tier} · ${m.scale} · ${m.counts[0]} frames</span></div>
    <div class="act">${m.action.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>`;
  const row = document.createElement('div'); row.className = 'row';
  const img = new Image(); img.src = 'data:image/webp;base64,' + m.b64;
  DIRS.forEach((d, i) => {
    const q = m.dirs[d]; n[q.status] = (n[q.status] || 0) + 1;
    const cell = document.createElement('div'); cell.className = 'cell';
    const well = document.createElement('div'); well.className = 'well';
    const cv = document.createElement('canvas'); cv.width = m.w || 1; cv.height = m.h || 1;
    const disp = Math.min(Math.max(m.h * 2, 64), 160); cv.style.height = disp + 'px'; cv.style.width = (disp / (m.h || 1) * (m.w || 1)) + 'px';
    well.appendChild(cv); cell.appendChild(well);
    const why = q.reasons.filter(r => !r.startsWith('canvas grown')).join(' · ');
    cell.innerHTML += `<div class="lab"><span class="mono">${ABBR[d]}${q.mirrored ? '·m' : ''}</span>
        <span class="pill ${q.status}">${q.status}</span></div>
      <div class="why" title="${why.replace(/"/g,'&quot;')}">${why.slice(0, 70)}${why.length > 70 ? '…' : ''}</div>
      <label class="redo"><input type="checkbox" data-pair="${m.id}:${d}"> ✕ redo</label>`;
    row.appendChild(cell);
    players.push({cv: cell.querySelector('canvas'), img, m, dir: i, frame: 0, hold: 0, visible: false});
  });
  card.appendChild(row); list.appendChild(card);
}
document.getElementById('sum').textContent = `${DATA.length} monsters · ${n.pass} pass · ${n.warn} warn · ${n.fail} fail` + (n.missing ? ` · ${n.missing} missing` : '');
const io = new IntersectionObserver(es => { for (const e of es) { const p = players.find(p => p.cv === e.target); if (p) p.visible = e.isIntersecting; } }, {rootMargin: '160px'});
players.forEach(p => io.observe(p.cv));
function tick() {
  for (const p of players) {
    if (!p.visible || !p.img.complete || !p.m.w) continue;
    const ctx = p.cv.getContext('2d'); ctx.clearRect(0, 0, p.m.w, p.m.h);
    ctx.drawImage(p.img, p.frame * p.m.w, p.dir * p.m.h, p.m.w, p.m.h, 0, 0, p.m.w, p.m.h);
    const count = p.m.counts[p.dir] || 1;
    if (p.frame < count - 1) p.frame++;
    else if ((p.hold += FRAME_MS) >= HOLD_MS) { p.frame = 0; p.hold = 0; }
  }
}
let timer = null, playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
function setPlaying(on) { playing = on; document.getElementById('play').textContent = on ? 'Pause' : 'Play';
  if (on && !timer) timer = setInterval(tick, FRAME_MS); if (!on && timer) { clearInterval(timer); timer = null; } }
document.getElementById('play').onclick = () => setPlaying(!playing);
setPlaying(playing); if (!playing) tick();
function filter() {
  const q = document.getElementById('q').value.trim().toLowerCase(), bad = document.getElementById('onlybad').checked;
  for (const c of list.children) c.hidden = (q && !c.dataset.name.includes(q)) || (bad && !c.dataset.bad);
}
document.getElementById('q').oninput = filter; document.getElementById('onlybad').onchange = filter;
list.addEventListener('change', e => {
  if (!e.target.dataset.pair) return;
  document.getElementById('out').value = [...list.querySelectorAll('input[data-pair]:checked')].map(i => i.dataset.pair).join(' ');
});
document.getElementById('copy').onclick = () => { const t = document.getElementById('out'); t.select(); try { navigator.clipboard.writeText(t.value); } catch (e) {} };
</script>
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slot", required=True, help="e.g. die_v1")
    ap.add_argument("--only", help="comma-separated ids")
    ap.add_argument("-o", "--out", default=None, help="output HTML (default: /tmp/monsters_<slot>.html)")
    ap.add_argument("--frame-ms", type=int, default=FRAME_MS)
    ap.add_argument("--hold-ms", type=int, default=HOLD_MS)
    args = ap.parse_args()
    data = collect(args.slot, set(args.only.split(",")) if args.only else None)
    page = (PAGE.replace("__TITLE__", html.escape(f"Monster {args.slot} review"))
                .replace("__DATA__", json.dumps(data, separators=(",", ":")))
                .replace("__FRAME_MS__", str(args.frame_ms)).replace("__HOLD_MS__", str(args.hold_ms))
                .replace("__DIRS__", json.dumps(list(DIRECTIONS_8))))
    out = args.out or f"/tmp/monsters_{args.slot}.html"
    with open(out, "w") as f:
        f.write(page)
    n = sum(1 for m in data for d in m["dirs"].values() if d["status"] != "pass")
    print(f"{out}: {len(data)} monsters, {len(page) / 1e6:.1f} MB, {n} direction(s) not pass")


if __name__ == "__main__":
    main()
