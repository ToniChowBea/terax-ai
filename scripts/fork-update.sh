#!/usr/bin/env bash
# Weekly update for a personal Terax fork: merge the latest upstream main into
# your branch, keep the auto-updater disabled, and run the checks.
#
# Settings (override as env vars, e.g. `FORK_BRANCH=foo make update`):
#   FORK_BRANCH       your branch                     (default: ssh-port)
#   UPSTREAM_URL      the official repo               (default: crynta/terax-ai)
#   UPSTREAM_BRANCH   branch to track upstream        (default: main)
#   SKIP_CHECKS=1     merge only, don't run checks
set -euo pipefail

FORK_BRANCH="${FORK_BRANCH:-ssh-port}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/crynta/terax-ai.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"

cd "$(git rev-parse --show-toplevel)"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Find the remote that points at the official repo, adding one if needed.
#    Works whether you cloned upstream directly (origin) or a fork (upstream).
norm() { echo "$1" | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##' | tr 'A-Z' 'a-z'; }
want="$(norm "$UPSTREAM_URL")"
UPSTREAM_REMOTE=""
for r in $(git remote); do
  if [ "$(norm "$(git remote get-url "$r")")" = "$want" ]; then UPSTREAM_REMOTE="$r"; break; fi
done
if [ -z "$UPSTREAM_REMOTE" ]; then
  say "Adding remote 'upstream' -> $UPSTREAM_URL"
  git remote add upstream "$UPSTREAM_URL"
  UPSTREAM_REMOTE=upstream
fi

# 2. Refuse to run on a dirty tree or mid-merge, so nothing of yours is lost.
[ -f "$(git rev-parse --git-dir)/MERGE_HEAD" ] && die "A merge is already in progress. Finish it or run 'make update-abort'."
git diff --quiet && git diff --cached --quiet || die "You have uncommitted changes. Commit or stash them first."

current="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current" != "$FORK_BRANCH" ]; then
  say "Switching from $current to $FORK_BRANCH"
  git checkout "$FORK_BRANCH"
fi

# 3. Fetch. A shallow clone can't find a merge base, so deepen it first.
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  say "Shallow clone detected, fetching full history (one-time, may take a minute)"
  git fetch --unshallow "$UPSTREAM_REMOTE" || git fetch --depth=5000 "$UPSTREAM_REMOTE"
fi
say "Fetching $UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
target="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"

new="$(git rev-list --count "HEAD..$target")"
if [ "$new" -eq 0 ]; then
  say "Already up to date with $target. Nothing to do."
  exit 0
fi
say "$new new upstream commit(s):"
git --no-pager log --oneline --no-decorate -n 15 "HEAD..$target"
[ "$new" -gt 15 ] && echo "   ... and $((new - 15)) more"

# 4. Safety net: a backup branch you can always return to.
backup="backup/${FORK_BRANCH}-$(date +%Y%m%d-%H%M%S)"
git branch "$backup"
say "Backup of your current branch: $backup"

# 5. Merge.
if ! git merge --no-edit -m "Merge upstream $UPSTREAM_BRANCH into $FORK_BRANCH" "$target"; then
  echo
  warn "Merge conflicts in:"
  git diff --name-only --diff-filter=U | sed 's/^/   /'
  cat <<EOF

Options:
  - Resolve the files above, then:  git add <files> && git commit --no-edit
    and run 'make verify' afterwards.
  - Give up for now:                make update-abort
  - Return to before this update:   git reset --hard $backup
EOF
  exit 1
fi

# 6. Upstream may re-enable the auto-updater; switch it back off if so.
conf=src-tauri/tauri.conf.json
hook=src/modules/updater/useUpdater.ts
fixed=0
if grep -qE '"endpoints": \[[^]]' "$conf" 2>/dev/null || grep -qE '"endpoints": \[$' "$conf" 2>/dev/null; then
  warn "Upstream re-added updater endpoints in $conf. Check it and set \"endpoints\": [] again."
fi
if grep -q '"createUpdaterArtifacts": true' "$conf" 2>/dev/null; then
  sed -i.bak 's/"createUpdaterArtifacts": true/"createUpdaterArtifacts": false/' "$conf" && rm -f "$conf.bak"; fixed=1
fi
if [ -f "$hook" ] && ! grep -q 'UPDATER_ENABLED = false' "$hook"; then
  warn "UPDATER_ENABLED = false is missing from $hook after the merge. Re-add it before building."
fi
if [ "$fixed" = 1 ]; then
  git commit -am "chore(fork): keep the auto-updater disabled after upstream merge" >/dev/null
  say "Re-disabled updater artifacts"
fi

# 7. Checks.
if [ "${SKIP_CHECKS:-0}" = 1 ]; then
  say "Merged. Checks skipped (SKIP_CHECKS=1). Run 'make verify' when ready."
  exit 0
fi
say "Running checks"
if ! make --no-print-directory verify; then
  warn "Merged, but checks failed. Fix them, or undo with: git reset --hard $backup"
  exit 1
fi

say "Done. Merged $new upstream commit(s) into $FORK_BRANCH; checks pass."
say "Next: 'make install' to build and install the app."
