// Runs every 20 minutes. For each page: post the next approved, rendered post whose time has come.
// Safety: nothing posts unless status is "approved" AND the approval matches the exact rendered version.
// Set repo variable PUBLISH_ENABLED=true to post for real; otherwise this is a dry run.
"use strict";
const path = require("path");
const U = require("./lib/util");
const IG = require("./lib/instagram");
const { commitQueue } = require("./lib/changes");

const LIVE = process.env.PUBLISH_ENABLED === "true";
const MIN_GAP_MIN = 90;      // never two posts from one page within 90 minutes
const MISS_AFTER_H = 12;     // posts more than 12 hours late are skipped, not dumped all at once
const MAX_ATTEMPTS = 3;

function mediaBase() {
  if (process.env.MEDIA_BASE_URL) return process.env.MEDIA_BASE_URL.replace(/\/$/, "");
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || "/").split("/");
  return `https://${owner.toLowerCase()}.github.io/${repo}`;
}
async function reachable(url) {
  try { const r = await fetch(url, { method: "HEAD" }); return r.ok; } catch { return false; }
}

async function main() {
  const cfg = U.loadConfig(), now = Date.now(), base = mediaBase();
  const all = [];
  for (const q of U.listQueueFiles()) {
    const rel = path.relative(U.ROOT, q.file).split(path.sep).join("/");
    for (const p of U.readJSON(q.file).posts) all.push({ rel, p });
  }
  const changes = [];
  let hardFail = 0;
  for (const key of Object.keys(cfg.pages)) {
    const mine = all.filter((x) => x.p.page === key);
    // Mark long-overdue approved posts as missed
    for (const { rel, p } of mine) {
      if (["approved", "pending"].includes(p.status) && now - Date.parse(p.scheduledAt) > MISS_AFTER_H * 3600e3) {
        changes.push({ file: rel, id: p.id, patch: { status: "missed", lastError: `not ${p.status === "pending" ? "approved" : "posted"} within ${MISS_AFTER_H}h of its slot` } });
        p.status = "missed";
      }
    }
    const lastPosted = Math.max(0, ...mine.filter((x) => x.p.postedAt).map((x) => Date.parse(x.p.postedAt)));
    if (now - lastPosted < MIN_GAP_MIN * 60e3) continue;
    const due = mine.filter(({ p }) => p.status === "approved" && !p.needsRender && p.approvedVersion === p.renderVersion
      && Date.parse(p.scheduledAt) <= now && (p.attempts || 0) < MAX_ATTEMPTS)
      .sort((x, y) => Date.parse(x.p.scheduledAt) - Date.parse(y.p.scheduledAt));
    if (!due.length) continue;
    const { rel, p } = due[0];
    const urls = (p.format === "reel" ? p.media.filter((m) => /\.mp4$/.test(m)).concat(p.media.filter((m) => /cover\.jpg$/.test(m))) : p.media).map((m) => `${base}/${m}`);
    if (!urls.length) { U.log(`${p.id}: no media`); continue; }
    if (!(await reachable(urls[0]))) { U.log(`${p.id}: media not live yet at ${urls[0]} (Pages still deploying?); will retry`); continue; }
    if (!LIVE) { U.log(`[dry run] would post ${p.id} (${p.format}) to ${cfg.pages[key].handle}: ${urls[0]}`); continue; }
    try {
      U.log(`posting ${p.id} (${p.format}) to ${cfg.pages[key].handle}`);
      const res = await IG.publish(key, p, urls);
      changes.push({ file: rel, id: p.id, patch: { status: "posted", postedAt: new Date().toISOString(), igMediaId: res.id, permalink: res.permalink, lastError: null } });
      U.log(`posted ${p.id}: ${res.permalink || res.id}`);
    } catch (e) {
      const attempts = (p.attempts || 0) + 1, failed = attempts >= MAX_ATTEMPTS;
      if (failed) hardFail++;
      changes.push({ file: rel, id: p.id, patch: { attempts, lastError: e.message.slice(0, 300), ...(failed ? { status: "failed" } : {}) } });
      U.log(`${p.id} failed (attempt ${attempts}): ${e.message}`);
    }
  }
  if (changes.length) commitQueue(changes, `Publisher: ${changes.length} update(s)`);
  if (hardFail) { console.error(`${hardFail} post(s) failed ${MAX_ATTEMPTS} times; see lastError in the review app`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
