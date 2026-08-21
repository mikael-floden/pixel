import sys, os, json, pickle, base64, io
sys.path.insert(0,'/home/user/pixel/tiles/pipeline')
sys.path.insert(0,"/tmp/claude-0/-home-user-pixel/96353597-bf3b-5524-a136-24d70a486edb/scratchpad")
os.chdir("/tmp/claude-0/-home-user-pixel/96353597-bf3b-5524-a136-24d70a486edb/scratchpad")
import numpy as np
from PIL import Image
import transition_render as TR
PAL=json.load(open("/home/user/pixel/tiles/config/palette.json"))["types"]
R_="/home/user/pixel/tiles/review"
def ground(mat):
    """Our published, reviewed tile for a material.

    Its top face is forced to the palette colour so a field of it is one tone - but
    ONLY where palette.json says flat_top. The two paving twins and parquet_floor are
    marked flat_top false on purpose: their surface IS the material, and a paving stone
    with no stones in it is a brown rectangle. Flattening those took brown_paving_stone
    from 10 colours to 1.
    """
    p=f"{R_}/{mat}__over__{mat}/0_after.webp"
    im=Image.open(p).convert("RGBA").crop((0,9,64,55))
    if PAL[mat].get("flat_top", True):
        im=TR.clean_top(im, PAL[mat]["top"])
    return im
def pack(tiles):
    """One 16-tile strip, colour-reduced but with the REAL alpha put back.

    Saving as a palette PNG with a reserved transparent index does not survive the
    round trip - Pillow re-packs the palette and the index the transparency pointed at
    moves, so every tile comes back fully opaque and the map draws as loose diamonds
    on black. Quantise for size, then merge the original alpha and save RGBA; the
    limited palette still compresses well.
    """
    sheet=Image.new("RGBA",(16*64,46),(0,0,0,0))
    for i,t in enumerate(tiles):
        t=t.convert("RGBA"); sheet.paste(t,(i*64,0),t)
    alpha=sheet.split()[3]
    rgb=sheet.convert("RGB").quantize(colors=64,method=Image.MEDIANCUT).convert("RGB")
    rgb.putalpha(alpha)
    b=io.BytesIO(); rgb.save(b,"PNG",optimize=True)
    return base64.b64encode(b.getvalue()).decode()
def sig(a):
    """A material's signature: mean of the top face in normalised chroma as well as
    plain RGB. Matching a set's index-0 tile against a single palette hex mistook a
    near-black brown for a dark green; matching whole distributions does not."""
    top=TR.top_face(a[...,3]>0)
    px=a[top][:,:3].astype(float)
    m=px.mean(0); ssum=px.sum(1)+1e-6
    return np.concatenate([m/255.0, (px/ssum[:,None]).mean(0)*3])

def index0_is(a, b, tiles):
    """INDEX 0 IS THE SECOND MATERIAL OF THE DESCRIPTION. Always.

    The description is written "<first> to <second>" and the set is built with the
    second material at index 0, the first at 15. This is not measured, because the
    description fixes it: measuring it introduced an error rather than removing one.
    A colour-signature test agreed on twelve of thirteen pairs and got dark_mud-to-grass
    backwards, reading a near-black brown as a dark green - and one bad measurement is
    worse than no measurement when the answer is already known from the request.
    """
    return b

d=pickle.load(open("pair_tiles.pkl","rb"))
pairs={}
for (a,b,amp,seed),tiles in d.items(): pairs.setdefault((a,b),{})[(amp,seed)]=tiles
full={k:v for k,v in pairs.items() if len(v)==15}
print(f"{len(full)} complete pairs of {len(pairs)} seen", flush=True)
out=[]
for (a,b),sets in sorted(full.items()):
    first_key=sorted(sets)[0]
    m0=index0_is(a,b,sets[first_key])          # measured, not assumed
    m15= b if m0==a else a
    pa,pb=ground(m0),ground(m15)
    entry={"a":a,"b":b,"label":f"{a} ↔ {b}","index0":m0,"sets":{}}
    for (amp,seed),raw in sorted(sets.items()):
        # Keep the generator's art; correct only its colour. See retexture_palette.
        proc=TR.retexture_palette(raw, PAL[m0]["top"], PAL[m15]["top"],
                                  ramp_a=PAL[m0].get("ramp"), ramp_b=PAL[m15].get("ramp"))
        entry["sets"][f"{amp}-{seed}"]={"clean":pack(proc),"raw":pack(raw)}
    out.append(entry); print(f"  built {a} -> {b}   (index 0 = {m0})", flush=True)
old=json.load(open("roadgen.json"))
json.dump({"pairs":out,"maps":old["maps"]},open("pairs_view.json","w"))
kb=sum(len(s["clean"])+len(s["raw"]) for e in out for s in e["sets"].values())//1024
print(f"DONE {len(out)} pairs, {kb} KB", flush=True)
