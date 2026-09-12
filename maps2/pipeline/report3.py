"""THE CHANGE PAGE - filled in AFTER every push to main that changes a world
(maintainer 2026-09-12: "I want that artifact page filled in after every
push to main. Remember I said after! You can still push before me approving
the change! I just want to be able to review it afterwards.").

    python3 maps2/pipeline/report3.py maps2/reports/<world>.json <out_dir>

The log (`maps2/change-log@1`) is the source, kept in the repo so every run
appends its push and republishes the SAME page (`artifact` is its URL):
    {"schema": "maps2/change-log@1", "world": "the_game", "artifact": "https://...",
     "title": "...", "subtitle": "...",
     "pushes": [{"date": "2026-09-12", "commit": "abc123", "before": "def456",   # before: the world before the push (git)
                 "title": "...",
                 "changes": [{"name": "...", "what": "...", "cell": [x, y],
                              "window": [x0, y0, x1, y1],   # optional, default the cell +- 10 x 7
                              "before": "...",              # optional, overrides the push's
                              "cutaway": true}]}]}          # optional: lift the cave lids over the window
Pushes are listed oldest first and numbered straight through, so a change's
number never moves once he has quoted it; the page shows the newest push
first.

Writes out_dir/index.html, out_dir/img/<n>-after.webp and <n>-before.webp
(the same window from the world at the `before` commit, lossless) and
out_dir/img/minimap.webp, all paths relative, ready for the Artifact tool
(`files`). Each card shows "after" with a pill top-right; a tap on the image
flips it to "before" (maintainer 2026-09-12). "Show on map" opens the
minimap in a modal with the pin: the world's own minimap.json dot formula
with the cell's level from world.json, the same pixel the game's map tab
would put a body on. Coordinates are the shipped world's (post-recentre),
the ones the game shows under the player."""
import html
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.argv = [sys.argv[0]] + sys.argv[1:]
import render3  # noqa: E402


def world_at(commit, world, cache={}):
    """the shipped world.json at a git commit (the repo is the source)"""
    key = (commit, world)
    if key not in cache:
        raw = subprocess.check_output(["git", "-C", MAPS2, "show", f"{commit}:maps2/worlds3/{world}/world.json"])
        cache[key] = json.loads(raw)
    return cache[key]


def _window(doc, x0, y0, x1, y1, cutaway):
    d = doc
    if cutaway:
        d = dict(doc)
        d["decks"] = [dk for dk in doc["decks"] if not (dk["kind"] == "cave" and any(
            x0 <= c["x"] <= x1 and y0 <= c["y"] <= y1 for c in dk["cells"]))]
    return render3.render(d, x0, y0, x1, y1, log=lambda *a: None)


def build(spec, out):
    if spec.get("schema") == "maps2/change-log@1":
        return build_log(spec, out)
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
        cut = bool(ch.get("cutaway"))
        after = f"img/{n:02d}-after.webp"
        _window(doc, x0, y0, x1, y1, cut).convert("RGB").save(os.path.join(out, after), lossless=True, exact=True)
        before = None
        bc = ch.get("before", spec.get("before"))
        if bc:
            bdoc = world_at(bc, world)
            if bdoc["size"] == doc["size"]:
                before = f"img/{n:02d}-before.webp"
                _window(bdoc, x0, y0, x1, y1, cut).convert("RGB").save(os.path.join(out, before), lossless=True, exact=True)
        lvl = doc["level"][int(cy)][int(cx)]
        px = dot["kx"] * (cx - cy) + dot["x0"]
        py = dot["ky"] * (cx + cy) - dot["kz"] * lvl + dot["y0"]
        cards.append({"n": n, "name": ch["name"], "what": ch.get("what", ""), "cell": [cx, cy], "level": lvl,
                      "after": after, "before": before, "before_commit": bc or "",
                      "px": round(100 * px / mm["size"]["w"], 3), "py": round(100 * py / mm["size"]["h"], 3),
                      "cutaway": cut, "commit": ch.get("commit", spec.get("commit", ""))})
    page = render_page(spec, cards, mm)
    open(os.path.join(out, "index.html"), "w").write(page)
    return cards


SCRIPT = r"""<script>
(function () {
  var dlg = document.getElementById('mapdlg'), pin = document.getElementById('pin');
  var where = document.getElementById('where'), mtitle = document.getElementById('mtitle');
  var chips = document.getElementById('chips'), out = document.getElementById('out');
  var copyall = document.getElementById('copyall'), toast = document.getElementById('toast'), toastT = null;
  var cards = Array.prototype.slice.call(document.querySelectorAll('.change'));
  document.getElementById('mclose').addEventListener('click', function () { dlg.close(); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  function say(msg) {
    toast.textContent = msg; toast.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { toast.hidden = true; }, 1600);
  }
  function line(card) {
    return '#' + card.dataset.n + ' ' + card.dataset.name + ' — cell ' + card.dataset.cell + ', level ' + card.dataset.level
      + (card.dataset.commit ? ' — ' + card.dataset.commit : '');
  }
  function marked() { return cards.filter(function (c) { return c.querySelector('.sel').checked; }); }
  function refresh() {
    var m = marked();
    cards.forEach(function (c) { c.classList.toggle('picked', c.querySelector('.sel').checked); });
    chips.innerHTML = '';
    if (!m.length) {
      var none = document.createElement('span'); none.className = 'none';
      none.textContent = 'Nothing yet — tap a change’s title to mark it';
      chips.appendChild(none);
    }
    m.forEach(function (c) {
      var chip = document.createElement('span'); chip.className = 'chip'; chip.textContent = '#' + c.dataset.n;
      chips.appendChild(chip);
    });
    copyall.disabled = !m.length;
    out.value = m.map(line).join('\n');
  }
  function copyText(text) {
    out.value = text;
    function manual() { out.hidden = false; out.focus(); out.select(); say('Select the text below and copy'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { say('Copied'); }, manual);
    } else { manual(); }
  }
  document.getElementById('clear').addEventListener('click', function () {
    cards.forEach(function (c) { c.querySelector('.sel').checked = false; }); out.hidden = true; refresh();
  });
  copyall.addEventListener('click', function () {
    var m = marked();
    if (!m.length) return;
    copyText('Changes I do not like: ' + m.map(function (c) { return '#' + c.dataset.n; }).join(', ') + '\n' + m.map(line).join('\n'));
  });
  cards.forEach(function (card) {
    card.querySelector('.sel').addEventListener('change', refresh);
    card.querySelector('.show').addEventListener('click', function () {
      pin.style.left = card.dataset.px + '%';
      pin.style.top = card.dataset.py + '%';
      pin.classList.remove('pulse'); void pin.offsetWidth; pin.classList.add('pulse');
      mtitle.textContent = card.querySelector('h2').textContent;
      where.textContent = 'cell ' + card.dataset.cell;
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    });
    var img = card.querySelector('.shot img'), pill = card.querySelector('.pill');
    if (!pill) return;
    var showingBefore = false;
    function flip() {
      showingBefore = !showingBefore;
      img.src = showingBefore ? card.dataset.before : card.dataset.after;
      pill.textContent = showingBefore ? 'Before' : 'After';
      pill.setAttribute('aria-pressed', showingBefore ? 'true' : 'false');
    }
    img.addEventListener('click', flip);
    pill.addEventListener('click', flip);
  });
  refresh();
})();
</script>"""


def build_log(log, out):
    """the running log: every push's changes rendered, numbered straight
    through, the world of each push read from git at its commit"""
    world = log.get("world", "the_game")
    wdir = os.path.join(MAPS2, "worlds3", world)
    mm = json.load(open(os.path.join(wdir, "minimap.json")))
    dot = mm["dot"]
    os.makedirs(os.path.join(out, "img"), exist_ok=True)
    from PIL import Image
    Image.open(os.path.join(wdir, mm["image"])).save(os.path.join(out, "img", "minimap.webp"), lossless=True, exact=True)
    n, sections = 0, []
    for push in log["pushes"]:
        head = push["commit"].split("→")[-1].strip().split()[0]
        try:
            doc = world_at(head, world)
        except subprocess.CalledProcessError:
            doc = json.load(open(os.path.join(wdir, "world.json")))
        cards = []
        for ch in push["changes"]:
            n += 1
            cx, cy = ch["cell"]
            x0, y0, x1, y1 = ch.get("window") or (cx - 10, cy - 7, cx + 11, cy + 9)
            cut = bool(ch.get("cutaway"))
            after = f"img/{n:03d}-after.webp"
            if not os.path.exists(os.path.join(out, after)):
                _window(doc, x0, y0, x1, y1, cut).convert("RGB").save(os.path.join(out, after), lossless=True, exact=True)
            before = None
            bc = ch.get("before", push.get("before"))
            if bc:
                bdoc = world_at(bc, world)
                if bdoc["size"] == doc["size"]:
                    before = f"img/{n:03d}-before.webp"
                    if not os.path.exists(os.path.join(out, before)):
                        _window(bdoc, x0, y0, x1, y1, cut).convert("RGB").save(os.path.join(out, before), lossless=True, exact=True)
            lvl = doc["level"][int(cy)][int(cx)]
            px = dot["kx"] * (cx - cy) + dot["x0"]
            py = dot["ky"] * (cx + cy) - dot["kz"] * lvl + dot["y0"]
            cards.append({"n": n, "name": ch["name"], "what": ch.get("what", ""), "cell": [cx, cy], "level": lvl,
                          "after": after, "before": before, "before_commit": bc or "",
                          "px": round(100 * px / mm["size"]["w"], 3), "py": round(100 * py / mm["size"]["h"], 3),
                          "cutaway": cut, "commit": ch.get("commit", push.get("commit", ""))})
        sections.append({"date": push.get("date", ""), "commit": push.get("commit", ""),
                         "title": push.get("title", ""), "cards": cards})
    sections.reverse()
    page = render_page(log, sections, mm)
    open(os.path.join(out, "index.html"), "w").write(page)
    return [c for sct in sections for c in sct["cards"]]


def render_page(spec, cards, mm):
    title = html.escape(spec["title"])
    sub = html.escape(spec.get("subtitle", ""))
    commit = html.escape(spec.get("commit", ""))
    sections = cards if cards and isinstance(cards[0], dict) and "cards" in cards[0] else [{"cards": cards}]
    items = []
    for sct in sections:
        if sct.get("commit") or sct.get("title"):
            items.append(f'''
<h2 class="push"><span class="date">{html.escape(sct.get("date", ""))}</span> {html.escape(sct.get("title", ""))} <span class="mono">{html.escape(sct.get("commit", ""))}</span></h2>''')
        for c in sct["cards"]:
            items.append(card_html(c))
    return page_html(title, sub, commit, items, spec, mm)


def card_html(c):
    if True:
        pill = ""
        if c["before"]:
            pill = (f'<button type="button" class="pill" id="pill{c["n"]}" aria-pressed="false" '
                    f'aria-label="Flip between after and before">After</button>')
        before_attr = f' data-before="{c["before"]}"' if c["before"] else ""
        return f'''
<article class="change" id="c{c["n"]}" data-n="{c["n"]}" data-name="{html.escape(c["name"], quote=True)}" data-px="{c["px"]}" data-py="{c["py"]}" data-cell="{c["cell"][0]},{c["cell"][1]}" data-level="{c["level"]}" data-commit="{html.escape(c["commit"], quote=True)}" data-after="{c["after"]}"{before_attr}>
  <header>
    <label class="pick" for="sel{c["n"]}"><input type="checkbox" class="sel" id="sel{c["n"]}" aria-label="Mark change {c["n"]}"><span class="n">#{c["n"]}</span><h2>{html.escape(c["name"])}</h2></label>
    <button type="button" class="show" id="show{c["n"]}" aria-label="Show {html.escape(c["name"])} on the map">Show on map</button>
  </header>
  <p class="what">{html.escape(c["what"])}</p>
  <p class="meta"><span class="mono">cell {c["cell"][0]}, {c["cell"][1]}</span> · level {c["level"]}{" · lids lifted" if c["cutaway"] else ""}{(" · " + html.escape(c["commit"])) if c["commit"] else ""}{(" · before: " + html.escape(c["before_commit"])) if c["before"] else ""}</p>
  <div class="shot">
    <img src="{c["after"]}" alt="Render of {html.escape(c["name"])} around cell {c["cell"][0]}, {c["cell"][1]}" loading="lazy">
    {pill}
  </div>
</article>'''


def page_html(title, sub, commit, items, spec, mm):
    return f'''<title>{title}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,500;6..72,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root {{
  --bg: #eef0ec; --panel: #ffffff; --ink: #1c211e; --muted: #5c655f; --line: #d3d8d2;
  --accent: #2f7d5a; --accent-ink: #ffffff; --pin: #d7452b; --pin-ring: rgba(215, 69, 43, .35);
  --map-bg: #1a1c21; --scrim: rgba(20, 24, 22, .6); --pill: rgba(28, 33, 30, .78); --pill-ink: #ffffff;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --bg: #171a18; --panel: #20241f; --ink: #e6e9e4; --muted: #9aa39c; --line: #343a35;
    --accent: #5fc38f; --accent-ink: #10201a; --pin: #ff6a4d; --pin-ring: rgba(255, 106, 77, .4);
    --scrim: rgba(0, 0, 0, .7); --pill: rgba(230, 233, 228, .85); --pill-ink: #171a18;
  }}
}}
:root[data-theme="dark"] {{
  --bg: #171a18; --panel: #20241f; --ink: #e6e9e4; --muted: #9aa39c; --line: #343a35;
  --accent: #5fc38f; --accent-ink: #10201a; --pin: #ff6a4d; --pin-ring: rgba(255, 106, 77, .4);
  --scrim: rgba(0, 0, 0, .7); --pill: rgba(230, 233, 228, .85); --pill-ink: #171a18;
}}
body {{ background: var(--bg); color: var(--ink); font-family: "IBM Plex Sans", system-ui, sans-serif; line-height: 1.5; padding-block: 24px 64px; padding-inline: 16px; }}
main {{ max-width: 860px; margin: 0 auto; }}
h1 {{ font-family: "Newsreader", Georgia, serif; font-weight: 600; font-size: clamp(28px, 4vw, 40px); line-height: 1.1; margin: 0 0 6px; text-wrap: balance; }}
.sub {{ color: var(--muted); margin: 0 0 6px; max-width: 65ch; }}
.commit {{ font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 13px; color: var(--muted); margin: 0 0 22px; }}
.list {{ display: grid; gap: 18px; }}
.push {{ font-family: "Newsreader", Georgia, serif; font-weight: 500; font-size: 20px; margin: 18px 0 0; padding-top: 14px; border-top: 2px solid var(--line); display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; }}
.push .date {{ font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 13px; color: var(--muted); }}
.push .mono {{ font-size: 13px; color: var(--muted); }}
.change {{ background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px 16px; }}
.change header {{ display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }}
.change h2 {{ font-family: "Newsreader", Georgia, serif; font-weight: 500; font-size: 22px; margin: 0; flex: 1 1 200px; text-wrap: balance; }}
.n {{ font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 13px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; }}
.pick {{ display: flex; align-items: center; gap: 12px; cursor: pointer; flex: 1 1 260px; padding: 6px 8px 6px 4px; margin: -6px 0 -6px -4px; border-radius: 8px; user-select: none; }}
.pick:hover {{ background: var(--bg); }}
.pick input {{ width: 22px; height: 22px; accent-color: var(--pin); margin: 0; flex: none; }}
.pick h2 {{ flex: 1 1 160px; }}
.change.picked {{ border-color: var(--pin); box-shadow: 0 0 0 2px var(--pin-ring); }}
.change.picked .n {{ background: var(--pin); color: #fff; border-color: var(--pin); }}
.bar {{ position: fixed; left: 0; right: 0; bottom: 0; z-index: 3; background: var(--panel); border-top: 1px solid var(--line); padding: 10px 16px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; box-shadow: 0 -6px 24px rgba(0, 0, 0, .12); }}
.bar .label {{ font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); font-weight: 600; }}
.bar .chips {{ flex: 1 1 200px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; min-height: 28px; }}
.chip {{ font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 13px; background: var(--pin); color: #fff; border-radius: 999px; padding: 3px 10px; }}
.chips .none {{ color: var(--muted); font-size: 14px; }}
.bar .copy {{ background: var(--accent); color: var(--accent-ink); border: 0; border-radius: 8px; padding: 9px 16px; font: inherit; font-weight: 600; cursor: pointer; }}
.bar .copy:disabled {{ opacity: .5; cursor: default; }}
.bar .clear {{ background: transparent; color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; font: inherit; cursor: pointer; }}
.bar textarea {{ flex: 1 1 100%; width: 100%; min-height: 72px; font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 13px; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px; resize: vertical; }}
.bar textarea[hidden] {{ display: none; }}
.toast {{ position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 8px 14px; border-radius: 999px; font-size: 14px; z-index: 4; }}
.toast[hidden] {{ display: none; }}
body {{ padding-bottom: 120px; }}
.show {{ background: var(--accent); color: var(--accent-ink); border: 0; border-radius: 8px; padding: 8px 14px; font: inherit; font-weight: 600; cursor: pointer; }}
.show:hover {{ filter: brightness(1.08); }}
.show:focus-visible, .pill:focus-visible, .close:focus-visible {{ outline: 3px solid var(--pin); outline-offset: 2px; }}
.what {{ margin: 10px 0 4px; max-width: 65ch; }}
.meta {{ margin: 0 0 12px; font-size: 13px; color: var(--muted); }}
.mono {{ font-family: "IBM Plex Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; }}
.shot {{ position: relative; border-radius: 6px; overflow: hidden; background: var(--map-bg); }}
.shot img {{ display: block; width: 100%; height: auto; image-rendering: pixelated; cursor: pointer; }}
.pill {{ position: absolute; top: 10px; right: 10px; background: var(--pill); color: var(--pill-ink); border: 0; border-radius: 999px; padding: 5px 12px; font: inherit; font-size: 13px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; cursor: pointer; }}
.pill[aria-pressed="true"] {{ background: var(--pin); color: #fff; }}
dialog {{ border: 1px solid var(--line); border-radius: 12px; padding: 0; background: var(--panel); color: var(--ink); width: min(96vw, 1100px); max-width: 96vw; }}
dialog::backdrop {{ background: var(--scrim); }}
.mhead {{ display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); }}
.mhead h3 {{ margin: 0; flex: 1; font-family: "Newsreader", Georgia, serif; font-weight: 500; font-size: 20px; }}
.mhead .where {{ font-size: 13px; color: var(--muted); }}
.close {{ background: transparent; color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; font: inherit; cursor: pointer; }}
.mapbox {{ position: relative; width: 100%; background: var(--map-bg); }}
.mapbox img {{ display: block; width: 100%; height: auto; }}
.pin {{ position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: var(--pin); box-shadow: 0 0 0 3px var(--accent-ink), 0 0 0 7px var(--pin-ring); left: 50%; top: 50%; }}
@media (prefers-reduced-motion: no-preference) {{ .pin.pulse {{ animation: pulse 1.2s ease-out 3; }} }}
@keyframes pulse {{ 0% {{ box-shadow: 0 0 0 3px var(--accent-ink), 0 0 0 7px var(--pin-ring); }} 100% {{ box-shadow: 0 0 0 3px var(--accent-ink), 0 0 0 26px transparent; }} }}
</style>
<main>
  <h1>{title}</h1>
  <p class="sub">{sub}</p>
  <p class="commit">{commit}</p>
  <div class="list">{"".join(items)}
  </div>
</main>
<div class="bar" id="bar" role="region" aria-label="Marked changes">
  <span class="label">Marked</span>
  <span class="chips" id="chips"><span class="none">Nothing yet — tap a change's title to mark it</span></span>
  <button type="button" class="clear" id="clear">Clear</button>
  <button type="button" class="copy" id="copyall" disabled>Copy marked</button>
  <textarea id="out" readonly hidden aria-label="The text that Copy marked copies"></textarea>
</div>
<div class="toast" id="toast" hidden>Copied</div>
<dialog id="mapdlg" aria-labelledby="mtitle">
  <div class="mhead">
    <h3 id="mtitle">Where on the island</h3>
    <span class="where mono" id="where"></span>
    <button type="button" class="close" id="mclose">Close</button>
  </div>
  <div class="mapbox">
    <img src="img/minimap.webp" alt="Minimap of {html.escape(spec.get("world", "the_game"))}" width="{mm["size"]["w"]}" height="{mm["size"]["h"]}">
    <div class="pin" id="pin"></div>
  </div>
</dialog>
{SCRIPT}
'''


if __name__ == "__main__":
    spec = json.load(open(sys.argv[1]))
    cards = build(spec, sys.argv[2])
    print(f"{len(cards)} change(s) rendered into {sys.argv[2]}")
