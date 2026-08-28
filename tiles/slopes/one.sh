#!/usr/bin/env bash
# ONE slope set, the maintainer's exact web-UI settings, for an A/B against the set he
# made by hand in the browser. Purpose: prove the API payload reproduces the UI before
# spending $17.77 regenerating all 225.
#   export RAW='<the cookie line>'   (already set if you ran run_slopes.sh in this shell)
#   bash one.sh            # Thickness 0%  -> 64x30, flat top face only
#   bash one.sh 0.5        # the house depth -> a real wall, like every other tile
TOK=$(RAW="$RAW" python3 -c "
import json,os,re,urllib.parse
raw=os.environ.get('RAW','').strip()
t=raw if raw.startswith('eyJ') else None
if not t:
    m=re.search(r'supabase-auth-token=([^;]+)',raw)
    if m:
        try: t=json.loads(urllib.parse.unquote(m.group(1)))[0]
        except Exception: pass
if not t:
    m=re.search(r'(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)',raw)
    t=m.group(1) if m else ''
print(t)")
[ -z "$TOK" ] && { echo 'no token in $RAW'; exit 1; }
echo "token ok (${#TOK} chars)"

# Every value here is read off his screenshots: uneven boundary 14%, Reshuffle #5,
# terrain height 4px, edge steepness mid-slope, view angle 28, Thickness 0%, 2px classic
# flat top, no outline, isometric, 64px.
DEPTH=${1:-0.0}
echo "tile_depth_ratio = $DEPTH"
R=$(curl -s -X POST https://api.pixellab.ai/tiles/create \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"description":"clean grass to clean grass","tile_type":"isometric","tile_feature":"tileset","tile_size":64,"tile_view":"high top-down","tile_view_angle":28,"tile_depth_ratio":'"$DEPTH"',"tile_flat_top_px":2,"outline_mode":"segmentation","boundary_amplitude":0.14,"boundary_seed":5,"elevation":4,"step_slope":0.55}')
echo "$R" | head -c 400; echo
echo "$R" | grep -o '"tile_id":"[^"]*' | cut -d'"' -f4 | tee one_tile_id.txt
