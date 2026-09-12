"""THE CHANGE PAGE - every map change ships with one (maintainer 2026-09-12:
"From now on I always want to see an artifact page with screenshots of each
change with a 'show on map' button I can click on to see where this location
is on the minimap").

    python3 maps2/pipeline/report3.py <spec.json> <out_dir>

spec.json:
    {"title": "...", "subtitle": "...", "world": "the_game", "commit": "abc123",
     "changes": [{"name": "...", "what": "...", "cell": [x, y],
                  "window": [x0, y0, x1, y1],     # optional, default the cell +- 10 x 7
                  "cutaway": true}]}              # optional: lift the cave lids over the window

Writes out_dir/index.html, out_dir/img/<n>.webp (one render per change,
lossless) and out_dir/img/minimap.webp, all paths relative, ready for the
Artifact tool (`files`). The pin uses the world's own minimap.json dot
formula with the cell's level from world.json, so it is the same pixel the
game's map tab would put a body on. Coordinates are the shipped world's
(post-recentre), the ones the game shows under the player."""
import html
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.argv = [sys.argv[0]] + sys.argv[1:]
import render3  # noqa: E402


def build(spec, out):
    world = spec.get("world", "the_game")
    wdir = os.path.join(MAPS2, "worlds3", world)
    doc = json.load(open(os.path.join(wdir, "world.json")))
    mm = json.load(open(os.path.join(wdir, "minimap.json")))
    dot = mm["dot"]
    os.makedirs(os.path.join(out, "img"), exist_ok=True)
    from PIL import Image
    Image.open(os.path.join(wdir, mm["image"])).save(os.path.join(out, "img", "minimap.webp"), lossless=True, exact=True)
    cards = []
    for n, ch in enumerate(spec["changes"], 1):
        cx, cy = ch["cell"]
        x0, y0, x1, y1 = ch.get("window") or (cx - 10, cy - 7, cx + 11, cy + 9)
        d = doc
        if ch.get("cutaway"):
            d = dict(doc)
            d["decks"] = [dk for dk in doc["decks"] if not (dk["kind"] == "cave" and any(
                x0 <= c["x"] <= x1 and y0 <= c["y"] <= y1 for c in dk["cells"]))]
        img = render3.render(d, x0, y0, x1, y1, log=lambda *a: None)
        name = f"{n:02d}.webp"
        img.convert("RGB").save(os.path.join(out, "img", name), lossless=True, exact=True)
        lvl = doc["level"][int(cy)][int(cx)]
        px = dot["kx"] * (cx - cy) + dot["x0"]
        py = dot["ky"] * (cx + cy) - dot["kz"] * lvl + dot["y0"]
        cards.append({"n": n, "name": ch["name"], "what": ch.get("what", ""), "cell": [cx, cy], "level": lvl,
                      "img": "img/" + name, "px": round(100 * px / mm["size"]["w"], 3),
                      "py": round(100 * py / mm["size"]["h"], 3),
                      "cutaway": bool(ch.get("cutaway")), "commit": ch.get("commit", spec.get("commit", ""))})
    page = render_page(spec, cards, mm)
    open(os.path.join(out, "index.html"), "w").write(page)
    return cards


def render_page(spec, cards, mm):
    title = html.escape(spec["title"])
    sub = html.escape(spec.get("subtitle", ""))
    commit = html.escape(spec.get("commit", ""))
    items = []
    for c in cards:
        items.append(f'''
<article class="change" id="c{c["n"]}" data-px="{c["px"]}" data-py="{c["py"]}" data-cell="{c["cell"][0]},{c["cell"][1]}">
  <header>
    <span class="n">{c["n"]}</span>
    <h2>{html.escape(c["name"])}</h2>
    <button type="button" class="show" id="show{c["n"]}" aria-label="Show {html.escape(c["name"])} on the map">Show on map</button>
  </header>
  <p class="what">{html.escape(c["what"])}</p>
  <p class="meta"><span class="mono">cell {c["cell"][0]}, {c["cell"][1]}</span> · level {c["level"]}{" · lids lifted" if c["cutaway"] else ""}{(" · " + html.escape(c["commit"])) if c["commit"] else ""}</p>
  <img src="{c["img"]}" alt="Render of {html.escape(c["name"])} around cell {c["cell"][0]}, {c["cell"][1]}" loading="lazy">
</article>''')
    return f'''<title>{title}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,500;6..72,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root {{
  --bg: #eef0ec; --panel: #ffffff; --ink: #1c211e; --muted: #5c655f; --line: #d3d8d2;
  --accent: #2f7d5a; --accent-ink: #ffffff; --pin: #d7452b; --pin-ring: rgba(215, 69, 43, .35);
  --map-bg: #1a1c21;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --bg: #171a18; --panel: #20241f; --ink: #e6e9e4; --muted: #9aa39c; --line: #343a35;
    --accent: #5fc38f; --accent-ink: #10201a; --pin: #ff6a4d; --pin-ring: rgba(255, 106, 77, .4);
  }}
}}
:root[data-theme="dark"] {{
  --bg: #171a18; --panel: #20241f; --ink: #e6e9e4; --muted: #9aa39c; --line: #343a35;
  --accent: #5fc38f; --accent-ink: #10201a; --pin: #ff6a4d; --pin-ring: rgba(255, 106, 77, .4);
}}
body {{ background: var(--bg); color: var(--ink); font-family: "IBM Plex Sans", system-ui, sans-serif; line-height: 1.5; padding-block: 24px 64px; padding-inline: 16px; }}
.wrap {{ max-width: 1240px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 520px); gap: 28px; align-items: start; }}
@media (max-width: 860px) {{ .wrap {{ grid-template-columns: minmax(0, 1fr); }} }}
h1 {{ font-family: "Newsreader", Georgia, serif; font-weight: 600; font-size: clamp(28px, 4vw, 40px); line-height: 1.1; margin: 0 0 6px; text-wrap: balance; }}
.sub {{ color: var(--muted); margin: 0 0 20px; max-width: 65ch; }}
.commit {{ font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 13px; color: var(--muted); }}
.map {{ position: sticky; top: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px; }}
@media (max-width: 860px) {{ .map {{ position: sticky; top: 0; z-index: 2; order: -1; }} }}
.map h3 {{ margin: 0 0 8px; font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); font-weight: 600; }}
.mapbox {{ position: relative; width: 100%; background: var(--map-bg); border-radius: 6px; overflow: hidden; }}
.mapbox img {{ display: block; width: 100%; height: auto; }}
.pin {{ position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: var(--pin); box-shadow: 0 0 0 3px var(--accent-ink), 0 0 0 7px var(--pin-ring); left: 50%; top: 50%; }}
.pin[hidden] {{ display: none; }}
@media (prefers-reduced-motion: no-preference) {{ .pin.pulse {{ animation: pulse 1.2s ease-out 3; }} }}
@keyframes pulse {{ 0% {{ box-shadow: 0 0 0 3px var(--accent-ink), 0 0 0 7px var(--pin-ring); }} 100% {{ box-shadow: 0 0 0 3px var(--accent-ink), 0 0 0 26px transparent; }} }}
.where {{ margin: 10px 0 0; font-size: 14px; color: var(--muted); min-height: 1.5em; }}
.where b {{ color: var(--ink); font-weight: 600; }}
.list {{ display: grid; gap: 18px; }}
.change {{ background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px 16px; }}
.change.active {{ border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }}
.change header {{ display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }}
.change h2 {{ font-family: "Newsreader", Georgia, serif; font-weight: 500; font-size: 22px; margin: 0; flex: 1 1 200px; text-wrap: balance; }}
.n {{ font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 13px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; }}
.show {{ background: var(--accent); color: var(--accent-ink); border: 0; border-radius: 8px; padding: 8px 14px; font: inherit; font-weight: 600; cursor: pointer; }}
.show:hover {{ filter: brightness(1.08); }}
.show:focus-visible {{ outline: 3px solid var(--pin); outline-offset: 2px; }}
.what {{ margin: 10px 0 4px; max-width: 65ch; }}
.meta {{ margin: 0 0 12px; font-size: 13px; color: var(--muted); }}
.mono {{ font-family: "IBM Plex Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; }}
.change img {{ display: block; width: 100%; height: auto; border-radius: 6px; background: var(--map-bg); image-rendering: pixelated; }}
</style>
<div class="wrap">
  <main>
    <h1>{title}</h1>
    <p class="sub">{sub}</p>
    <p class="commit">{commit}</p>
    <div class="list">{"".join(items)}
    </div>
  </main>
  <aside class="map">
    <h3>Where on the island</h3>
    <div class="mapbox">
      <img src="img/minimap.webp" alt="Minimap of {html.escape(spec.get("world", "the_game"))}" width="{mm["size"]["w"]}" height="{mm["size"]["h"]}">
      <div class="pin" id="pin" hidden></div>
    </div>
    <p class="where" id="where">Press “Show on map” on a change.</p>
  </aside>
</div>
<script>
(function () {{
  var pin = document.getElementById('pin'), where = document.getElementById('where'), active = null;
  document.querySelectorAll('.change').forEach(function (card) {{
    card.querySelector('.show').addEventListener('click', function () {{
      pin.style.left = card.dataset.px + '%';
      pin.style.top = card.dataset.py + '%';
      pin.hidden = false;
      pin.classList.remove('pulse'); void pin.offsetWidth; pin.classList.add('pulse');
      if (active) active.classList.remove('active');
      active = card; card.classList.add('active');
      where.innerHTML = '<b>' + card.querySelector('h2').textContent + '</b> · cell ' + card.dataset.cell;
      if (window.innerWidth <= 860) window.scrollTo({{ top: 0, behavior: 'smooth' }});
    }});
  }});
}})();
</script>
'''


if __name__ == "__main__":
    spec = json.load(open(sys.argv[1]))
    cards = build(spec, sys.argv[2])
    print(f"{len(cards)} change(s) rendered into {sys.argv[2]}")
