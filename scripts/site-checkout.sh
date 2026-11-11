#!/usr/bin/env bash
# Check out the "media" branch (the GitHub Pages site with rendered images/videos) into ./site.
# Creates the branch on first run.
set -euo pipefail
git config user.name "meme-engine bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
if git ls-remote --exit-code --heads origin media >/dev/null 2>&1; then
  git fetch origin media
  git worktree add -B media site origin/media
else
  git worktree add --orphan -b media site
fi
git -C site config user.name "meme-engine bot"
git -C site config user.email "41898282+github-actions[bot]@users.noreply.github.com"
