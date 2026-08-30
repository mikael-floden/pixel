"""Render a motion-candidate review page from a candidate JSON file.

Input: a list of {id, family, grp, piece, state, sprite, oid, seen, what, prompt}.
Output: a self-contained HTML page the maintainer ticks IDs on (the bottom bar
builds the list and copies it), published as an artifact.

Groups in EXCLUDED_GROUPS never reach a candidate page. (Maintainer, 2026-08-29:
"We are NOT working with windows and trees right now." Trees are already fully
wind-animated; windows are a separate open question. Match the group name
exactly -- 'streetlights' contains the substring 'tree'.)
"""
import base64, html, io, json, sys
from PIL import Image

EXCLUDED_GROUPS = {"windows", "trees", "ancient_trees"}

FAMILIES = {
    "flame":   ("Flame", "#e2703a"),
    "hanging": ("Hanging", "#e8b04b"),
    "glow":    ("Glow", "#5cc8c4"),
    "water":   ("Falling water", "#6f9ee0"),
    "plant":   ("Foliage", "#7fb85c"),
    "cloth":   ("Cloth", "#b98fd0"),
    "smoke":   ("Smoke", "#9aa3b0"),
}
ORDER = ["flame", "hanging", "glow", "water", "smoke", "cloth", "plant"]


def excluded(rows):
    """Split rows into (kept, dropped-by-EXCLUDED_GROUPS)."""
    keep, drop = [], []
    for r in rows:
        (drop if r["grp"] in EXCLUDED_GROUPS else keep).append(r)
    return keep, drop


def thumb(path, cap=104):
    im = Image.open(path).convert("RGBA")
    if max(im.size) > cap:
        im.thumbnail((cap, cap), Image.NEAREST)
    b = io.BytesIO()
    im.save(b, format="WEBP", lossless=True, exact=True, method=6)
    return "data:image/webp;base64," + base64.b64encode(b.getvalue()).decode()


_HEAD = '''<title>__TITLE__</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{--ground:#15151b;--panel:#1d1d25;--plate:#22222a;--line:#31313d;--ink:#e8e5de;
 --dim:#9b96a8;--faint:#6d6879;--accent:#e0a33e;
 --disp:"Bricolage Grotesque",Georgia,serif;--sans:"IBM Plex Sans",system-ui,sans-serif;
 --mono:"IBM Plex Mono",ui-monospace,Menlo,monospace;}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--ink);font-family:var(--sans);line-height:1.55;
 padding:clamp(20px,4vw,52px) clamp(14px,4vw,40px) 138px;max-width:1240px;margin:0 auto}
h1,h2{font-family:var(--disp);text-wrap:balance;margin:0}
h1{font-size:clamp(30px,5vw,46px);font-weight:700;letter-spacing:-.02em;line-height:1.08}
.lede{color:var(--dim);max-width:64ch;margin:14px 0 0;font-size:15.5px}
.lede b{color:var(--ink);font-weight:600}
.how{margin:24px 0 0;padding:14px 17px;background:var(--panel);border:1px solid var(--line);
 border-left:3px solid var(--accent);border-radius:3px;font-size:14px;color:var(--dim);max-width:64ch}
.how .h{color:var(--accent);font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;
 text-transform:uppercase;display:block;margin-bottom:6px}
.how em{color:var(--ink);font-style:normal;font-weight:600}
.fam{margin-top:48px}
.famhead{display:flex;align-items:baseline;gap:12px;border-bottom:1px solid var(--line);padding-bottom:9px;flex-wrap:wrap}
.famhead h2{font-size:22px;font-weight:700;color:var(--fam);letter-spacing:-.01em}
.count{font-family:var(--mono);font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums}
.selall{margin-left:auto;font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;
 text-transform:uppercase;color:var(--faint);background:none;border:1px solid var(--line);
 border-radius:2px;padding:3px 10px;cursor:pointer}
.selall:hover,.selall:focus-visible{color:var(--fam);border-color:var(--fam)}
.blurb{color:var(--dim);font-size:14px;max-width:72ch;margin:12px 0 20px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(258px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:4px;
 display:flex;flex-direction:column;overflow:hidden;transition:border-color .12s,box-shadow .12s}
.card input{position:absolute;opacity:0;pointer-events:none}
.face{display:flex;flex-direction:column;cursor:pointer;flex:1}
.plate{background:var(--plate);border-bottom:1px solid var(--line);height:142px;
 display:flex;align-items:center;justify-content:center;padding:11px}
.plate img{image-rendering:pixelated;max-height:120px;width:auto}
.body{padding:13px 14px 12px;display:flex;flex-direction:column;gap:4px;flex:1}
.idline{display:flex;align-items:center;justify-content:space-between}
.chip{font-family:var(--mono);font-weight:500;font-size:13px;color:var(--ground);
 background:var(--fam);padding:1px 9px;border-radius:2px;letter-spacing:.04em}
.tick{width:17px;height:17px;border:1.5px solid var(--line);border-radius:3px;flex:none;position:relative}
.card:has(:checked){border-color:var(--fam);box-shadow:0 0 0 1px var(--fam)}
.card:has(:checked) .tick{background:var(--fam);border-color:var(--fam)}
.card:has(:checked) .tick::after{content:"";position:absolute;left:5px;top:1px;width:5px;height:10px;
 border:solid var(--ground);border-width:0 2px 2px 0;transform:rotate(45deg)}
.card:has(:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
.nm{font-family:var(--disp);font-size:15.5px;font-weight:500;margin-top:3px}
.path{font-family:var(--mono);font-size:10.5px;color:var(--faint);letter-spacing:.03em}
.lbl{display:block;font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;
 text-transform:uppercase;color:var(--faint);margin:6px 0 1px;font-weight:400}
.seen,.what{font-size:13.5px;color:var(--dim)}
.what .w{color:var(--ink);font-weight:600}
.extra{padding:0 14px 13px;display:flex;flex-direction:column;gap:8px}
.pl{font-family:var(--mono);font-size:10.5px;color:var(--faint);text-decoration:none;letter-spacing:.05em}
.pl:hover,.pl:focus-visible{color:var(--fam)}
summary{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;
 color:var(--faint);cursor:pointer}
summary:hover,summary:focus-visible{color:var(--fam)}
pre{font-family:var(--mono);font-size:11.5px;line-height:1.65;color:var(--dim);white-space:pre-wrap;
 margin:8px 0 0;padding:10px 11px;background:var(--plate);border-radius:3px;
 border-left:2px solid var(--fam);overflow-x:auto}
#bar{position:fixed;left:0;right:0;bottom:0;background:rgba(21,21,27,.97);
 border-top:1px solid var(--line);padding:12px clamp(14px,4vw,40px);z-index:9;backdrop-filter:blur(8px)}
#bar .in{max-width:1240px;margin:0 auto;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
#n{font-family:var(--mono);font-size:12px;color:var(--accent);white-space:nowrap;
 font-variant-numeric:tabular-nums;letter-spacing:.06em}
#ids{flex:1;min-width:190px;font-family:var(--mono);font-size:12.5px;color:var(--ink);
 background:var(--plate);border:1px solid var(--line);border-radius:3px;padding:8px 11px;
 max-height:74px;overflow-y:auto;word-break:break-word;line-height:1.7}
#ids:empty::before{content:"Tick the cards you want \\2014 the list builds here.";color:var(--faint)}
#bar button{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;
 padding:8px 15px;border-radius:3px;cursor:pointer;border:1px solid var(--line);
 background:var(--plate);color:var(--dim);white-space:nowrap}
#copy{background:var(--accent);border-color:var(--accent);color:var(--ground);font-weight:500}
#bar button:hover,#bar button:focus-visible{filter:brightness(1.12)}
a:focus-visible,summary:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
'''

_TAIL = '''<div id="bar"><div class="in">
<span id="n">0 selected</span><div id="ids"></div>
<button id="copy">Copy</button><button id="clear">Clear</button></div></div>
<script>
var boxes=[].slice.call(document.querySelectorAll('.card input'));
var idsEl=document.getElementById('ids'),nEl=document.getElementById('n'),KEY='__KEY__';
function render(){
  var s=boxes.filter(function(b){return b.checked;}).map(function(b){return b.value;});
  idsEl.textContent=s.join(', ');
  nEl.textContent=s.length+' selected';
  try{localStorage.setItem(KEY,JSON.stringify(s));}catch(e){}
}
try{
  var saved=JSON.parse(localStorage.getItem(KEY)||'[]');
  if(saved&&saved.length){boxes.forEach(function(b){b.checked=saved.indexOf(b.value)>=0;});}
}catch(e){}
boxes.forEach(function(b){b.addEventListener('change',render);});
[].forEach.call(document.querySelectorAll('.selall'),function(btn){
  btn.addEventListener('click',function(){
    var want=btn.dataset.ids.split(',');
    var all=want.every(function(id){
      return boxes.some(function(b){return b.value===id&&b.checked;});});
    boxes.forEach(function(b){if(want.indexOf(b.value)>=0)b.checked=!all;});
    btn.textContent=all?'Select all':'Clear these';
    render();
  });
});
document.getElementById('clear').addEventListener('click',function(){
  boxes.forEach(function(b){b.checked=false;});
  [].forEach.call(document.querySelectorAll('.selall'),function(b){b.textContent='Select all';});
  render();
});
document.getElementById('copy').addEventListener('click',function(){
  var t=idsEl.textContent,btn=this;
  if(!t){btn.textContent='Nothing picked';setTimeout(function(){btn.textContent='Copy';},1400);return;}
  function done(ok){btn.textContent=ok?'Copied':'Select & copy';
    setTimeout(function(){btn.textContent='Copy';},1400);}
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(function(){done(true);},function(){done(false);});
  }else{
    try{var r=document.createRange();r.selectNodeContents(idsEl);
      var sel=window.getSelection();sel.removeAllRanges();sel.addRange(r);
      done(document.execCommand('copy'));}catch(e){done(false);}
  }
});
render();
</script>'''


def render(rows, title, lede, blurbs, key, out_path):
    """rows: candidate dicts. blurbs: {family: html blurb}. Writes out_path."""
    rows, dropped = excluded(rows)
    esc = html.escape
    parts = []
    for fam in ORDER:
        rs = [r for r in rows if r["family"] == fam]
        if not rs:
            continue
        name, col = FAMILIES[fam]
        ids = ",".join(r["id"] for r in rs)
        parts.append(
            f'<section class="fam" style="--fam:{col}">'
            f'<header class="famhead"><h2>{name}</h2><span class="count">{len(rs)}</span>'
            f'<button class="selall" data-ids="{ids}">Select all</button></header>'
            f'<p class="blurb">{blurbs.get(fam,"")}</p><div class="grid">')
        for r in rs:
            parts.append(
                f'<article class="card"><input type="checkbox" id="c{r["id"]}" value="{r["id"]}">'
                f'<label class="face" for="c{r["id"]}">'
                f'<span class="plate"><img src="{thumb(r["sprite"])}" alt="{esc(r["piece"])}" loading="lazy"></span>'
                f'<span class="body"><span class="idline"><span class="chip">{r["id"]}</span>'
                f'<span class="tick" aria-hidden="true"></span></span>'
                f'<span class="nm">{esc(r["piece"])}</span>'
                f'<span class="path">{esc(r["grp"])} &middot; {esc(r["state"])}</span>'
                f'<span class="seen"><b class="lbl">In the sprite</b>{esc(r["seen"])}</span>'
                f'<span class="what"><b class="lbl">Should move</b><b class="w">{esc(r["what"])}</b></span>'
                f'</span></label><div class="extra">'
                f'<a class="pl" href="https://www.pixellab.ai/create-object/{r["oid"]}" '
                f'target="_blank" rel="noopener">Open in PixelLab &#8599;</a>'
                f'<details><summary>Prompt</summary><pre>{esc(r["prompt"])}</pre></details>'
                f'</div></article>')
        parts.append("</div></section>")
    doc = (_HEAD.replace("__TITLE__", title) + f"<h1>{title}</h1>\n<p class='lede'>{lede}</p>\n"
           + '<div class="how"><span class="h">How to pick</span>Tick any card &mdash; the whole '
             'card is the target, so you can tap anywhere on it. The list builds in the bar pinned '
             'to the bottom of the screen and follows you down the page; <em>Copy</em> puts the IDs '
             'on your clipboard ready to paste back to me. Your ticks survive a reload.</div>\n'
           + "".join(parts) + _TAIL.replace("__KEY__", key))
    with open(out_path, "w") as f:
        f.write(doc)
    return len(rows), dropped


if __name__ == "__main__":
    rows = json.load(open(sys.argv[1]))
    kept, dropped = excluded(rows)
    print(f"{len(kept)} kept, {len(dropped)} excluded by group: "
          + ", ".join(f"{d['id']} ({d['grp']})" for d in dropped))


def render_results(cards_html, title, lede, key, out_path, intro="", head_extra="",
                   bar_prompt="removed"):
    """Render a RESULTS page -- animations that already exist, for accept/reject.

    EVERY page that shows him a list of ids carries the tick-and-copy bar. The
    redo pages shipped without it once and he had to transcribe ids by hand
    ("I really like the feature where I can select things"); _TAIL is what
    provides it, so results pages go through here rather than hand-assembling.
    """
    head = (_HEAD.replace("__TITLE__", title)
                 .replace("</style>", head_extra + "</style>"))
    how = ("<div class='how'><span class='h'>What I need from you</span>Tick anything you "
           f"want <em>{bar_prompt}</em> and copy the list &mdash; the bar at the bottom "
           "builds it. Silence means keep.</div>")
    doc = (head + f"<h1>{title}</h1>\n<p class='lede'>{lede}</p>\n"
           + intro + how + cards_html + _TAIL.replace("__KEY__", key))
    with open(out_path, "w") as f:
        f.write(doc)
    return len(doc)


def result_card(r, note="", tag="", checkbox=True):
    """One playing-animation card with a tick box, for render_results."""
    import html as _h
    e = _h.escape
    nb = f'<p class="note">{note}</p>' if note else ""
    if not checkbox:
        return (f'<article class="card"><span class="plate">'
                f'<img src="{r["anim"]}" alt="{e(r["piece"])}"></span><div class="body">'
                f'<div class="idline"><span class="chip">{r["id"]}</span>{tag}</div>'
                f'<h3>{e(r["piece"])}</h3></div>{nb}</article>')
    return (f'<article class="card"><input type="checkbox" id="c{r["id"]}" value="{r["id"]}">'
            f'<label class="face" for="c{r["id"]}"><span class="plate">'
            f'<img src="{r["anim"]}" alt="{e(r["piece"])}"></span><span class="body">'
            f'<span class="idline"><span class="chip">{r["id"]}</span>{tag}'
            f'<span class="tick" aria-hidden="true"></span></span>'
            f'<span class="nm">{e(r["piece"])}</span>'
            f'<span class="path">{e(r["grp"])} &middot; {e(r["state"])}</span>'
            f'<span class="met"><b>{r["motion"]}%</b> moving <i>/</i> <b>{r["drift"]}%</b> drift'
            f'</span></span></label>{nb}</article>')
