#!/bin/sh
# Update the installed anymem plugin in Claude Code and Codex after a version bump, without breaking chats that are
# already open. `codex plugin remove` deletes the old version's folder, and an open Codex chat still runs its hooks from that
# folder, so every prompt in it fails with "can't open file ... hook.py" until Codex restarts. This keeps the older versions.
# Claude Code keeps old versions itself. Usage: scripts/upgrade-plugins.sh
set -eu
NAME="anymem@anymem"
CODEX_CACHE="$HOME/.codex/plugins/cache/anymem/anymem"
KEEP="$(mktemp -d)"
trap 'rm -rf "$KEEP"' EXIT

claude plugin marketplace update anymem
claude plugin update "$NAME"

if [ -d "$CODEX_CACHE" ]; then cp -R "$CODEX_CACHE/." "$KEEP/"; fi

# put back every older version that remove deleted, never overwriting the one already in the cache
restore_kept() {
  mkdir -p "$CODEX_CACHE"
  for d in "$KEEP"/*/; do
    [ -d "$d" ] || continue
    v="$(basename "$d")"
    [ -d "$CODEX_CACHE/$v" ] || cp -R "$d" "$CODEX_CACHE/$v"
  done
}

codex plugin remove "$NAME"
if ! codex plugin add "$NAME"; then
  # add failed after remove deleted the folders, so the open chats would have no hooks. Put the older versions back first.
  restore_kept
  echo "codex plugin add $NAME failed. The older versions were put back in $CODEX_CACHE. Fix the cause and run this again." >&2
  exit 1
fi
restore_kept
echo "Done. Restart Claude Code and Codex chats when convenient to load the new version."
