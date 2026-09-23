"""THE CHANGE PAGE - filled in AFTER every push to main that changes a world
(maintainer 2026-09-12: "I want that artifact page filled in after every
push to main. Remember I said after! You can still push before me approving
the change! I just want to be able to review it afterwards.").

    python3 maps2/pipeline/report3.py maps2/reports/<world>.json <out_dir> \
        --push=<commit|latest>       # ONE push - what a reply links

ONE OUT_DIR PER PUSH (`<scratch>/push-<commit>`). The Artifact tool keys a
published page by the FILE PATH it came from, so rendering a second push into
the same out_dir republishes the FIRST push's URL - it does not make the new
page. Measured 2026-09-13: it overwrote the running log with one push's cards.

The log (`maps2/change-log@1`) is the source, kept in the repo so every run
appends its push and republishes the SAME page (`artifact` is its URL):
    {"schema": "maps2/change-log@1", "world": "the_game", "artifact": "https://...",
     "title": "...", "subtitle": "...",
     "pushes": [{"date": "2026-09-12", "commit": "abc123", "before": "def456",   # before: the world before the push (git)
                 "title": "...",
                 "changes": [{"name": "...", "what": "...", "cell": [x, y],
                              "window": [x0, y0, x1, y1],   # optional, default the cell +- 10 x 7
                              "before": "...",              # optional, overrides the push's
                              "cutaway": true,              # optional: lift the cave lids over the window
                              "roofcut": true,              # ...and the house roofs, to show a room
                              "overlay": "cavewalls"}]}]}   # optional (or per push): spawns, spawndensity,
                                                            # cavewalls (each cave wall cell in its named side, red unnamed)
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


def sidecar_at(commit, world, name):
    """A sidecar (spawns.json, ambient.json ...) as it was at a commit, or None
    when that commit had none."""
    key = (commit, world, name)
    if key not in _side_cache:
        try:
            raw = subprocess.check_output(["git", "-C", MAPS2, "show",
                                           f"{commit}:maps2/worlds3/{world}/{name}"],
                                          stderr=subprocess.DEVNULL)
            _side_cache[key] = json.loads(raw)
        except (subprocess.CalledProcessError, ValueError):
            _side_cache[key] = None
    return _side_cache[key]


_side_cache = {}


def spawn_field(doc, sdoc, world):
    """The crowding law's own field - expected monsters on each surface - as
    {(x, y): (level, density)}. THE OVERLAY FOR A POPULATION PUSH, and only
    that: `num / |zone cells|` is the blind spot the island law closes, so a
    push that changes WHERE monsters may stand must use `spawn_ground`
    instead. A push that changes HOW MANY is exactly what this shows."""
    if not sdoc:
        return {}
    import spawns
    w = spawns.W3(world, doc)
    out = {}
    for z in sdoc.get("zones", []):
        try:
            cells = spawns.spawn_cells(w, z)
        except AssertionError:
            continue
        if not cells:
            continue
        d = z["num"] / len(cells)
        for (x, y, lv) in cells:
            k = (x, y)
            if k not in out or out[k][0] < lv:
                out[k] = (lv, out.get(k, (0, 0.0))[1] + d)
            else:
                out[k] = (out[k][0], out[k][1] + d)
    return out


def spawn_ground(doc, sdoc, world):
    """Where a monster may be seeded, and whether it could ever LEAVE: {(x, y):
    (level, trapped)}.

    NOT the crowding law's density field. That field is `num / |zone cells|`
    smeared over the zone, which is precisely the blind spot this page had to
    show - painted, it made the island look emptier BEFORE the fix than after,
    because a 25-cell island inherits a 1,777-cell zone's comfortable average.
    What actually changed is which spawn ground is CUT OFF: a cell in a zone
    whose patch is not walk-connected to that zone's body is ground a monster
    can be put on and can never walk out of."""
    if not sdoc:
        return {}
    import spawnfit
    import spawns
    w = spawns.W3(world, doc)
    out = {}
    for z in sdoc.get("zones", []):
        try:
            cells = spawns.spawn_cells(w, z)
        except AssertionError:
            continue
        if not cells:
            continue
        ps = spawnfit.patches(cells)
        body = ps[0]
        for (x, y, lv) in cells:
            trapped = (x, y, lv) not in body
            k = (x, y)
            if k not in out or out[k][0] < lv:
                out[k] = (lv, trapped)
            elif trapped:
                out[k] = (out[k][0], True)
    return out


# the overlay "cavewalls": one diamond per cave wall cell in its NAMED side,
# RED where the cell is unnamed (the game then caps its cut stump with the
# cell's own top - the field's grass on the walls of a stone cave)
WALL_COL = {"grey_stone": (175, 178, 190, 170), "black_rock": (35, 35, 42, 190), "ice": (150, 225, 255, 170),
            "dark_mud": (120, 85, 50, 170), "light_soil": (200, 170, 120, 170), "light_beach": (235, 215, 150, 170),
            "snow": (245, 245, 250, 170)}


def wall_ground(doc, pdoc):
    """{(x, y): (level, side or None)} for every cell the cave-wall rule
    names (cavewalls.ring_names), with the side walls[] gives it today."""
    import cavewalls
    g = cavewalls.cave_state(cavewalls._grow(doc), (pdoc or {}).get("places", []))
    have = {(c["x"], c["y"]): w["side"] for w in doc["walls"]
            if w.get("kind") in ("house", "cliff") for c in w["cells"]}
    return {(x, y): (doc["level"][y][x], have.get((x, y))) for (x, y) in cavewalls.ring_names(g)}


def paint_density(img, doc, dens, x0, y0, x1, y1, vmax=None):
    """Paint the spawn ground over a rendered window: one diamond per cell,
    BLUE where a monster may stand and RED where it would be trapped - ground
    inside a zone whose patch that zone's body cannot reach. render3's own
    projection (DX/DY, the measured storey pitch, the doc-wide max level), so
    the diamond lands exactly on the cell's top face."""
    if not dens:
        return img
    from PIL import Image, ImageDraw
    DX, DY, LP = 32.0, 14.0, render3.storey_pitch(render3.over_tile("grey_stone", "grey_stone"))
    maxL = max(max(r) for r in doc["level"])
    ox = (y1 - 1 - y0) * DX + 8
    oy = maxL * 17 + 24
    lay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    for (x, y), (lv, v) in sorted(dens.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        if not (x0 <= x < x1 and y0 <= y < y1):
            continue
        bx = ox + (x - x0 - (y - y0)) * DX - DX
        by = oy + (x - x0 + y - y0) * DY - lv * LP - DY
        # Never a terrain colour: a green ramp over the meadow and an orange
        # one over the lava both read as ground, and the first cut of this
        # page washed the plateau green and showed him nothing.
        if vmax is None and not isinstance(v, bool):
            col = WALL_COL.get(v) or (235, 45, 55, 190)      # a cave wall: its side, RED when unnamed
        elif vmax is None:
            col = (235, 45, 55, 190) if v else (70, 120, 255, 70)
        else:
            # A POPULATION PUSH IS A CHANGE OF DEGREE, so both pictures are
            # scaled by the SAME maximum - the one from BEFORE - and the after
            # picture is simply cooler everywhere.
            t = min(1.0, (v / vmax) ** 0.55) if vmax > 0 else 0.0
            col = (int(55 + 200 * t), int(120 - 80 * t), int(255 - 210 * t), int(60 + 130 * t))
        d.polygon([(bx + 32, by), (bx + 64, by + 14), (bx + 32, by + 28), (bx, by + 14)], fill=col)
    return Image.alpha_composite(img.convert("RGBA"), lay)


def _window(doc, x0, y0, x1, y1, cutaway, roofcut=False, dens=None, vmax=None):
    """The window, optionally with the lids over it lifted: `cutaway` takes
    the CAVE lids (what a card about a cave needs), `roofcut` the house ROOFS
    too — the only way a card about the furniture in a room shows it, since
    render3 draws the roof the game draws."""
    d = doc
    kinds = ("cave",) + (("roof",) if roofcut else ())
    if cutaway or roofcut:
        d = dict(doc)
        d["decks"] = [dk for dk in doc["decks"] if not (dk["kind"] in kinds and any(
            x0 <= c["x"] <= x1 and y0 <= c["y"] <= y1 for c in dk["cells"]))]
    img = render3.render(d, x0, y0, x1, y1, log=lambda *a: None)
    return paint_density(img, doc, dens, x0, y0, x1, y1, vmax) if dens else img


IDENTICAL = []


def same_pixels(out, before, after, ch):
    """A CARD MUST SHOW WHAT IT CLAIMS. A change page renders world.json, so a
    push that only moved a SIDECAR (spawns, ambient, npcs) rendered the same
    pixels twice and showed him nothing at all (maintainer 2026-09-22: "The
    before and after images looks pixel perfect identical"). Collected here
    and raised at the end, so every offending card is named at once: give the
    card an `overlay` that draws what moved, or a window where it shows."""
    a = open(os.path.join(out, before), "rb").read()
    b = open(os.path.join(out, after), "rb").read()
    if a == b:
        IDENTICAL.append(ch.get("name", "?"))


def build(spec, out, only=None):
    if spec.get("schema") == "maps2/change-log@1":
        return build_log(spec, out, only)
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
        cut, rcut = bool(ch.get("cutaway")), bool(ch.get("roofcut"))
        over = ch.get("overlay") or spec.get("overlay")
        bc = ch.get("before", spec.get("before"))
        dn = spawn_ground(doc, json.load(open(os.path.join(wdir, "spawns.json"))), world) if over == "spawns" else None
        if over == "cavewalls":
            dn = wall_ground(doc, json.load(open(os.path.join(wdir, "places.json"))))
        after = f"img/{n:02d}-after.webp"
        _window(doc, x0, y0, x1, y1, cut, rcut, dn).convert("RGB").save(os.path.join(out, after), lossless=True, exact=True)
        before = None
        if bc:
            bdoc = world_at(bc, world)
            if bdoc["size"] == doc["size"]:
                bdn = spawn_ground(bdoc, sidecar_at(bc, world, "spawns.json"), world) if over == "spawns" else None
                if over == "cavewalls":
                    bdn = wall_ground(bdoc, sidecar_at(bc, world, "places.json"))
                before = f"img/{n:02d}-before.webp"
                _window(bdoc, x0, y0, x1, y1, cut, rcut, bdn).convert("RGB").save(os.path.join(out, before), lossless=True, exact=True)
                same_pixels(out, before, after, ch)
        lvl = doc["level"][int(cy)][int(cx)]
        px = dot["kx"] * (cx - cy) + dot["x0"]
        py = dot["ky"] * (cx + cy) - dot["kz"] * lvl + dot["y0"]
        cards.append({"n": n, "name": ch["name"], "what": ch.get("what", ""), "cell": [cx, cy], "level": lvl,
                      "after": after, "before": before, "before_commit": bc or "",
                      "px": round(100 * px / mm["size"]["w"], 3), "py": round(100 * py / mm["size"]["h"], 3),
                      "cutaway": cut or rcut, "commit": ch.get("commit", spec.get("commit", ""))})
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


def build_log(log, out, only=None):
    """ONE PAGE PER PUSH (maintainer 2026-09-13: "the artifact page you linked
    to for me to show the changes contains old stuff still. Can't tell what's
    yours. NEVER POST A LINK THAT CONTAIN PREVIOUS FIXES AGAIN!").

    `only` is the push to render - a commit prefix, or "latest" - and it is
    what a reply links. The LOG still holds every push and the numbering still
    runs straight through it, so #22 is #22 on whatever page it appears: the
    numbers are what he quotes back. Without `only` the whole log renders,
    which is for reading the history, never for a link in a reply."""
    world = log.get("world", "the_game")
    wdir = os.path.join(MAPS2, "worlds3", world)
    mm = json.load(open(os.path.join(wdir, "minimap.json")))
    dot = mm["dot"]
    os.makedirs(os.path.join(out, "img"), exist_ok=True)
    from PIL import Image
    Image.open(os.path.join(wdir, mm["image"])).save(os.path.join(out, "img", "minimap.webp"), lossless=True, exact=True)
    pick = None
    if only:
        pick = log["pushes"][-1] if only == "latest" else next(
            (p for p in log["pushes"]
             if any(c.startswith(only) or only.startswith(c)
                    for c in (x.strip() for x in p["commit"].replace("→", " ").split()))),
            None)
        assert pick, f"no push in the log for {only!r}"
    n, sections = 0, []
    for push in log["pushes"]:
        if pick is not None and push is not pick:
            n += len(push["changes"])       # the numbers never move
            continue
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
            cut, rcut = bool(ch.get("cutaway")), bool(ch.get("roofcut"))
            over = ch.get("overlay") or push.get("overlay")
            bc = ch.get("before", push.get("before"))
            dn = vmax = None
            if over == "spawns":
                dn = spawn_ground(doc, sidecar_at(head, world, "spawns.json"), world)
            elif over == "spawndensity":
                dn = spawn_field(doc, sidecar_at(head, world, "spawns.json"), world)
            elif over == "cavewalls":
                dn = wall_ground(doc, sidecar_at(head, world, "places.json"))
            after = f"img/{n:03d}-after.webp"
            before = None
            if bc:
                bdoc = world_at(bc, world)
                if bdoc["size"] == doc["size"]:
                    bdn = None
                    if over == "spawns":
                        bdn = spawn_ground(bdoc, sidecar_at(bc, world, "spawns.json"), world)
                    elif over == "spawndensity":
                        bdn = spawn_field(bdoc, sidecar_at(bc, world, "spawns.json"), world)
                        vmax = max((v for _l, v in bdn.values()), default=0.0)
                    elif over == "cavewalls":
                        bdn = wall_ground(bdoc, sidecar_at(bc, world, "places.json"))
                    before = f"img/{n:03d}-before.webp"
                    if not os.path.exists(os.path.join(out, before)):
                        _window(bdoc, x0, y0, x1, y1, cut, rcut, bdn, vmax).convert("RGB").save(os.path.join(out, before), lossless=True, exact=True)
            if not os.path.exists(os.path.join(out, after)):
                _window(doc, x0, y0, x1, y1, cut, rcut, dn, vmax).convert("RGB").save(os.path.join(out, after), lossless=True, exact=True)
            if before:
                same_pixels(out, before, after, ch)
            lvl = doc["level"][int(cy)][int(cx)]
            px = dot["kx"] * (cx - cy) + dot["x0"]
            py = dot["ky"] * (cx + cy) - dot["kz"] * lvl + dot["y0"]
            cards.append({"n": n, "name": ch["name"], "what": ch.get("what", ""), "cell": [cx, cy], "level": lvl,
                          "after": after, "before": before, "before_commit": bc or "",
                          "px": round(100 * px / mm["size"]["w"], 3), "py": round(100 * py / mm["size"]["h"], 3),
                          "cutaway": cut or rcut, "commit": ch.get("commit", push.get("commit", ""))})
        sections.append({"date": push.get("date", ""), "commit": push.get("commit", ""),
                         "title": push.get("title", ""), "cards": cards})
    sections.reverse()
    if pick is not None:
        log = dict(log, subtitle=(
            "The changes of ONE push, the one named above. Tap a title to mark "
            "a change, copy the marks, paste them back to maps2. Coordinates "
            "are the ones the game shows under the player."))
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
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    only = next((a.split("=", 1)[1] for a in sys.argv[1:]
                 if a.startswith("--push=")), None)
    spec = json.load(open(args[0]))
    cards = build(spec, args[1], only)
    print(f"{len(cards)} change(s) rendered into {args[1]}"
          + (f" (push {only} only)" if only else " (the WHOLE log - not a link for a reply)"))
    if IDENTICAL:
        raise SystemExit(
            "report3: these cards show the SAME PIXELS before and after, so they "
            "show him nothing — give each an `overlay` that draws what moved (a "
            "sidecar push does not touch world.json) or a window where the change "
            "is visible:\n  " + "\n  ".join(IDENTICAL))
