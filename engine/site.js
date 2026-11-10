// Prepare the GitHub Pages site (the "media" branch): copy the review app in, and delete media
// that is no longer needed (posted more than 3 days ago, rejected, or orphaned).
// Usage: node engine/site.js
"use strict";
const fs = require("fs");
const path = require("path");
const U = require("./lib/util");

function copy(src, dest) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); }

function main() {
  fs.mkdirSync(U.SITE, { recursive: true });
  // Review app + what it needs to preview edits
  copy(path.join(U.ROOT, "review", "index.html"), path.join(U.SITE, "index.html"));
  copy(path.join(U.ROOT, "shared", "templates.js"), path.join(U.SITE, "templates.js"));
  copy(path.join(U.ROOT, "config", "pages.json"), path.join(U.SITE, "config.json"));
  for (const f of fs.readdirSync(path.join(U.ROOT, "fonts"))) if (/\.(otf|ttf)$/i.test(f)) copy(path.join(U.ROOT, "fonts", f), path.join(U.SITE, "fonts", f));
  fs.writeFileSync(path.join(U.SITE, ".nojekyll"), "");

  // Which media folders are still needed?
  const keep = new Set(), now = Date.now();
  for (const q of U.listQueueFiles()) {
    for (const p of U.readJSON(q.file).posts) {
      const dir = path.posix.join("m", p.page, p.id);
      const postedOld = p.status === "posted" && now - Date.parse(p.postedAt) > 3 * 864e5;
      const rejected = p.status === "rejected" || p.status === "missed";
      if (!postedOld && !rejected) { keep.add(dir); if (p.customClip) keep.add(p.customClip); }
    }
  }
  let removed = 0;
  const mdir = path.join(U.SITE, "m");
  if (fs.existsSync(mdir)) for (const page of fs.readdirSync(mdir)) {
    for (const id of fs.readdirSync(path.join(mdir, page))) {
      if (!keep.has(path.posix.join("m", page, id))) { fs.rmSync(path.join(mdir, page, id), { recursive: true, force: true }); removed++; }
    }
  }
  const udir = path.join(U.SITE, "uploads");
  if (fs.existsSync(udir)) for (const page of fs.readdirSync(udir)) for (const f of fs.readdirSync(path.join(udir, page))) {
    const rel = path.posix.join("uploads", page, f);
    const stamp = Number((f.match(/-(\d{13})\.\w+$/) || [])[1] || now); // uploads are named <post-id>-<epoch ms>.mp4
    const age = now - stamp;
    if (!keep.has(rel) && age > 2 * 864e5) { fs.rmSync(path.join(udir, page, f), { force: true }); removed++; }
  }
  U.log(`Site ready in ${U.SITE}; removed ${removed} old media item(s)`);
}

main();
