#!/usr/bin/env bash
# Usage in Cloud Shell:
#   export RAW='<paste the whole cookie line from the bookmarklet>'
#   nohup bash run_slopes.sh > run.log 2>&1 &
#   tail -f run.log        # ctrl-C stops watching, NOT the run
# RAW may be the entire document.cookie dump or a bare eyJ... token.
# nohup matters: a phone switching apps drops the Cloud Shell session, and without
# it the run dies with it. Detached, it keeps going and you reattach with tail.
#
# RE-RUNNING IS SAFE. Every finished job is appended to run_done.txt and skipped on
# the next run, so a token that lapses mid-way, a dropped session, or a script fired
# twice costs nothing. (Not a hypothetical: an earlier run produced no output under
# nohup, was re-triggered several times, and bought ~$8 of duplicates and 48 sets of
# one pair.) slope_v2_done.txt is also the machine-readable result - `a b amp seed id` per
# line - so nothing has to be scraped out of run.log.
#   To start over deliberately: rm slope_v2_done.txt

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

DONE=${DONE:-slope_v2_done.txt}
touch "$DONE"
echo "resuming: $(wc -l < "$DONE") job(s) already done"
echo "resuming: $(wc -l < "$DONE") job(s) already done"

run() {  # a b amp seed elevation step_slope description
  KEY="$1 $2 $3 $4 $5 $6"
  # anchored, so seed 1 is not matched by a line for seed 10
  if grep -q "^${KEY} " "$DONE"; then return; fi
  for TRY in 1 2 3 4 5; do
    R=$(curl -s -w '\n%{http_code}' -X POST https://api.pixellab.ai/tiles/create \
      -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
      -d "{\"description\":\"$7\",\"tile_type\":\"isometric\",\"tile_feature\":\"tileset\",\"tile_size\":64,\"tile_view\":\"high top-down\",\"tile_view_angle\":28,\"tile_depth_ratio\":0.5,\"tile_flat_top_px\":2,\"outline_mode\":\"segmentation\",\"boundary_amplitude\":$3,\"boundary_seed\":$4,\"elevation\":$5,\"step_slope\":$6}")
    CODE=$(echo "$R" | tail -1)
    if [ "$CODE" = 401 ] || [ "$CODE" = 403 ]; then
      echo 'TOKEN EXPIRED - stopping'; exit 1
    fi
    # 429 is the API pacing us, not a failure: wait and retry the SAME job
    if [ "$CODE" = 429 ]; then
      echo "  rate limited, waiting $((TRY*15))s"; sleep $((TRY*15)); continue
    fi
    ID=$(echo "$R" | head -1 | grep -o '"tile_id":"[^"]*' | cut -d'"' -f4)
    if [ -n "$ID" ]; then
      echo "$KEY $ID" | tee -a "$DONE"
    else
      echo "$KEY FAILED_$CODE"        # not recorded, so a re-run retries it
      # THE FIRST JOB IS A PROBE. A plateau run sends parameter VALUES the flat matrix
      # never did (elevation > 0, a non-zero step_slope), and a rejected value fails
      # identically for every job in the list - a wasted trip for someone driving this
      # from a phone. With nothing yet recorded, stop and print what the API actually
      # said, which is the one thing needed to fix it.
      if [ "$(wc -l < "$DONE")" -eq 0 ]; then
        echo "--- FIRST JOB FAILED, stopping before spending more. API said:"
        echo "$R" | head -1
        exit 1
      fi
    fi
    sleep 4
    return
  done
  echo "$KEY FAILED_RATELIMIT"        # not recorded, so a re-run retries it
}

echo 'generating 225 tilesets, est $17.77'
run black_rock black_rock 0.14 1 4 0.55 "clean black rock to clean black rock"
run black_rock black_rock 0.14 2 4 0.55 "clean black rock to clean black rock"
run black_rock black_rock 0.14 3 4 0.55 "clean black rock to clean black rock"
run black_rock black_rock 0.14 4 4 0.55 "clean black rock to clean black rock"
run black_rock black_rock 0.14 5 4 0.55 "clean black rock to clean black rock"
run black_rock black_rock 0.14 6 4 0.55 "clean black rock to clean black rock"
run black_rock black_rock 0.14 7 4 0.55 "clean black rock to clean black rock"
run black_rock black_rock 0.14 8 4 0.55 "clean black rock to clean black rock"
run black_rock black_rock 0.14 9 4 0.55 "clean black rock to clean black rock"
run black_rock black_rock 0.14 10 4 0.55 "clean black rock to clean black rock"
run black_rock black_rock 0.14 11 4 0.55 "clean black rock to clean black rock"
run black_rock black_rock 0.14 12 4 0.55 "clean black rock to clean black rock"
run black_rock black_rock 0.14 13 4 0.55 "clean black rock to clean black rock"
run black_rock black_rock 0.14 14 4 0.55 "clean black rock to clean black rock"
run black_rock black_rock 0.14 15 4 0.55 "clean black rock to clean black rock"
run brown_paving_stone brown_paving_stone 0.14 1 4 0.55 "clean brown paving stone to clean brown paving stone"
run brown_paving_stone brown_paving_stone 0.14 2 4 0.55 "clean brown paving stone to clean brown paving stone"
run brown_paving_stone brown_paving_stone 0.14 3 4 0.55 "clean brown paving stone to clean brown paving stone"
run brown_paving_stone brown_paving_stone 0.14 4 4 0.55 "clean brown paving stone to clean brown paving stone"
run brown_paving_stone brown_paving_stone 0.14 5 4 0.55 "clean brown paving stone to clean brown paving stone"
run brown_paving_stone brown_paving_stone 0.14 6 4 0.55 "clean brown paving stone to clean brown paving stone"
run brown_paving_stone brown_paving_stone 0.14 7 4 0.55 "clean brown paving stone to clean brown paving stone"
run brown_paving_stone brown_paving_stone 0.14 8 4 0.55 "clean brown paving stone to clean brown paving stone"
run brown_paving_stone brown_paving_stone 0.14 9 4 0.55 "clean brown paving stone to clean brown paving stone"
run brown_paving_stone brown_paving_stone 0.14 10 4 0.55 "clean brown paving stone to clean brown paving stone"
run brown_paving_stone brown_paving_stone 0.14 11 4 0.55 "clean brown paving stone to clean brown paving stone"
run brown_paving_stone brown_paving_stone 0.14 12 4 0.55 "clean brown paving stone to clean brown paving stone"
run brown_paving_stone brown_paving_stone 0.14 13 4 0.55 "clean brown paving stone to clean brown paving stone"
run brown_paving_stone brown_paving_stone 0.14 14 4 0.55 "clean brown paving stone to clean brown paving stone"
run brown_paving_stone brown_paving_stone 0.14 15 4 0.55 "clean brown paving stone to clean brown paving stone"
run dark_mud dark_mud 0.14 1 4 0.55 "clean dark mud to clean dark mud"
run dark_mud dark_mud 0.14 2 4 0.55 "clean dark mud to clean dark mud"
run dark_mud dark_mud 0.14 3 4 0.55 "clean dark mud to clean dark mud"
run dark_mud dark_mud 0.14 4 4 0.55 "clean dark mud to clean dark mud"
run dark_mud dark_mud 0.14 5 4 0.55 "clean dark mud to clean dark mud"
run dark_mud dark_mud 0.14 6 4 0.55 "clean dark mud to clean dark mud"
run dark_mud dark_mud 0.14 7 4 0.55 "clean dark mud to clean dark mud"
run dark_mud dark_mud 0.14 8 4 0.55 "clean dark mud to clean dark mud"
run dark_mud dark_mud 0.14 9 4 0.55 "clean dark mud to clean dark mud"
run dark_mud dark_mud 0.14 10 4 0.55 "clean dark mud to clean dark mud"
run dark_mud dark_mud 0.14 11 4 0.55 "clean dark mud to clean dark mud"
run dark_mud dark_mud 0.14 12 4 0.55 "clean dark mud to clean dark mud"
run dark_mud dark_mud 0.14 13 4 0.55 "clean dark mud to clean dark mud"
run dark_mud dark_mud 0.14 14 4 0.55 "clean dark mud to clean dark mud"
run dark_mud dark_mud 0.14 15 4 0.55 "clean dark mud to clean dark mud"
run deep_water deep_water 0.14 1 4 0.55 "clean deep water to clean deep water"
run deep_water deep_water 0.14 2 4 0.55 "clean deep water to clean deep water"
run deep_water deep_water 0.14 3 4 0.55 "clean deep water to clean deep water"
run deep_water deep_water 0.14 4 4 0.55 "clean deep water to clean deep water"
run deep_water deep_water 0.14 5 4 0.55 "clean deep water to clean deep water"
run deep_water deep_water 0.14 6 4 0.55 "clean deep water to clean deep water"
run deep_water deep_water 0.14 7 4 0.55 "clean deep water to clean deep water"
run deep_water deep_water 0.14 8 4 0.55 "clean deep water to clean deep water"
run deep_water deep_water 0.14 9 4 0.55 "clean deep water to clean deep water"
run deep_water deep_water 0.14 10 4 0.55 "clean deep water to clean deep water"
run deep_water deep_water 0.14 11 4 0.55 "clean deep water to clean deep water"
run deep_water deep_water 0.14 12 4 0.55 "clean deep water to clean deep water"
run deep_water deep_water 0.14 13 4 0.55 "clean deep water to clean deep water"
run deep_water deep_water 0.14 14 4 0.55 "clean deep water to clean deep water"
run deep_water deep_water 0.14 15 4 0.55 "clean deep water to clean deep water"
run grass grass 0.14 1 4 0.55 "clean grass to clean grass"
run grass grass 0.14 2 4 0.55 "clean grass to clean grass"
run grass grass 0.14 3 4 0.55 "clean grass to clean grass"
run grass grass 0.14 4 4 0.55 "clean grass to clean grass"
run grass grass 0.14 5 4 0.55 "clean grass to clean grass"
run grass grass 0.14 6 4 0.55 "clean grass to clean grass"
run grass grass 0.14 7 4 0.55 "clean grass to clean grass"
run grass grass 0.14 8 4 0.55 "clean grass to clean grass"
run grass grass 0.14 9 4 0.55 "clean grass to clean grass"
run grass grass 0.14 10 4 0.55 "clean grass to clean grass"
run grass grass 0.14 11 4 0.55 "clean grass to clean grass"
run grass grass 0.14 12 4 0.55 "clean grass to clean grass"
run grass grass 0.14 13 4 0.55 "clean grass to clean grass"
run grass grass 0.14 14 4 0.55 "clean grass to clean grass"
run grass grass 0.14 15 4 0.55 "clean grass to clean grass"
run grey_paving_stone grey_paving_stone 0.14 1 4 0.55 "clean grey paving stone to clean grey paving stone"
run grey_paving_stone grey_paving_stone 0.14 2 4 0.55 "clean grey paving stone to clean grey paving stone"
run grey_paving_stone grey_paving_stone 0.14 3 4 0.55 "clean grey paving stone to clean grey paving stone"
run grey_paving_stone grey_paving_stone 0.14 4 4 0.55 "clean grey paving stone to clean grey paving stone"
run grey_paving_stone grey_paving_stone 0.14 5 4 0.55 "clean grey paving stone to clean grey paving stone"
run grey_paving_stone grey_paving_stone 0.14 6 4 0.55 "clean grey paving stone to clean grey paving stone"
run grey_paving_stone grey_paving_stone 0.14 7 4 0.55 "clean grey paving stone to clean grey paving stone"
run grey_paving_stone grey_paving_stone 0.14 8 4 0.55 "clean grey paving stone to clean grey paving stone"
run grey_paving_stone grey_paving_stone 0.14 9 4 0.55 "clean grey paving stone to clean grey paving stone"
run grey_paving_stone grey_paving_stone 0.14 10 4 0.55 "clean grey paving stone to clean grey paving stone"
run grey_paving_stone grey_paving_stone 0.14 11 4 0.55 "clean grey paving stone to clean grey paving stone"
run grey_paving_stone grey_paving_stone 0.14 12 4 0.55 "clean grey paving stone to clean grey paving stone"
run grey_paving_stone grey_paving_stone 0.14 13 4 0.55 "clean grey paving stone to clean grey paving stone"
run grey_paving_stone grey_paving_stone 0.14 14 4 0.55 "clean grey paving stone to clean grey paving stone"
run grey_paving_stone grey_paving_stone 0.14 15 4 0.55 "clean grey paving stone to clean grey paving stone"
run grey_stone grey_stone 0.14 1 4 0.55 "clean grey stone to clean grey stone"
run grey_stone grey_stone 0.14 2 4 0.55 "clean grey stone to clean grey stone"
run grey_stone grey_stone 0.14 3 4 0.55 "clean grey stone to clean grey stone"
run grey_stone grey_stone 0.14 4 4 0.55 "clean grey stone to clean grey stone"
run grey_stone grey_stone 0.14 5 4 0.55 "clean grey stone to clean grey stone"
run grey_stone grey_stone 0.14 6 4 0.55 "clean grey stone to clean grey stone"
run grey_stone grey_stone 0.14 7 4 0.55 "clean grey stone to clean grey stone"
run grey_stone grey_stone 0.14 8 4 0.55 "clean grey stone to clean grey stone"
run grey_stone grey_stone 0.14 9 4 0.55 "clean grey stone to clean grey stone"
run grey_stone grey_stone 0.14 10 4 0.55 "clean grey stone to clean grey stone"
run grey_stone grey_stone 0.14 11 4 0.55 "clean grey stone to clean grey stone"
run grey_stone grey_stone 0.14 12 4 0.55 "clean grey stone to clean grey stone"
run grey_stone grey_stone 0.14 13 4 0.55 "clean grey stone to clean grey stone"
run grey_stone grey_stone 0.14 14 4 0.55 "clean grey stone to clean grey stone"
run grey_stone grey_stone 0.14 15 4 0.55 "clean grey stone to clean grey stone"
run ice ice 0.14 1 4 0.55 "clean ice to clean ice"
run ice ice 0.14 2 4 0.55 "clean ice to clean ice"
run ice ice 0.14 3 4 0.55 "clean ice to clean ice"
run ice ice 0.14 4 4 0.55 "clean ice to clean ice"
run ice ice 0.14 5 4 0.55 "clean ice to clean ice"
run ice ice 0.14 6 4 0.55 "clean ice to clean ice"
run ice ice 0.14 7 4 0.55 "clean ice to clean ice"
run ice ice 0.14 8 4 0.55 "clean ice to clean ice"
run ice ice 0.14 9 4 0.55 "clean ice to clean ice"
run ice ice 0.14 10 4 0.55 "clean ice to clean ice"
run ice ice 0.14 11 4 0.55 "clean ice to clean ice"
run ice ice 0.14 12 4 0.55 "clean ice to clean ice"
run ice ice 0.14 13 4 0.55 "clean ice to clean ice"
run ice ice 0.14 14 4 0.55 "clean ice to clean ice"
run ice ice 0.14 15 4 0.55 "clean ice to clean ice"
run lava lava 0.14 1 4 0.55 "clean lava to clean lava"
run lava lava 0.14 2 4 0.55 "clean lava to clean lava"
run lava lava 0.14 3 4 0.55 "clean lava to clean lava"
run lava lava 0.14 4 4 0.55 "clean lava to clean lava"
run lava lava 0.14 5 4 0.55 "clean lava to clean lava"
run lava lava 0.14 6 4 0.55 "clean lava to clean lava"
run lava lava 0.14 7 4 0.55 "clean lava to clean lava"
run lava lava 0.14 8 4 0.55 "clean lava to clean lava"
run lava lava 0.14 9 4 0.55 "clean lava to clean lava"
run lava lava 0.14 10 4 0.55 "clean lava to clean lava"
run lava lava 0.14 11 4 0.55 "clean lava to clean lava"
run lava lava 0.14 12 4 0.55 "clean lava to clean lava"
run lava lava 0.14 13 4 0.55 "clean lava to clean lava"
run lava lava 0.14 14 4 0.55 "clean lava to clean lava"
run lava lava 0.14 15 4 0.55 "clean lava to clean lava"
run light_beach light_beach 0.14 1 4 0.55 "clean light beach to clean light beach"
run light_beach light_beach 0.14 2 4 0.55 "clean light beach to clean light beach"
run light_beach light_beach 0.14 3 4 0.55 "clean light beach to clean light beach"
run light_beach light_beach 0.14 4 4 0.55 "clean light beach to clean light beach"
run light_beach light_beach 0.14 5 4 0.55 "clean light beach to clean light beach"
run light_beach light_beach 0.14 6 4 0.55 "clean light beach to clean light beach"
run light_beach light_beach 0.14 7 4 0.55 "clean light beach to clean light beach"
run light_beach light_beach 0.14 8 4 0.55 "clean light beach to clean light beach"
run light_beach light_beach 0.14 9 4 0.55 "clean light beach to clean light beach"
run light_beach light_beach 0.14 10 4 0.55 "clean light beach to clean light beach"
run light_beach light_beach 0.14 11 4 0.55 "clean light beach to clean light beach"
run light_beach light_beach 0.14 12 4 0.55 "clean light beach to clean light beach"
run light_beach light_beach 0.14 13 4 0.55 "clean light beach to clean light beach"
run light_beach light_beach 0.14 14 4 0.55 "clean light beach to clean light beach"
run light_beach light_beach 0.14 15 4 0.55 "clean light beach to clean light beach"
run light_soil light_soil 0.14 1 4 0.55 "clean light soil to clean light soil"
run light_soil light_soil 0.14 2 4 0.55 "clean light soil to clean light soil"
run light_soil light_soil 0.14 3 4 0.55 "clean light soil to clean light soil"
run light_soil light_soil 0.14 4 4 0.55 "clean light soil to clean light soil"
run light_soil light_soil 0.14 5 4 0.55 "clean light soil to clean light soil"
run light_soil light_soil 0.14 6 4 0.55 "clean light soil to clean light soil"
run light_soil light_soil 0.14 7 4 0.55 "clean light soil to clean light soil"
run light_soil light_soil 0.14 8 4 0.55 "clean light soil to clean light soil"
run light_soil light_soil 0.14 9 4 0.55 "clean light soil to clean light soil"
run light_soil light_soil 0.14 10 4 0.55 "clean light soil to clean light soil"
run light_soil light_soil 0.14 11 4 0.55 "clean light soil to clean light soil"
run light_soil light_soil 0.14 12 4 0.55 "clean light soil to clean light soil"
run light_soil light_soil 0.14 13 4 0.55 "clean light soil to clean light soil"
run light_soil light_soil 0.14 14 4 0.55 "clean light soil to clean light soil"
run light_soil light_soil 0.14 15 4 0.55 "clean light soil to clean light soil"
run parquet_floor parquet_floor 0.14 1 4 0.55 "clean parquet floor to clean parquet floor"
run parquet_floor parquet_floor 0.14 2 4 0.55 "clean parquet floor to clean parquet floor"
run parquet_floor parquet_floor 0.14 3 4 0.55 "clean parquet floor to clean parquet floor"
run parquet_floor parquet_floor 0.14 4 4 0.55 "clean parquet floor to clean parquet floor"
run parquet_floor parquet_floor 0.14 5 4 0.55 "clean parquet floor to clean parquet floor"
run parquet_floor parquet_floor 0.14 6 4 0.55 "clean parquet floor to clean parquet floor"
run parquet_floor parquet_floor 0.14 7 4 0.55 "clean parquet floor to clean parquet floor"
run parquet_floor parquet_floor 0.14 8 4 0.55 "clean parquet floor to clean parquet floor"
run parquet_floor parquet_floor 0.14 9 4 0.55 "clean parquet floor to clean parquet floor"
run parquet_floor parquet_floor 0.14 10 4 0.55 "clean parquet floor to clean parquet floor"
run parquet_floor parquet_floor 0.14 11 4 0.55 "clean parquet floor to clean parquet floor"
run parquet_floor parquet_floor 0.14 12 4 0.55 "clean parquet floor to clean parquet floor"
run parquet_floor parquet_floor 0.14 13 4 0.55 "clean parquet floor to clean parquet floor"
run parquet_floor parquet_floor 0.14 14 4 0.55 "clean parquet floor to clean parquet floor"
run parquet_floor parquet_floor 0.14 15 4 0.55 "clean parquet floor to clean parquet floor"
run slime slime 0.14 1 4 0.55 "clean slime to clean slime"
run slime slime 0.14 2 4 0.55 "clean slime to clean slime"
run slime slime 0.14 3 4 0.55 "clean slime to clean slime"
run slime slime 0.14 4 4 0.55 "clean slime to clean slime"
run slime slime 0.14 5 4 0.55 "clean slime to clean slime"
run slime slime 0.14 6 4 0.55 "clean slime to clean slime"
run slime slime 0.14 7 4 0.55 "clean slime to clean slime"
run slime slime 0.14 8 4 0.55 "clean slime to clean slime"
run slime slime 0.14 9 4 0.55 "clean slime to clean slime"
run slime slime 0.14 10 4 0.55 "clean slime to clean slime"
run slime slime 0.14 11 4 0.55 "clean slime to clean slime"
run slime slime 0.14 12 4 0.55 "clean slime to clean slime"
run slime slime 0.14 13 4 0.55 "clean slime to clean slime"
run slime slime 0.14 14 4 0.55 "clean slime to clean slime"
run slime slime 0.14 15 4 0.55 "clean slime to clean slime"
run snow snow 0.14 1 4 0.55 "clean snow to clean snow"
run snow snow 0.14 2 4 0.55 "clean snow to clean snow"
run snow snow 0.14 3 4 0.55 "clean snow to clean snow"
run snow snow 0.14 4 4 0.55 "clean snow to clean snow"
run snow snow 0.14 5 4 0.55 "clean snow to clean snow"
run snow snow 0.14 6 4 0.55 "clean snow to clean snow"
run snow snow 0.14 7 4 0.55 "clean snow to clean snow"
run snow snow 0.14 8 4 0.55 "clean snow to clean snow"
run snow snow 0.14 9 4 0.55 "clean snow to clean snow"
run snow snow 0.14 10 4 0.55 "clean snow to clean snow"
run snow snow 0.14 11 4 0.55 "clean snow to clean snow"
run snow snow 0.14 12 4 0.55 "clean snow to clean snow"
run snow snow 0.14 13 4 0.55 "clean snow to clean snow"
run snow snow 0.14 14 4 0.55 "clean snow to clean snow"
run snow snow 0.14 15 4 0.55 "clean snow to clean snow"
run water water 0.14 1 4 0.55 "clean water to clean water"
run water water 0.14 2 4 0.55 "clean water to clean water"
run water water 0.14 3 4 0.55 "clean water to clean water"
run water water 0.14 4 4 0.55 "clean water to clean water"
run water water 0.14 5 4 0.55 "clean water to clean water"
run water water 0.14 6 4 0.55 "clean water to clean water"
run water water 0.14 7 4 0.55 "clean water to clean water"
run water water 0.14 8 4 0.55 "clean water to clean water"
run water water 0.14 9 4 0.55 "clean water to clean water"
run water water 0.14 10 4 0.55 "clean water to clean water"
run water water 0.14 11 4 0.55 "clean water to clean water"
run water water 0.14 12 4 0.55 "clean water to clean water"
run water water 0.14 13 4 0.55 "clean water to clean water"
run water water 0.14 14 4 0.55 "clean water to clean water"
run water water 0.14 15 4 0.55 "clean water to clean water"
