import sys, os, json, pickle
sys.path.insert(0,'/home/user/pixel/tiles/pipeline')
os.chdir('/home/user/pixel')
SP="/tmp/claude-0/-home-user-pixel/96353597-bf3b-5524-a136-24d70a486edb/scratchpad"
d=pickle.load(open(f"{SP}/pair_tiles.pkl","rb"))
pairs={}
for (a,b,amp,seed),t in d.items(): pairs.setdefault((a,b),{})[(amp,seed)]=t
n_set=n_tile=0
for (a,b),sets in sorted(pairs.items()):
    if len(sets)!=15: continue
    for (amp,seed),tiles in sorted(sets.items()):
        out=f"tiles/transitions/{a}__to__{b}/a{amp:02d}_s{seed}"
        os.makedirs(out, exist_ok=True)
        for i,im in enumerate(tiles):
            # LOSSLESS WebP, the project image format. exact=True keeps the RGB under
            # fully transparent pixels; both flags are non-default in Pillow.
            im.convert("RGBA").save(f"{out}/tile_{i:02d}.webp",
                                    "WEBP", lossless=True, exact=True)
            n_tile+=1
        json.dump({
            "lower": b, "upper": a,
            "boundary_amplitude": amp/100.0, "boundary_seed": seed,
            "n_tiles": 16, "size": list(tiles[0].size),
            "note": ("Wang corner set: index = 8*NW + 4*NE + 2*SW + 1*SE, a set bit "
                     f"meaning {a}. INDEX 0 IS {b} - the endpoint's convention is that "
                     "index 0 holds the material named SECOND in the generation "
                     "description, index 15 the first."),
        }, open(f"{out}/meta.json","w"), indent=1)
        n_set+=1
print(f"wrote {n_set} sets, {n_tile} tiles across {len([1 for s in pairs.values() if len(s)==15])} pairs")
