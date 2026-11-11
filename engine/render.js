// Render every queued post that needs it: JPEG images, carousel slides, and finished Reel MP4s.
// Output goes to the media site folder (SITE_DIR, default ./site), which is published by GitHub Pages.
// Usage: node engine/render.js
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const U = require("./lib/util");
const { contentHash, applyChanges, commitQueue, pushSite } = require("./lib/changes");

const REEL_SECONDS = 9;

function chromePath() {
  const c = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean);
  return c.find((p) => fs.existsSync(p));
}

/* ---------- Footage: Pixabay (preferred) or Pexels. Both free, no attribution required. ---------- */
async function pixabayClips(query) {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return [];
  const cacheFile = path.join(U.ROOT, "state", "pixabay-cache.json"), cache = U.readJSON(cacheFile, {});
  if (cache[query] && Date.now() - cache[query].t < 864e5) return cache[query].clips; // Pixabay asks for caching up to 24h
  const words = String(query).split(/\s+/).filter(Boolean);
  let clips = [];
  // Try the full phrase, then shorter versions if nothing comes back
  for (const q of [words.join(" "), words.slice(0, 2).join(" "), words[0]].filter((v, i, a) => v && a.indexOf(v) === i)) {
    const params = new URLSearchParams({ key, q, per_page: "20", safesearch: "true", order: "popular" });
    const r = await fetch(`https://pixabay.com/api/videos/?${params}`);
    if (!r.ok) { U.log(`Pixabay ${r.status} for "${q}"`); break; }
    const j = await r.json();
    clips = (j.hits || []).map((h) => {
      const v = h.videos || {};
      const pick = [v.large, v.medium, v.small].find((f) => f && f.url && f.height >= 720 && f.height <= 2160) || v.medium || v.small;
      return pick && pick.url ? { id: `pb${h.id}`, url: pick.url, duration: h.duration, page: h.pageURL, portrait: pick.height > pick.width } : null;
    }).filter(Boolean);
    clips.sort((a, b) => Number(b.portrait) - Number(a.portrait)); // vertical clips first; others get center-cropped to 9:16
    if (clips.length) break;
  }
  cache[query] = { t: Date.now(), clips }; U.writeJSON(cacheFile, cache);
  return clips;
}

async function pexelsClips(query) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return [];
  const cacheFile = path.join(U.ROOT, "state", "pexels-cache.json"), cache = U.readJSON(cacheFile, {});
  if (cache[query] && Date.now() - cache[query].t < 14 * 864e5) return cache[query].clips;
  const q = new URLSearchParams({ query, orientation: "portrait", size: "medium", per_page: "15" });
  const r = await fetch(`https://api.pexels.com/videos/search?${q}`, { headers: { Authorization: key } });
  if (!r.ok) { U.log(`Pexels ${r.status} for "${query}"`); return []; }
  const j = await r.json();
  const clips = (j.videos || []).map((v) => {
    const files = (v.video_files || []).filter((f) => f.file_type === "video/mp4" && f.height > f.width && f.height >= 960 && f.height <= 2160);
    files.sort((a, b) => Math.abs(a.height - 1920) - Math.abs(b.height - 1920));
    return files[0] ? { id: v.id, url: files[0].link, duration: v.duration, page: v.url } : null;
  }).filter(Boolean);
  cache[query] = { t: Date.now(), clips }; U.writeJSON(cacheFile, cache);
  return clips;
}
async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 10000) return dest;
  const r = await fetch(url); if (!r.ok) throw new Error(`download ${r.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}

/* ---------- Audio: royalty-free tracks you add to assets/audio/<mood>/ or assets/audio/ ---------- */
function audioTracks(mood) {
  const base = path.join(U.ROOT, "assets", "audio"), list = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /\.(mp3|m4a|wav|aac)$/i.test(f)).sort().map((f) => path.join(d, f)) : []);
  const byMood = list(path.join(base, mood || "")), all = list(base);
  return byMood.length ? byMood : all;
}

function ffmpegReel({ footage, bgColor, overlay, audio, out }) {
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  if (footage) args.push("-stream_loop", "-1", "-i", footage);
  else args.push("-f", "lavfi", "-i", `color=c=${bgColor.replace("#", "0x")}:s=1080x1920:r=30`);
  args.push("-loop", "1", "-i", overlay);
  if (audio) args.push("-stream_loop", "-1", "-i", audio);
  else args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  const bg = footage
    ? "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,eq=brightness=-0.07:saturation=0.92[bg]"
    : "[0:v]setsar=1[bg]";
  const filter = `${bg};[bg][1:v]overlay=0:0:format=auto,format=yuv420p[v];[2:a]afade=t=out:st=${REEL_SECONDS - 0.7}:d=0.7,aresample=44100[a]`;
  args.push("-filter_complex", filter, "-map", "[v]", "-map", "[a]", "-t", String(REEL_SECONDS),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", "8M", "-bufsize", "16M", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", out);
  execFileSync("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
}

async function renderReel(post, page, overlayFile, outDir, ver) {
  let footage = null, note = "";
  if (post.customClip) {
    footage = path.join(U.SITE, post.customClip);
    if (!fs.existsSync(footage)) { footage = null; note = "your uploaded clip was not found; used a plain background"; }
    else note = "your uploaded clip";
  } else {
    try {
      const q = post.footage || page.niche;
      let clips = await pixabayClips(q);
      if (!clips.length) clips = await pexelsClips(q);
      if (clips.length) {
        const c = clips[(post.footageIndex || 0) % clips.length];
        footage = await download(c.url, path.join(os.tmpdir(), "meme-footage", `${c.id}.mp4`));
        note = `${String(c.id).startsWith("pb") ? "Pixabay" : "Pexels"} clip ${c.id} (${(post.footageIndex || 0) % clips.length + 1} of ${clips.length} for "${post.footage}")`;
        post.footageSource = c.page;
      } else note = process.env.PIXABAY_API_KEY || process.env.PEXELS_API_KEY ? `no stock clips for "${post.footage}"; plain background` : "no PIXABAY_API_KEY; plain background";
    } catch (e) { note = `footage error (${e.message}); plain background`; }
  }
  const tracks = audioTracks(post.mood), audio = tracks.length ? tracks[(post.audioIndex || 0) % tracks.length] : null;
  const out = path.join(outDir, `v${ver}.mp4`);
  ffmpegReel({ footage, bgColor: page.bg, overlay: overlayFile, audio, out });
  const cover = path.join(outDir, `v${ver}-cover.jpg`);
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", "1.5", "-i", out, "-frames:v", "1", "-q:v", "3", cover]);
  post.renderNote = `${note}; audio: ${audio ? path.basename(audio) : "silent (add tracks to assets/audio)"}`;
  return [out, cover];
}

/** Render everything that needs it. Writes media into SITE and returns queue patches. */
async function renderPending() {
  const cfg = U.loadConfig();
  const jobs = [];
  for (const q of U.listQueueFiles()) {
    const doc = U.readJSON(q.file);
    const todo = doc.posts.filter((p) => p.needsRender && !["rejected", "posted", "missed"].includes(p.status));
    if (todo.length) jobs.push({ q, todo });
  }
  const total = jobs.reduce((t, j) => t + j.todo.length, 0);
  if (!total) { U.log("Nothing to render"); return []; }
  U.log(`Rendering ${total} posts`);

  const { chromium } = require("playwright-core");
  const exe = chromePath();
  if (!exe) throw new Error("Chrome not found; set CHROME_PATH");
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox", "--allow-file-access-from-files"] });
  const tab = await browser.newPage();
  await tab.goto("file://" + path.join(U.ROOT, "engine", "render.html"));
  const fontCheck = await tab.evaluate(() => window.fontsReady);
  const missing = fontCheck.filter(([, ok]) => !ok).map(([f]) => f);
  if (missing.length) U.log("Fonts missing (fallbacks used):", missing.join(", "));

  const changes = [];
  let done = 0, failed = 0;
  for (const { q, todo } of jobs) {
    const page = cfg.pages[q.page], relFile = path.relative(U.ROOT, q.file).split(path.sep).join("/");
    for (const post of todo) {
      const ver = (post.renderVersion || 0) + 1, expectHash = contentHash(post);
      const rel = path.posix.join("m", q.page, post.id);
      const outDir = path.join(U.SITE, rel);
      try {
        fs.mkdirSync(outDir, { recursive: true });
        const frames = await tab.evaluate(([pg, p]) => window.renderPost(pg, p), [page, post]);
        const files = [];
        for (const f of frames) {
          const ext = f.mime === "image/png" ? "png" : "jpg";
          const file = path.join(outDir, `v${ver}-${f.name}.${ext}`);
          fs.writeFileSync(file, Buffer.from(f.dataUrl.split(",")[1], "base64"));
          files.push(file);
        }
        let media = files;
        if (post.format === "reel") { media = await renderReel(post, page, files[0], outDir, ver); fs.rmSync(files[0], { force: true }); }
        for (const f of fs.readdirSync(outDir)) if (!f.startsWith(`v${ver}`)) fs.rmSync(path.join(outDir, f), { force: true });
        const patch = {
          media: media.map((f) => path.posix.join(rel, path.basename(f))), renderVersion: ver, needsRender: false,
          renderedAt: new Date().toISOString(), renderError: null, renderNote: post.renderNote || null, footageSource: post.footageSource || null,
        };
        if (post.status === "approved" && post.approvedVersion !== ver) patch.status = "pending"; // approval is tied to the exact render
        changes.push({ file: relFile, id: post.id, expectHash, patch });
        done++;
      } catch (e) {
        failed++; U.log(`render failed ${post.id}: ${e.message}`);
        changes.push({ file: relFile, id: post.id, expectHash, patch: { renderError: e.message.slice(0, 300) } });
      }
    }
  }
  await browser.close();
  applyChanges(changes);
  U.log(`Rendered ${done}, failed ${failed}`);
  return changes;
}

async function main() {
  const changes = await renderPending();
  if (process.argv.includes("--commit") && changes.length) {
    pushSite(`Render ${changes.length} post(s)`);
    commitQueue(changes, `Rendered ${changes.length} post(s)`, ["state"]);
  }
}

module.exports = { ffmpegReel, renderPending, pixabayClips };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
