#!/usr/bin/env bash
# Commit and push ./site to the media branch. Every ~150 commits the branch is squashed to a single
# snapshot so old videos stop taking up space (uses --force-with-lease so a clip you're uploading isn't lost).
set -euo pipefail
cd site
git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "${1:-Update media}"
fi
count=$(git rev-list --count HEAD 2>/dev/null || echo 0)
if [ "$count" -gt 150 ] && git rev-parse -q --verify origin/media >/dev/null; then
  lease=$(git rev-parse origin/media)
  git checkout -q --orphan media-snapshot
  git commit -q -m "Media snapshot $(date -u +%F)"
  if git push -q --force-with-lease="media:${lease}" origin media-snapshot:media; then
    echo "Squashed media branch history"; exit 0
  fi
  echo "Remote media branch moved; skipping squash this time"
  git checkout -q media
fi
for i in 1 2 3 4; do
  if git push -q origin HEAD:media; then echo "media branch pushed"; exit 0; fi
  git pull -q --rebase origin media
done
echo "could not push media branch" >&2; exit 1
