#!/bin/zsh
# Install (or update) english-peer: a daily review of the English in your Claude Code prompts.
#
#   ./install.sh [--time HH:MM] [--language Spanish] [--yes]
#   ./install.sh --uninstall        # remove the daily job, keep your reviews
#
# Safe to rerun: it rewrites the launchd job and keeps all data in
# $ENGLISH_PEER_DATA (default ~/.local/share/english-peer).
set -euo pipefail

CODE="${0:A:h}"
DATA="${ENGLISH_PEER_DATA:-$HOME/.local/share/english-peer}"
LABEL="com.english-peer.daily"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LEGACY_DIR="$HOME/.local/share/english-coach"
TIME="08:30" LANGUAGE="" YES=0 UNINSTALL=0

while (( $# )); do
  case "$1" in
    --time) TIME="$2"; shift ;;
    --language) LANGUAGE="$2"; shift ;;
    --yes|-y) YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { print -P "%F{blue}==>%f $*"; }
die() { print -P "%F{red}error:%f $*" >&2; exit 1; }
confirm() {
  (( YES )) && return 0
  read -q "?$1 [y/N] " || { echo; return 1; }
  echo
}
unload() { launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true; }

if (( UNINSTALL )); then
  unload "$LABEL"; rm -f "$PLIST"
  say "Daily job removed. Your reviews are still in $DATA"
  exit 0
fi

# 1. requirements
[[ "$(uname)" == Darwin ]] || die "macOS only (uses launchd and notifications)"
command -v python3 >/dev/null || die "python3 not found"
CLAUDE_BIN=$(command -v claude || true)
[[ -n "$CLAUDE_BIN" ]] || die "claude CLI not found; install Claude Code and log in first"
[[ "$TIME" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || die "--time must be HH:MM, got $TIME"
[[ -f "$HOME/.claude/history.jsonl" ]] || say "No ~/.claude/history.jsonl yet; reviews start once you've used Claude Code"

# 2. move data from the earlier english-coach setup, if there is one
if [[ -d "$LEGACY_DIR" && ! -e "$DATA" ]]; then
  if confirm "Move your existing reviews from $LEGACY_DIR to $DATA?"; then
    mkdir -p "$DATA/legacy-code"
    for f in coach.py PROMPT.md template.html run.sh "$LEGACY_DIR"/*.plist(N:t); do
      [[ -e "$LEGACY_DIR/$f" ]] && mv "$LEGACY_DIR/$f" "$DATA/legacy-code/"
    done
    mv "$LEGACY_DIR"/*(DN) "$DATA/"
    rmdir "$LEGACY_DIR"
    say "Reviews moved to $DATA (old code kept in $DATA/legacy-code)"
  fi
fi
# old daily jobs from the earlier setup were named <something>.english-coach
for legacy_plist in "$HOME"/Library/LaunchAgents/*.english-coach.plist(N); do
  legacy_label="${legacy_plist:t:r}"
  if confirm "Replace the old daily job ($legacy_label) with $LABEL?"; then
    unload "$legacy_label"; rm -f "$legacy_plist"
    say "Old daily job removed"
  else
    die "Both jobs would run every day; rerun when you're ready to replace it"
  fi
done

# 3. data dir and config (existing settings are kept)
mkdir -p "$DATA/logs" "$DATA/inbox" "$DATA/out"
python3 - "$DATA/config.json" "$LANGUAGE" <<'EOF'
import json, sys
path, language = sys.argv[1], sys.argv[2]
try:
    cfg = json.load(open(path))
except FileNotFoundError:
    cfg = {}
defaults = {
    "native_language": "Spanish",
    "model": "opus",
    "ignore_project_prefixes": ["/private/tmp", "/tmp"],
    "ignore_prompts_containing": [],
    "min_words": 3,
    "target_prompts": 150,
    "max_prompts": 300,
}
cfg = {**defaults, **cfg}
if language:
    cfg["native_language"] = language
json.dump(cfg, open(path, "w"), indent=1)
open(path, "a").write("\n")
print(f"config: {path} (native language: {cfg['native_language']}, model: {cfg['model']})")
EOF

# 4. daily job
chmod +x "$CODE/run.sh" "$CODE/coach.py"
mkdir -p "${PLIST:h}"
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>$CODE/run.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>ENGLISH_PEER_DATA</key><string>$DATA</string></dict>
  <!-- daily; if the Mac is asleep then, launchd runs it on wake -->
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$((10#${TIME%:*}))</integer><key>Minute</key><integer>$((10#${TIME#*:}))</integer></dict>
  <!-- also at login, so a day the Mac was shut down isn't skipped -->
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$DATA/logs/launchd.err</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null || die "generated $PLIST is invalid"

if ! grep -q "\"date\": \"$(date +%F)\"" "$DATA/journal.jsonl" 2>/dev/null; then
  say "No review yet today, so loading the job starts one now (a few minutes, then the page opens)"
fi
unload "$LABEL"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl print "gui/$(id -u)/$LABEL" >/dev/null || die "launchd did not load $LABEL"

say "Installed. Daily review at $TIME (or on wake/login), data in $DATA"
say "Try: python3 $CODE/coach.py search <word>   |   FORCE=1 $CODE/run.sh for an extra batch"
