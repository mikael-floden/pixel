#!/usr/bin/env bash
# Watchdog: keep the character factory loop alive without a human or a Claude
# session. It respawns loop.py whenever it isn't running (crash, transient fatal,
# or a completed pass), on its own detached process — so generation continues
# between check-ins and after this session ends. A full container restart is the
# only thing that stops it; the next session (or the hourly Routine) re-launches
# this watchdog. Start it once, detached:
#
#   setsid nohup bash characters/pipeline/run_forever.sh >/tmp/pixel-watchdog.log 2>&1 & disown
#
REPO=/home/user/pixel
LOG=/tmp/pixel-loop.log
cd "$REPO" || exit 1
[ -f .env ] && export $(grep -v '^#' .env | xargs) 2>/dev/null

while true; do
  if ! pgrep -f "python -u characters/pipeline/loop.py" >/dev/null 2>&1; then
    echo "[watchdog $(date -u +%FT%TZ)] loop down -> starting" >> "$LOG"
    nohup python -u characters/pipeline/loop.py >> "$LOG" 2>&1 &
  fi
  sleep 60
done
