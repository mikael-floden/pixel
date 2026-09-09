import sys, os, json, pickle
sys.path.insert(0,'/home/user/pixel/tiles/pipeline')
os.chdir('/home/user/pixel')
if not os.environ.get("PIXELLAB_API_KEY") and os.path.exists(".env"):
    for l in open(".env"):
        if "=" in l and not l.startswith("#"):
            k,v=l.strip().split("=",1); os.environ.setdefault(k,v.strip().strip('"\''))
from pixellab_client import PixelLabClient
import transition_import as TI
from transition_jobs import MATERIALS
SP="/tmp/claude-0/-home-user-pixel/96353597-bf3b-5524-a136-24d70a486edb/scratchpad"
COMBOS=[(0,3),(0,5),(3,5),(21,5),(30,1),(12,4),(18,4),(21,4),(23,4),
        (14,5),(15,2),(15,6),(18,6),(21,2),(24,6)]
DESC2PAIR={}
names=sorted(MATERIALS)
for i,a in enumerate(names):
    for b in names[i+1:]:
        DESC2PAIR[f"{MATERIALS[a]} to {MATERIALS[b]}"]=(a,b)
c=PixelLabClient()
rows=TI.listing(c, limit=600)
CUT="2026-08-21T09:30:00"
new=[r for r in rows if (r.get("created_at") or "")>CUT]
by={}
for r in new:
    d=(r.get("description") or "").strip()
    if d in DESC2PAIR: by.setdefault(DESC2PAIR[d],[]).append(r)
cache=f"{SP}/pair_tiles.pkl"
out=pickle.load(open(cache,"rb")) if os.path.exists(cache) else {}
done=0
for pair,rs in sorted(by.items()):
    rs.sort(key=lambda r: r["created_at"])
    if len(rs)<15:
        print(f"skip {pair} - only {len(rs)}/15", flush=True); continue
    for (amp,seed),r in zip(COMBOS,rs):
        key=(pair[0],pair[1],amp,seed)
        if key in out: continue
        try: imgs=c.fetch_tiles(r["id"])
        except Exception as e:
            print("fail",key,str(e)[:50],flush=True); continue
        if len(imgs)==16:
            out[key]=[im.convert("RGBA") for im in imgs]; done+=1
            if done%15==0:
                pickle.dump(out,open(cache,"wb")); print(f"  {len(out)} cached",flush=True)
    print(f"pair done: {pair[0]}__to__{pair[1]}  ({len(out)} total)", flush=True)
pickle.dump(out,open(cache,"wb"))
print("DONE", len(out), "sets across", len({(k[0],k[1]) for k in out}), "pairs", flush=True)
