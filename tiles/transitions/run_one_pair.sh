#!/usr/bin/env bash
# Usage in Cloud Shell:
#   export RAW='<paste the whole cookie line from the bookmarklet>'
#   nohup bash run_in_cloudshell.sh > run.log 2>&1 &
#   tail -f run.log        # ctrl-C stops watching, NOT the run
# RAW may be the entire document.cookie dump or a bare eyJ... token.
# nohup matters: a phone switching apps drops the Cloud Shell session, and without
# it the run dies with it. Detached, it keeps going and you reattach with tail.

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
[ -z "$TOK" ] && { echo 'no token found in $RAW'; exit 1; }
echo "token ok (${#TOK} chars)"

run() {  # a b amp seed description
  for TRY in 1 2 3 4 5; do
    R=$(curl -s -w '\n%{http_code}' -X POST https://api.pixellab.ai/tiles/create \
      -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
      -d "{\"description\":\"$5\",\"tile_type\":\"isometric\",\"tile_feature\":\"tileset\",\"tile_size\":64,\"tile_view\":\"high top-down\",\"tile_view_angle\":28,\"tile_depth_ratio\":0.5,\"tile_flat_top_px\":2,\"outline_mode\":\"segmentation\",\"boundary_amplitude\":$3,\"boundary_seed\":$4,\"elevation\":0,\"step_slope\":0}")
    CODE=$(echo "$R" | tail -1)
    if [ "$CODE" = 401 ] || [ "$CODE" = 403 ]; then
      echo 'TOKEN EXPIRED - stopping'; exit 1
    fi
    # 429 is the API pacing us, not a failure: wait and retry the SAME job
    if [ "$CODE" = 429 ]; then
      echo "  rate limited, waiting $((TRY*15))s"; sleep $((TRY*15)); continue
    fi
    ID=$(echo "$R" | head -1 | grep -o '"tile_id":"[^"]*' | cut -d'"' -f4)
    echo "$1 $2 $3 $4 ${ID:-FAILED_$CODE}"
    sleep 4
    return
  done
  echo "$1 $2 $3 $4 FAILED_RATELIMIT"
}

echo 'generating 11 tilesets, est $0.87'
run grass light_soil 0.05 5 "lush green grass to dry light soil"
run grass light_soil 0.14 1 "lush green grass to dry light soil"
run grass light_soil 0.14 2 "lush green grass to dry light soil"
run grass light_soil 0.14 3 "lush green grass to dry light soil"
run grass light_soil 0.14 4 "lush green grass to dry light soil"
run grass light_soil 0.14 5 "lush green grass to dry light soil"
run grass light_soil 0.23 1 "lush green grass to dry light soil"
run grass light_soil 0.23 2 "lush green grass to dry light soil"
run grass light_soil 0.23 3 "lush green grass to dry light soil"
run grass light_soil 0.23 4 "lush green grass to dry light soil"
run grass light_soil 0.23 5 "lush green grass to dry light soil"
