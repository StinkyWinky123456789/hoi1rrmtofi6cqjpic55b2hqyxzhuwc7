// Pull Instagram insights for posted memes (at ~2 days and again at ~7 days) so next week's
// generation can learn which jokes people actually DM to friends.
"use strict";
const path = require("path");
const U = require("./lib/util");
const IG = require("./lib/instagram");
const { commitQueue } = require("./lib/changes");

(async () => {
  const now = Date.now(), changes = [];
  for (const q of U.listQueueFiles()) {
    const rel = path.relative(U.ROOT, q.file).split(path.sep).join("/");
    for (const p of U.readJSON(q.file).posts) {
      if (p.status !== "posted" || !p.igMediaId) continue;
      const age = (now - Date.parse(p.postedAt)) / 864e5;
      const due = age >= 2 && age < 30 && (!p.metrics || (age >= 7 && !p.metrics.final));
      if (!due) continue;
      try {
        const m = await IG.insights(p.page, p.igMediaId);
        if (m) changes.push({ file: rel, id: p.id, patch: { metrics: { ...m, final: age >= 7, at: new Date().toISOString() } } });
      } catch (e) { U.log(`insights ${p.id}: ${e.message}`); }
    }
  }
  U.log(`metrics for ${changes.length} post(s)`);
  if (changes.length) commitQueue(changes, `Metrics for ${changes.length} post(s)`);
})().catch((e) => { console.error(e); process.exit(1); });
