#!/usr/bin/env bash
# One command for a machine that does not have Anymem yet. It gets the code and runs the init script.
#   bash scripts/bootstrap.sh                 from a clone you already have
#   curl -fsSL <raw url of this file, pinned to a release tag> | bash  from nothing (needs git)
# From nothing, the code checked out is the newest release tag (v*), or ANYMEM_REF when set, such as v2.2.0 or a commit. Tags are
# not signed, so this pins the code to a release instead of whatever the default branch holds. ANYMEM_REF=main takes the branch.
# Needs python3 (3.9 or newer) and git. No Node.js and no Wrangler. A new store needs a Cloudflare API token, setup.py --scopes
# prints the permissions, and CLOUDFLARE_API_TOKEN (or a hidden prompt) supplies it. The token is never written to disk.
# Extra arguments go to init.py, for example --create --yes --name anymem --plan paid.
# Safe to rerun. It updates the clone and init skips what is done.
set -euo pipefail

REPO="${ANYMEM_REPO:-https://github.com/dhlotter/anymem.git}"
DEST="${ANYMEM_HOME_DIR:-$HOME/.local/share/anymem}"

command -v python3 >/dev/null || { echo "Python 3.9 or newer is needed (python3 was not found)." >&2; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo "Python 3.9 or newer is needed." >&2; exit 1; }

here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$here" ] && [ -f "$here/../skills/anymem/scripts/init.py" ]; then
  ROOT="$(cd "$here/.." && pwd)"            # run from a clone
else
  command -v git >/dev/null || { echo "git is needed to fetch Anymem (git was not found)." >&2; exit 1; }
  if [ -d "$DEST/.git" ]; then
    git -C "$DEST" fetch --tags --quiet origin || echo "Could not fetch $REPO (offline). Using the copy that is there." >&2
  else
    git clone "$REPO" "$DEST"
  fi
  REF="${ANYMEM_REF:-}"
  if [ -z "$REF" ]; then REF="$(git -C "$DEST" tag --list 'v*' --sort=-v:refname | head -1)"; fi
  [ -n "$REF" ] || { echo "No release tag found in $REPO. Set ANYMEM_REF to a tag, a commit, or main." >&2; exit 1; }
  # a branch name means the remote branch as just fetched, not a local copy that may be as old as the first clone
  TARGET="$REF"
  git -C "$DEST" rev-parse --verify --quiet "origin/$REF^{commit}" >/dev/null && TARGET="origin/$REF"
  git -C "$DEST" checkout --quiet --detach "$TARGET" || { echo "Could not check out $REF in $DEST. Fix it or set ANYMEM_REF to another tag." >&2; exit 1; }
  ROOT="$DEST"
fi

exec python3 "$ROOT/skills/anymem/scripts/init.py" "$@"
