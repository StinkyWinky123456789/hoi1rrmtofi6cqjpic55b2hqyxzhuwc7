// End-to-end test with local stand-ins for Claude, Instagram, GitHub and Pages.
// Runs on a throwaway copy of the repo. Usage: node test/run-tests.js [--quick]
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");
const assert = require("assert");
const mock = require("./mock-servers");

const SRC = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meme-engine-test-"));
const QUICK = process.argv.includes("--quick");
let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; console.log("  ✓ " + msg); }
function run(script, env, args = []) {
  // Async on purpose: the mock servers live in this process and must keep answering while the script runs.
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const c = spawn("node", [path.join(TMP, script), ...args], { cwd: TMP, env: { ...process.env, ...env } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => c.kill("SIGKILL"), 15 * 60e3);
    c.on("close", (code) => { clearTimeout(t); if (code !== 0) { console.log(out); reject(new Error(`${script} exited ${code}`)); } else resolve(out); });
  });
}
const readQ = (page) => JSON.parse(fs.readFileSync(path.join(TMP, "queue", "2026-W47", `${page}.json`), "utf8"));
const writeQ = (page, doc) => fs.writeFileSync(path.join(TMP, "queue", "2026-W47", `${page}.json`), JSON.stringify(doc, null, 2));

(async () => {
  execFileSync("bash", ["-c", `cd "${SRC}" && tar --exclude=node_modules --exclude=site --exclude=.git -cf - . | (cd "${TMP}" && tar -xf -)`]);
  fs.rmSync(path.join(TMP, "queue"), { recursive: true, force: true }); fs.mkdirSync(path.join(TMP, "queue"));
  const SITE = path.join(TMP, "site"); fs.mkdirSync(SITE);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=12", "-c:a", "libmp3lame", path.join(TMP, "assets/audio/funny/test-tone.mp3")]);
  const { server, port, log } = await mock.start({ siteDir: SITE, ghRoot: TMP });
  const base = `http://127.0.0.1:${port}`;
  const ENV = {
    NO_GIT: "1", SITE_DIR: SITE, ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: base,
    NODE_PATH: "/opt/npm-tools/node_modules", CHROME_PATH: "/usr/bin/google-chrome",
    IG_API_BASE: base, MEDIA_BASE_URL: `${base}/site`, PUBLISH_ENABLED: "true",
    ...Object.fromEntries(["GYM", "ANIME", "MONEY", "SHITPOST"].flatMap((k, i) => [[`IG_USER_ID_${k}`, `17841400000${i}`], [`IG_TOKEN_${k}`, `tok_${k}`]])),
  };

  try {
    console.log("1. Time zones");
    const U = require(path.join(TMP, "engine/lib/util"));
    ok(U.zonedToUtc("2026-11-16", "06:30", "America/New_York").toISOString() === "2026-11-16T11:30:00.000Z", "6:30 AM Eastern in November = 11:30 UTC");
    ok(U.zonedToUtc("2027-03-15", "06:30", "America/New_York").toISOString() === "2027-03-15T10:30:00.000Z", "6:30 AM Eastern after DST starts = 10:30 UTC");
    ok(U.nextMonday(new Date("2026-11-14T15:15:00Z"), "America/New_York") === "2026-11-16", "Saturday run targets the coming Monday");
    ok(U.isoWeekId("2026-11-16") === "2026-W47", "week id");

    console.log("2. Generate (Claude stand-in; real trend sources are offline here)");
    const out = await run("engine/generate.js", ENV, ["2026-11-16"]);
    for (const page of ["gym", "anime", "money", "shitpost"]) {
      const q = readQ(page), c = (f) => q.posts.filter((p) => p.format === f).length;
      ok(q.posts.length === 35 && c("reel") === 7 && c("carousel") === 4 && c("image") === 24, `${page}: 35 posts (7 Reels, 4 carousels, 24 images)`);
    }
    const gym = readQ("gym");
    ok(gym.posts.every((p) => p.status === "pending" && p.needsRender && p.approvedVersion === null), "everything starts as pending review");
    ok(gym.posts.every((p) => (p.caption.match(/#/g) || []).length <= 5), "captions carry at most 5 hashtags");
    ok(new Set(gym.posts.map((p) => p.id)).size === 35, "post ids are unique");
    ok(/Claude wrote/.test(out) && log.claude >= 12, `Claude called ${log.claude} times (write + judge per page)`);
    const pick = (p) => p.posts.slice().sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    ok(pick(gym)[0].scheduledAt === "2026-11-16T11:30:00.000Z", "first gym slot is Mon 6:30 AM Eastern");

    console.log("3. Render images, carousels and Reels");
    if (QUICK) for (const page of ["anime", "shitpost"]) { const q = readQ(page); q.posts.forEach((p) => (p.needsRender = false)); writeQ(page, q); }
    // Use an uploaded clip for one gym Reel
    const firstReel = gym.posts.find((p) => p.format === "reel");
    const clipRel = `uploads/gym/${firstReel.id}-${Date.now()}.mp4`;
    fs.mkdirSync(path.join(SITE, "uploads/gym"), { recursive: true });
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30:duration=4", "-pix_fmt", "yuv420p", path.join(SITE, clipRel)]);
    firstReel.customClip = clipRel; writeQ("gym", gym);
    const t0 = Date.now();
    await run("engine/render.js", ENV);
    console.log(`   (render took ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    for (const page of QUICK ? ["gym", "money"] : ["gym", "anime", "money", "shitpost"]) {
      const q = readQ(page);
      ok(q.posts.every((p) => !p.needsRender && p.renderVersion === 1 && p.media.length && p.media.every((m) => fs.existsSync(path.join(SITE, m)))), `${page}: every post rendered with files on disk`);
    }
    const g2 = readQ("gym");
    const reel = g2.posts.find((p) => p.id === firstReel.id), car = g2.posts.find((p) => p.format === "carousel");
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path.join(SITE, reel.media[0])]).toString());
    const v = probe.streams.find((s) => s.codec_type === "video"), a = probe.streams.find((s) => s.codec_type === "audio");
    ok(v.width === 1080 && v.height === 1920 && v.codec_name === "h264" && v.pix_fmt === "yuv420p", "Reel is 1080x1920 H.264");
    ok(a && a.codec_name === "aac" && Math.abs(+probe.format.duration - 9) < 0.3, `Reel has AAC audio and runs ${(+probe.format.duration).toFixed(1)}s`);
    ok(/your uploaded clip/.test(reel.renderNote) && reel.media.some((m) => m.endsWith("cover.jpg")), "custom clip used; cover frame made");
    ok(car.media.length === 6 && car.media.every((m) => m.endsWith(".jpg")), "carousel rendered to 6 JPEG slides (title + 4 + follow)");
    ok(g2.posts.filter((p) => p.format === "image").every((p) => p.media[0].endsWith(".jpg")), "images are JPEG (Instagram requires JPEG)");

    console.log("4. Publisher (Instagram stand-in)");
    const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
    for (const page of ["gym", "money"]) {
      const q = readQ(page), r = q.posts.find((p) => p.format === "reel"), c = q.posts.find((p) => p.format === "carousel"), im = q.posts.find((p) => p.format === "image");
      for (const [p, mins] of [[r, 30], [c, 20], [im, 10]]) Object.assign(p, { status: "approved", approvedVersion: p.renderVersion, scheduledAt: iso(now - mins * 60e3) });
      const unapproved = q.posts.find((p) => p.status === "pending"); unapproved.scheduledAt = iso(now - 13 * 3600e3);
      const notLocked = q.posts.filter((p) => p.status === "pending")[1]; Object.assign(notLocked, { status: "approved", approvedVersion: 99, scheduledAt: iso(now - 5 * 60e3) });
      q.posts.find((p) => p.status === "pending" && p.format === "image" && p !== unapproved).scheduledAt = iso(now - 60e3);
      writeQ(page, q);
    }
    let pout = await run("engine/publish.js", ENV);
    const gp = readQ("gym"), mp = readQ("money");
    ok(gp.posts.filter((p) => p.status === "posted").length === 1 && mp.posts.filter((p) => p.status === "posted").length === 1, "one post per page per run");
    ok(gp.posts.find((p) => p.status === "posted").format === "reel", "earliest due post (the Reel) went first");
    ok(gp.posts.some((p) => p.status === "missed"), "a post left unapproved 13h past its slot is marked missed, not posted");
    ok(gp.posts.every((p) => !(p.approvedVersion === 99 && p.status === "posted")), "approval for a different render version never posts");
    ok(gp.posts.every((p) => !(p.status === "posted" && p.approvedVersion !== p.renderVersion)), "only exactly-approved renders were posted");
    const reelCall = log.ig.find((c) => c.params.media_type === "REELS");
    ok(reelCall && /\.mp4$/.test(reelCall.params.video_url) && /cover\.jpg$/.test(reelCall.params.cover_url) && reelCall.params.share_to_feed === "true", "Reel posted with video_url, cover_url, share_to_feed");
    await run("engine/publish.js", ENV);
    ok(readQ("gym").posts.filter((p) => p.status === "posted").length === 1, "90-minute spacing: no second gym post on the next run");
    // Move the first post back 2h so the carousel can go
    const g3 = readQ("gym"); g3.posts.find((p) => p.status === "posted").postedAt = iso(now - 2 * 3600e3); writeQ("gym", g3);
    await run("engine/publish.js", ENV);
    const carCalls = log.ig.filter((c) => c.params.is_carousel_item === "true").length, carParent = log.ig.find((c) => c.params.media_type === "CAROUSEL");
    ok(carCalls >= 6 && carParent && carParent.params.children.split(",").length === 6, "carousel posted as 6 child items + parent");
    const mq = readQ("money"); mq.posts.forEach((p) => { if (p.postedAt) p.postedAt = iso(now - 3 * 3600e3); }); writeQ("money", mq);
    const igBefore = log.ig.length, postedBefore = readQ("money").posts.filter((p) => p.status === "posted").length;
    const dry = await run("engine/publish.js", { ...ENV, PUBLISH_ENABLED: "false" });
    ok(/\[dry run\] would post money-/.test(dry) && log.ig.length === igBefore && readQ("money").posts.filter((p) => p.status === "posted").length === postedBefore, "dry-run mode (the default) logs what it would post and posts nothing");

    console.log("5. Insights loop");
    for (const page of ["gym", "money"]) { const q = readQ(page); q.posts.filter((p) => p.status === "posted").forEach((p) => (p.postedAt = iso(now - 3 * 864e5))); writeQ(page, q); }
    await run("engine/metrics.js", ENV);
    const withM = readQ("gym").posts.filter((p) => p.metrics);
    ok(withM.length >= 1 && withM[0].metrics.reach === 1000 && withM[0].metrics.shares === 42, "reach and shares saved on posted memes");

    console.log("6. Conflict safety");
    const { applyChanges, contentHash } = require(path.join(TMP, "engine/lib/changes"));
    const q6 = readQ("money"), p6 = q6.posts.find((p) => p.status === "pending"); const h = contentHash(p6);
    p6.a = "Edited in review meanwhile"; writeQ("money", q6);
    const applied = applyChanges([{ file: "queue/2026-W47/money.json", id: p6.id, expectHash: h, patch: { needsRender: false, renderVersion: 7 } }]);
    ok(applied === 0 && readQ("money").posts.find((p) => p.id === p6.id).renderVersion !== 7, "a stale render never overwrites a newer edit");

    console.log("7. Review app (in Chrome, against the GitHub stand-in)");
    await run("engine/site.js", ENV);
    const { chromium } = require("/opt/npm-tools/node_modules/playwright-core");
    const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
    const pg = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errs = []; pg.on("pageerror", (e) => errs.push(e.message));
    await pg.goto(`${base}/site/index.html`);
    await pg.evaluate((api) => { localStorage.setItem("mq-api", api); localStorage.setItem("mq-repo", "joshua/meme-engine"); localStorage.setItem("mq-token", "test"); localStorage.setItem("mq-page", "gym"); }, base);
    await pg.reload(); await pg.waitForSelector(".card", { timeout: 20000 }); await pg.waitForTimeout(800);
    await pg.screenshot({ path: path.join(SRC, "test", "review-screenshot.png") });
    await pg.click("text=Videos to review"); await pg.waitForTimeout(500);
    const vids = await pg.$$eval(".card video", (vs) => vs.map((v) => v.getAttribute("src")));
    ok(vids.length >= 5 && vids.every((s) => /\.mp4$/.test(s)), `Videos filter shows ${vids.length} playable Reel MP4s`);
    const playable = await pg.$eval(".card video", (v) => new Promise((res) => { v.muted = true; v.oncanplay = () => res(v.videoWidth + "x" + v.videoHeight); v.onerror = () => res("error"); v.load(); setTimeout(() => res("timeout"), 8000); }));
    ok(playable === "1080x1920", `video actually loads and plays in the browser (${playable})`);
    await pg.screenshot({ path: path.join(SRC, "test", "review-videos.png") });
    const before = log.ghPuts.length;
    await pg.click(".card.focus >> text=Approve video"); await pg.waitForTimeout(3500);
    ok(log.ghPuts.length > before, "approving a video saves to GitHub");
    const savedDoc = readQ("gym"), approvedReel = savedDoc.posts.find((p) => p.format === "reel" && p.status === "approved" && p.approvedVersion === p.renderVersion);
    ok(!!approvedReel, "saved approval is locked to the rendered version");
    await pg.click(".card.focus >> text=Swap footage"); await pg.waitForTimeout(3500);
    const swapped = readQ("gym").posts.find((p) => p.format === "reel" && p.needsRender && p.footageIndex === 1);
    ok(!!swapped && swapped.status === "pending" && swapped.approvedVersion === null, "Swap footage queues a re-render and requires re-approval");
    await pg.click("text=Needs review"); await pg.waitForTimeout(300);
    await pg.click(".card.focus >> text=Edit text");
    await pg.fill(".card.focus .edit input", "When the edit lands");
    await pg.click(".card.focus >> text=Save and re-render"); await pg.waitForTimeout(3500);
    ok(readQ("gym").posts.some((p) => p.a === "When the edit lands" && p.needsRender), "text edits save and queue a re-render");
    await pg.screenshot({ path: path.join(SRC, "test", "review-edit.png") });
    ok(errs.length === 0, "no page errors" + (errs.length ? ": " + errs.join("; ") : ""));
    await browser.close();

    console.log(`\nAll ${passed} checks passed.`);
  } finally { server.close(); if (!process.argv.includes("--keep")) fs.rmSync(TMP, { recursive: true, force: true }); else console.log("kept", TMP); }
})().catch((e) => { console.error("\nTEST FAILED:", e.message); process.exit(1); });
