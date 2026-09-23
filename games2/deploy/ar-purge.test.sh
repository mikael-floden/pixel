#!/usr/bin/env bash
# GATE FOR ar-purge.sh — it deletes production container images, so its keep
# rule is tested rather than reasoned about. Self-contained: it writes a stubbed
# `gcloud` into a temp dir, puts that first on PATH, and asserts on what the
# script asked the stub to delete. Needs no gcloud, no network and no project.
#
#   bash games2/deploy/ar-purge.test.sh
#
# THE ARM THAT PAYS FOR THE FILE is S2/S10. The first draft of ar-purge.sh
# deleted every version older than KEEP_DAYS and argued it was safe because "the
# fleet deploys many times a day, so the serving image is hours old". The
# service runs --min-instances 0 (nangijala-deploy.yml:533), so a cold start
# PULLS FROM THIS REPOSITORY — and the day the fleet goes quiet for two weeks,
# that rule deletes the image the world boots from. S10 runs the replaced rule
# against a fixture where every version is old and shows it deleting the serving
# digest; S2 runs the shipped rule on the same fixture and shows it kept.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/ar-purge.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export STATE="$TMP/state"; export PATH="$TMP/bin:$PATH"
mkdir -p "$TMP/bin"
IMG="europe-north1-docker.pkg.dev/p-nangijala/nangijala/nangijala"
PASS=0; FAIL=0

cat > "$TMP/bin/gcloud" <<'STUB'
#!/usr/bin/env bash
# Fake Artifact Registry + Cloud Run. Deletes append to $S/gone (persistent,
# what `list` subtracts) and $S/deleted (the per-run assertion log), so 8-way
# parallel deletes cannot race a read-modify-write of the version file.
S="$STATE"; args="$*"
echo "$args" >> "$S/calls.log"
case "$args" in
  "config get-value project"*) cat "$S/active_project" 2>/dev/null; exit 0 ;;
  "config set project"*)       exit 0 ;;
  "projects list"*)            cat "$S/projects" 2>/dev/null; exit 0 ;;
  "artifacts repositories describe"*)
      # A repository lives in ONE project. $S/repo_in names it; a describe
      # against any other project 404s, exactly as gcloud does — which is what
      # the multi-project probe reads.
      want="$(cat "$S/repo_in" 2>/dev/null)"
      asked=""
      for a in "$@"; do case "$a" in --project=*) asked="${a#--project=}" ;; esac; done
      if [ -n "$want" ] && [ -n "$asked" ] && [ "$asked" != "$want" ]; then
        echo "NOT_FOUND: $asked" >&2; exit 1
      fi
      echo "Repository Size: 488148.057MB"; exit 0 ;;
  "run services describe"*)
      case "$args" in
        *latestReadyRevisionName*) cat "$S/revision" 2>/dev/null ;;
        *)                         cat "$S/serving_image" 2>/dev/null ;;
      esac; exit 0 ;;
  "run revisions describe"*) cat "$S/revision_digest" 2>/dev/null; exit 0 ;;
  "artifacts docker images describe"*)
      ref="$5"; tag="${ref##*:}"
      # An unset tag 404s, exactly as gcloud does — which is what the script's
      # `|| true` and empty-guard are written against.
      out="$(grep "^${tag}," "$S/tags" 2>/dev/null | cut -d, -f2)"
      [ -z "$out" ] && { echo "NOT_FOUND: $tag" >&2; exit 1; }
      printf '%s\n' "$out"; exit 0 ;;
  "artifacts docker images list"*)
      case "$args" in *buildcache*) echo "buildcache was LISTED" >> "$S/violations"; exit 1 ;; esac
      # getline, NOT the NR==FNR idiom: with an EMPTY first file FNR never
      # advances, so NR==FNR holds for the second file's first record and the
      # whole listing is swallowed.
      awk -F, -v G="$S/gone" 'BEGIN { while ((getline l < G) > 0) gone[l]=1 }
           { d=$1; sub(/^.*\//,"",d); if (!(d in gone)) print }' "$S/versions" > "$S/live"
      case "$args" in
        *"csv[no-heading]"*) cat "$S/live" ;;
        *)                   cut -d, -f1 "$S/live" ;;
      esac; exit 0 ;;
  "artifacts docker images delete"*)
      ref="$5"
      case "$ref" in *buildcache*) echo "delete targeted buildcache: $ref" >> "$S/violations"; exit 1 ;; esac
      case "$ref" in
        */nangijala/nangijala@sha256:*) ;;
        *) echo "delete ref is not <image>@<digest>: $ref" >> "$S/violations"; exit 1 ;;
      esac
      d="${ref##*@}"
      if ! grep -q "${d}," "$S/versions" || grep -qx "$d" "$S/gone"; then echo NOT_FOUND >&2; exit 1; fi
      echo "$d" >> "$S/gone"; echo "$d" >> "$S/deleted"; exit 0 ;;
esac
echo "unhandled gcloud call: $args" >> "$S/violations"; exit 1
STUB
chmod +x "$TMP/bin/gcloud"

reset() {
  rm -rf "$STATE"; mkdir -p "$STATE"
  for f in calls.log deleted gone violations tags versions repo_in \
           serving_image revision revision_digest; do : > "$STATE/$f"; done
  echo p-nangijala > "$STATE/active_project"
  echo p-nangijala > "$STATE/projects"
}
ok()    { PASS=$((PASS+1)); printf '   ok   %s\n' "$1"; }
bad()   { FAIL=$((FAIL+1)); printf '   FAIL %s\n' "$1"; }
is()    { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: want '$3' got '$2'"; fi; }
kept()  { if grep -qx "$2" "$STATE/deleted"; then bad "$1: $2 WAS deleted"; else ok "$1"; fi; }
gone_() { if grep -qx "$2" "$STATE/deleted"; then ok "$1"; else bad "$1: $2 was NOT deleted"; fi; }
says()  { if grep -q "$2" "$STATE/out"; then ok "$1"; else bad "$1: missing '$2'"; fi; }
clean() { if [ -s "$STATE/violations" ]; then bad "stub violations:"; cat "$STATE/violations"
          else ok "no buildcache touched; every delete ref was <image>@<digest>"; fi; }
# The arms below exercise the RULE at a known N, so they pin KEEP_NEWEST=15
# rather than riding the shipped default — which is 200 and is asserted, along
# with KEEP_DAYS, against ar-cleanup.sh's policy in S11. An arm can override by
# passing its own (env takes the LAST assignment).
run()   { env KEEP_NEWEST=15 "$@" bash "$SCRIPT" > "$STATE/out" 2>&1; echo $?; }
nth()   { sort -t, -k2,2r "$STATE/versions" | sed -n "${1}p" | cut -d, -f1; }

# DATES ARE RELATIVE TO NOW, never literals. They were hardcoded to September
# 2026 and would have started failing the day KEEP_DAYS came down to 2 — the
# "fresh" rows were two days old by then. A fixture carrying today's date is a
# test with an expiry date on it.
#   FRESH: the last few hours, inside any KEEP_DAYS >= 1.
#   OLD:   a month back, outside any window this repo would set.
# Newest-first ordering = every fresh row, then the old ones.
ago() { date -u -d "-$1 minutes" +%Y-%m-%dT%H:%M:%S.000000Z 2>/dev/null \
        || date -u -v-"$1"M +%Y-%m-%dT%H:%M:%S.000000Z; }
fresh() { local i; for i in $(seq 1 "$1"); do
  printf '%ssha256:new%03d,%s\n' "${STYLE:-}" "$i" "$(ago $((i * 5)))"; done; }
old()   { local i; for i in $(seq 1 "$1"); do
  printf '%ssha256:old%03d,%s\n' "${STYLE:-}" "$i" "$(ago $(( 43200 + i * 17 )))"; done; }
serve() { echo "${IMG}:abc123" > "$STATE/serving_image"; printf 'abc123,%s\n' "$1" >> "$STATE/tags"; }

echo "S1  normal day: 20 fresh + 120 old, serving is fresh"
reset; { fresh 20; old 120; } > "$STATE/versions"; serve sha256:new001
printf 'latest,sha256:new001\n' >> "$STATE/tags"
is   "exit 0" "$(run)" "0"
is   "deleted every old version" "$(grep -c . "$STATE/deleted")" "120"
kept "serving digest kept" sha256:new001
kept "newest fresh kept"   sha256:new020
gone_ "an old one really went" sha256:old001
says "count BEFORE printed" "versions BEFORE: 140"
says "count AFTER printed"  "versions AFTER:  20"
says "tally printed"        "deleted 120, failed 0"
clean

echo "S2  FLEET QUIET — every version older than KEEP_DAYS, serving 30th newest"
reset; old 40 > "$STATE/versions"
SERV="$(nth 30)"; K15="$(nth 15)"; K16="$(nth 16)"
echo "${IMG}:deadbee" > "$STATE/serving_image"
printf 'deadbee,%s\nlatest,%s\n' "$SERV" "$SERV" > "$STATE/tags"
is   "exit 0" "$(run)" "0"
kept "THE SERVING IMAGE SURVIVED an all-old registry" "$SERV"
kept "15th newest kept"     "$K15"
gone_ "16th newest deleted" "$K16"
is   "deleted 40 - 15 newest - 1 serving" "$(grep -c . "$STATE/deleted")" "24"
clean

echo "S3  serving digest unreadable — the newest-N arm alone protects the boot image"
reset; old 40 > "$STATE/versions"
is   "exit 0" "$(run)" "0"
kept "newest kept with no Cloud Run read at all" "$(nth 1)"
kept "15th newest kept"                          "$(nth 15)"
is   "deleted 40 - 15" "$(grep -c . "$STATE/deleted")" "25"
says "says so out loud" "could not read the serving digest"
clean

echo "S4  version field arrives as a full projects/.../versions/ path"
reset; STYLE="projects/p/locations/l/repositories/r/packages/nangijala/versions/"
{ fresh 16; old 30; } > "$STATE/versions"; unset STYLE; serve sha256:new001
is   "exit 0" "$(run)" "0"
is   "deleted every old version" "$(grep -c . "$STATE/deleted")" "30"
gone_ "delete target is the bare digest, path stripped" sha256:old001
clean

echo "S5  idempotent: run twice"
reset; { fresh 20; old 50; } > "$STATE/versions"; serve sha256:new001
run >/dev/null
is "first run deleted"          "$(grep -c . "$STATE/deleted")" "50"
: > "$STATE/deleted"
is "second run exit 0"          "$(run)" "0"
is "second run deleted nothing" "$(grep -c . "$STATE/deleted")" "0"
says "says nothing to do"       "nothing to do"
says "second run sees 20 left"  "versions BEFORE: 20"
clean

echo "S6  DRY_RUN deletes nothing"
reset; { fresh 20; old 50; } > "$STATE/versions"; serve sha256:new001
DRY_RUN=1 KEEP_NEWEST=15 bash "$SCRIPT" > "$STATE/out" 2>&1
is   "dry run exit 0" "$?" "0"
is   "dry run deleted nothing" "$(grep -c . "$STATE/deleted")" "0"
says "lists 20 and counts the rest" "and 30 more"
clean

echo "S7  project derivation (a fresh Cloud Shell opens as '(no project)')"
reset; old 3 > "$STATE/versions"; : > "$STATE/active_project"
is   "the only project is derived" "$(run)" "0"
says "names it" "using the only one on this account: p-nangijala"
printf 'p-a\np-b\n' > "$STATE/projects"; : > "$STATE/active_project"
is   "several projects -> exit 1" "$(run)" "1"
says "hands back a ready paste line" "gcloud config set project THE-ID"

echo "S7b SEVERAL projects: the one holding the registry is DERIVED, not asked"
# Maintainer 2026-09-23, on his phone: the paste ran, found two projects, printed
# a line to edit and stopped. He replied "Done" — it had deleted nothing. Only
# one of his projects holds the repository, so this was never a decision to put
# to a human; and the project is spelled `nagijala` against the repo's
# `nangijala`, so it cannot be guessed either.
reset; { fresh 20; old 30; } > "$STATE/versions"; serve sha256:new001
: > "$STATE/active_project"
printf 'custom-point-416909\nnagijala\n' > "$STATE/projects"
echo "nagijala" > "$STATE/repo_in"
is   "exit 0 — it picked one and ran" "$(run)" "0"
says "and named which, and why" "the only one with a nangijala repository"
says "it used that project"      "project=nagijala"
is   "it actually purged"        "$(grep -c . "$STATE/deleted")" "30"
clean

echo "S7c ...but a genuinely ambiguous answer still asks"
reset; old 3 > "$STATE/versions"
: > "$STATE/active_project"
printf 'p-a\np-b\n' > "$STATE/projects"
: > "$STATE/repo_in"                      # empty = every project answers, so 2 match
is   "several holders -> exit 1" "$(run)" "1"
says "hands back a ready paste line" "gcloud config set project THE-ID"
reset; old 3 > "$STATE/versions"
: > "$STATE/active_project"
printf 'p-a\np-b\n' > "$STATE/projects"
echo "p-nobody" > "$STATE/repo_in"        # none of them hold it
is   "no holder -> exit 1" "$(run)" "1"
says "says how many held it" "0 hold a nangijala repository"

echo "S8  a STALE :latest tag on an old digest is protected"
reset; { fresh 20; old 30; } > "$STATE/versions"; serve sha256:new001
printf 'latest,sha256:old007\n' >> "$STATE/tags"
is   "exit 0" "$(run)" "0"
kept ":latest's old digest kept" sha256:old007
is   "deleted 30 - 1" "$(grep -c . "$STATE/deleted")" "29"
clean

echo "S8b THE BOOT IMAGE: an OLD digest wearing :live is never deleted"
# Maintainer 2026-09-23: "the important point is the current version is not
# purged so the game can always load/boot." :latest follows the BUILD; :live
# follows the ROLLOUT, so it is the only tag that names what the service boots
# from. --min-instances 0 means a cold start PULLS it: delete it and the next
# scale-from-zero is "Nangijala could not start".
reset; { fresh 5; old 40; } > "$STATE/versions"       # only 5 fresh: the newest-N
serve sha256:new001                                    # rule cannot be what saves it
LIVE="$(nth 25)"                                       # ...25th newest, and OLD
printf 'live,%s\n' "$LIVE" >> "$STATE/tags"
is   "exit 0" "$(run KEEP_NEWEST=10)" "0"
kept "the :live digest survived, though old and outside the newest 10" "$LIVE"
says "and it said which" ":live is:"
clean

echo "S9  empty registry"
reset
is   "exit 0 on an empty listing" "$(run)" "0"
is   "nothing deleted" "$(grep -c . "$STATE/deleted")" "0"
says "says the listing was empty" "nothing listed"

echo "S10 THE RULE THIS REPLACED, on S2's fixture — proof the gate is real"
reset; old 40 > "$STATE/versions"
SERV="$(nth 30)"
echo "${IMG}:deadbee" > "$STATE/serving_image"
printf 'deadbee,%s\nlatest,%s\n' "$SERV" "$SERV" > "$STATE/tags"
# The replaced rule, in full: everything older than the cutoff, nothing spared.
gcloud artifacts docker images list "$IMG" --format='value(version)' \
  --filter="createTime<2026-09-08T00:00:00" --limit=100000 2>/dev/null | grep . \
  | xargs -r -P 8 -I{} sh -c \
      'gcloud artifacts docker images delete "$1@{}" --delete-tags --quiet >/dev/null 2>&1' _ "$IMG"
gone_ "the replaced rule DELETES the serving image" "$SERV"
is    "and takes the whole repository with it" "$(grep -c . "$STATE/deleted")" "40"

echo "S11 the two scripts are ONE rule — the purge's defaults match the policy"
# ar-cleanup.sh installs the rule server-side; ar-purge.sh runs the same rule by
# hand. If they drift, the manual purge deletes what the policy means to keep,
# or spares what it means to take. Nothing else checks this, and it is a
# one-character edit away at all times.
CLEANUP="$(cd "$(dirname "$0")" && pwd)/ar-cleanup.sh"
pol_days="$(grep -oE '"olderThan": *"[0-9]+d"' "$CLEANUP" | grep -oE '[0-9]+' | head -1)"
pol_keep="$(grep -oE '"keepCount": *[0-9]+' "$CLEANUP" | grep -oE '[0-9]+' | head -1)"
scr_days="$(grep -E '^KEEP_DAYS=' "$SCRIPT" | grep -oE '[0-9]+' | head -1)"
scr_keep="$(grep -E '^KEEP_NEWEST=' "$SCRIPT" | grep -oE '[0-9]+' | head -1)"
is "policy window is 2 days"            "$pol_days"  "2"
is "purge KEEP_DAYS matches it"         "$scr_days"  "$pol_days"
is "purge KEEP_NEWEST matches keepCount" "$scr_keep" "$pol_keep"
if grep -q '"name": *"keep-live"' "$CLEANUP"; then ok "the policy keeps :live by name"
else bad "the policy has no keep-live rule — the boot image is only held by the count"; fi
if grep -q 'LIVE_DIGEST' "$SCRIPT"; then ok "the purge protects :live too"
else bad "the purge does not read :live"; fi

echo
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
