#!/bin/zsh
# Daily english-peer run, started by launchd (see install.sh).
# Fires at the scheduled time (or on wake if asleep then) and at login; reviews at most once a day.
set -u
CODE="${0:A:h}"
COACH="$CODE/coach.ts"
DATA="${ENGLISH_PEER_DATA:-$HOME/.local/share/english-peer}"
export ENGLISH_PEER_DATA="$DATA"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
mkdir -p "$DATA/logs" "$DATA/inbox"
LOG="$DATA/logs/$(date +%F).log"
JOURNAL="$DATA/journal.jsonl"

# one recorded review per day is enough (FORCE=1 to rerun)
[[ -z "${FORCE:-}" ]] && grep -q "\"date\": \"$(date +%F)\"" "$JOURNAL" 2>/dev/null && exit 0
# login and wake can fire together
mkdir "$DATA/.lock" 2>/dev/null || exit 0
trap 'rmdir "$DATA/.lock"' EXIT

notify() { osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title "English Peer" subtitle (item 1 of argv) sound name "Glass"' -e 'end run' "$1" "$2"; }

{
  echo "== $(date '+%F %T') start"
  # right after login or wake the network may not be up yet
  for i in {1..18}; do curl -s -m 5 -o /dev/null https://api.anthropic.com && break; sleep 10; done

  setting() { bun -e 'console.log(JSON.parse(await Bun.file(Bun.argv[1]).text())[Bun.argv[2]] ?? Bun.argv[3])' "$DATA/config.json" "$1" "$2" 2>/dev/null || echo "$2"; }
  lang=$(setting native_language Spanish)
  model=$(setting model opus)
  prompt=$(sed -e "s#__COACH__#$COACH#g" -e "s#__INBOX__#$DATA/inbox#g" -e "s#__NATIVE_LANGUAGE__#$lang#g" "$CODE/PROMPT.md")

  before=$(wc -l <"$JOURNAL" 2>/dev/null || echo 0)
  claude -p "$prompt" --model "$model" \
    --allowedTools "Bash(bun $COACH:*)" "Read" "Edit(/$DATA/inbox/**)" \
    --permission-mode dontAsk
  echo "== $(date '+%F %T') exit $?"
  after=$(wc -l <"$JOURNAL" 2>/dev/null || echo 0)

  if (( after > before )); then
    bun "$COACH" render && open "$DATA/out/english-peer.html"
    headline=$(tail -1 "$JOURNAL" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).headline)')
    notify "Today's review is open in your browser" "$headline"
  else
    notify "No review recorded today" "See the log in $DATA/logs"
  fi
} >>"$LOG" 2>&1
