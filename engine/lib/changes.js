// Conflict-safe updates to queue files.
// The review app and the GitHub workflows can edit the same queue file at the same time, so every
// automated change is recorded as a small patch and re-applied on top of the latest version if a push races.
"use strict";
const path = require("path");
const { execFileSync } = require("child_process");
const U = require("./util");

/** Hash of everything that affects how a post looks. A render only "counts" if this still matches. */
function contentHash(p) {
  const s = JSON.stringify([p.format, p.template, p.a, p.b, p.l, p.s, p.footage, p.footageIndex, p.audioIndex, p.customClip, p.mood, p.visual, p.visual2, p.imageIndex, p.mt, p.ml, p.sfx, p.sfxIndex, p.clip, p.still, p.clipAudio]);
  let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

/** changes: [{file (relative to repo), id, patch, expectHash?}] -> number applied */
function applyChanges(changes) {
  const byFile = new Map();
  for (const c of changes) { if (!byFile.has(c.file)) byFile.set(c.file, []); byFile.get(c.file).push(c); }
  let applied = 0;
  for (const [rel, list] of byFile) {
    const file = path.join(U.ROOT, rel), doc = U.readJSON(file, null);
    if (!doc) continue;
    for (const c of list) {
      const p = doc.posts.find((x) => x.id === c.id);
      if (!p) continue;
      if (c.expectHash && contentHash(p) !== c.expectHash) { U.log(`skip stale change for ${c.id} (edited in review meanwhile)`); continue; }
      Object.assign(p, c.patch); applied++;
    }
    U.writeJSON(file, doc);
  }
  return applied;
}

function git(args, cwd = U.ROOT) { return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }
function hasStaged(cwd) { try { execFileSync("git", ["diff", "--cached", "--quiet"], { cwd }); return false; } catch { return true; } }

/** Commit queue patches (plus any extra paths) to main, retrying on push races. */
function commitQueue(changes, message, extraPaths = []) {
  if (process.env.NO_GIT) { applyChanges(changes); return; }
  const branch = process.env.MAIN_BRANCH || "main";
  for (let attempt = 1; attempt <= 6; attempt++) {
    applyChanges(changes);
    git(["add", "queue", ...extraPaths]);
    if (!hasStaged(U.ROOT)) return;
    git(["commit", "-m", message]);
    try { git(["push", "origin", `HEAD:${branch}`]); U.log(`pushed: ${message}`); return; }
    catch (e) {
      U.log(`push raced (attempt ${attempt}); re-applying on latest`);
      git(["fetch", "origin", branch]);
      // keep our non-queue files (state/*) by rebasing them; queue changes are re-applied from patches
      git(["reset", "--hard", `origin/${branch}`]);
    }
  }
  throw new Error("could not push queue changes after 6 attempts");
}

/** Commit and push the media site branch. */
function pushSite(message) {
  if (process.env.NO_GIT) return;
  const cwd = U.SITE, branch = process.env.SITE_BRANCH || "media";
  git(["add", "-A"], cwd);
  if (!hasStaged(cwd)) return false;
  git(["commit", "-m", message], cwd);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { git(["push", "origin", `HEAD:${branch}`], cwd); return true; }
    catch { git(["pull", "--rebase", "origin", branch], cwd); }
  }
  throw new Error("could not push media branch");
}

module.exports = { contentHash, applyChanges, commitQueue, pushSite, git };
