// The clip library: short public-domain clips cut from Internet Archive films.
// Index: library/clips.json on main (the review app stars/bans clips there).
// Files:  site/library/<id>.mp4 and <id>.jpg on the media branch (served by GitHub Pages).
"use strict";
const fs = require("fs");
const path = require("path");
const U = require("./util");

const INDEX = path.join(U.ROOT, "library", "clips.json");
const REL_INDEX = "library/clips.json";

function load() { return U.readJSON(INDEX, { clips: [] }); }
function save(doc) { fs.mkdirSync(path.dirname(INDEX), { recursive: true }); U.writeJSON(INDEX, doc); }
function byId() { return new Map(load().clips.map((c) => [c.id, c])); }
function filePath(clip, kind) { return path.join(U.SITE, kind === "poster" ? clip.poster : clip.file); }

/** Ids of clips that live queue posts still use (so they are never pruned). */
function inUse() {
  const used = new Set();
  for (const q of U.listQueueFiles()) for (const p of U.readJSON(q.file).posts) {
    if (["rejected", "missed"].includes(p.status)) continue;
    if (p.clip) used.add(p.clip); if (p.still) used.add(p.still);
  }
  return used;
}

/** Clips a page can use, best first: starred, then high fit and least used. */
function forPage(page, { stills = false } = {}) {
  return load().clips
    .filter((c) => c.status !== "banned" && (c.pages || []).includes(page) && (!stills || c.stillOk))
    .filter((c) => fs.existsSync(filePath(c, stills ? "poster" : "file")))
    .sort((a, b) => (b.status === "starred") - (a.status === "starred") || (a.uses || 0) - (b.uses || 0) || (b.fit || 0) - (a.fit || 0));
}

/** Count uses for the clips a new week of posts picked. */
function markUsed(ids) {
  if (!ids.length) return;
  const doc = load(), set = new Map();
  ids.forEach((id) => set.set(id, (set.get(id) || 0) + 1));
  for (const c of doc.clips) if (set.has(c.id)) { c.uses = (c.uses || 0) + set.get(c.id); c.lastUsed = new Date().toISOString(); }
  save(doc);
}

/** Drop banned clips and, above the cap, the oldest unstarred ones nothing uses. Deletes their files. */
function prune(maxClips) {
  const doc = load(), used = inUse(), before = doc.clips.length;
  const drop = new Set(doc.clips.filter((c) => c.status === "banned" && !used.has(c.id)).map((c) => c.id));
  let keep = doc.clips.filter((c) => !drop.has(c.id));
  if (keep.length > maxClips) {
    const removable = keep.filter((c) => c.status !== "starred" && !used.has(c.id)).sort((a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt));
    for (const c of removable.slice(0, keep.length - maxClips)) drop.add(c.id);
    keep = keep.filter((c) => !drop.has(c.id));
  }
  for (const c of doc.clips) if (drop.has(c.id)) for (const k of ["file", "poster"]) fs.rmSync(filePath(c, k === "file" ? "file" : "poster"), { force: true });
  doc.clips = keep; save(doc);
  return before - keep.length;
}

module.exports = { INDEX, REL_INDEX, load, save, byId, forPage, markUsed, prune, filePath, inUse };
