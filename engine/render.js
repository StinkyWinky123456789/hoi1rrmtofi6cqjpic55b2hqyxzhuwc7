// Render every queued post that needs it: JPEG images, carousel slides, and finished Reel MP4s.
// Output goes to the media site folder (SITE_DIR, default ./site), which is published by GitHub Pages.
// Usage: node engine/render.js
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const U = require("./lib/util");
const Memes = require("./lib/memes");
const { contentHash, applyChanges, commitQueue, pushSite } = require("./lib/changes");

const REEL_SECONDS = 9;

function chromePath() {
  const c = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean);
  return c.find((p) => fs.existsSync(p));
}

/* ---------- Footage: Pixabay (preferred) or Pexels. Both free, no attribution required. ---------- */
/** fetch with retries for flaky connections (resets, timeouts, 5xx). */
async function fetchRetry(url, opts) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { const r = await fetch(url, opts); if (r.status >= 500) throw new Error(`HTTP ${r.status}`); return r; }
    catch (e) { lastErr = e; await U.sleep(1000 * attempt); }
  }
  throw lastErr;
}
const PIXABAY = (process.env.PIXABAY_BASE || "https://pixabay.com/api").replace(/\/$/, "");
const IMAGE_TEMPLATES = ["classic", "pov", "nobody", "tweet", "system"];

/** Search Pixabay photos, trying shorter versions of the phrase if nothing matches. Cached 24h. */
async function pixabayImages(query) {
  const key = U.secret("PIXABAY_API_KEY");
  if (!key || !query) return [];
  const cacheFile = path.join(U.ROOT, "state", "pixabay-img-cache.json"), cache = U.readJSON(cacheFile, {});
  if (cache[query] && Date.now() - cache[query].t < 864e5) return cache[query].imgs;
  const words = String(query).split(/\s+/).filter(Boolean);
  let imgs = [];
  for (const q of [words.join(" "), words.slice(0, 3).join(" "), words.slice(0, 2).join(" ")].filter((v, i, a) => v && a.indexOf(v) === i)) {
    const params = new URLSearchParams({ key, q, image_type: "photo", safesearch: "true", per_page: "20", order: "popular" });
    const r = await fetchRetry(`${PIXABAY}/?${params}`);
    if (!r.ok) { U.log(`Pixabay images ${r.status} for "${q}"`); break; }
    const j = await r.json();
    imgs = (j.hits || []).map((h) => ({ id: `pbi${h.id}`, url: h.largeImageURL || h.webformatURL, page: h.pageURL })).filter((x) => x.url);
    if (imgs.length) break;
  }
  cache[query] = { t: Date.now(), imgs }; U.writeJSON(cacheFile, cache);
  return imgs;
}

/** Photos for a post as data: URLs. Images get 1 (versus 2: one per panel), carousels one per slide. */
async function photosFor(post) {
  if (post.format === "image" && post.template === "meme") {
    try { return { urls: [await Memes.render(post.mt, post.ml || [])], note: `meme template "${post.mt}"`, source: Memes.imageUrl(post.mt, post.ml || []) }; }
    catch (e) { return { urls: [], note: `meme template error (${e.message})` }; }
  }
  if (!["image", "carousel"].includes(post.format) || !post.visual) return { urls: [], note: "" };
  const want = post.format === "carousel" ? MemeTemplates_slideCount(post) : 1;
  const out = [], notes = [], sources = [];
  const searches = [[post.visual, want]];
  if (post.format === "image" && post.template === "versus") searches.push([post.visual2 || post.visual, 1]);
  try {
    for (const [query, count] of searches) {
      const imgs = await pixabayImages(query);
      if (!imgs.length) { notes.push(U.secret("PIXABAY_API_KEY") ? `no photo found for "${query}"` : "no PIXABAY_API_KEY"); continue; }
      // the second versus panel starts one photo later so the two panels differ when they share a search
      const offset = (post.imageIndex || 0) + (out.length && query === post.visual ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const k = (offset + i) % imgs.length, im = imgs[k];
        const file = await download(im.url, path.join(os.tmpdir(), "meme-photos", `${im.id}${path.extname(new URL(im.url).pathname) || ".jpg"}`));
        const ext = path.extname(file).toLowerCase(), mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
        out.push(`data:${mime};base64,${fs.readFileSync(file).toString("base64")}`);
        sources.push(im.page);
      }
      notes.push(`photo ${(offset % imgs.length) + 1} of ${imgs.length} for "${query}"`);
    }
  } catch (e) { notes.push(`photo error (${e.message})`); }
  return { urls: out, note: notes.join("; "), source: sources[0] || null };
}
function MemeTemplates_slideCount(post) { return 1 + (post.s || []).filter((x) => String(x).trim()).length + 1; }

async function pixabayClips(query) {
  const key = U.secret("PIXABAY_API_KEY");
  if (!key) return [];
  const cacheFile = path.join(U.ROOT, "state", "pixabay-cache.json"), cache = U.readJSON(cacheFile, {});
  if (cache[query] && Date.now() - cache[query].t < 864e5) return cache[query].clips; // Pixabay asks for caching up to 24h
  const words = String(query).split(/\s+/).filter(Boolean);
  let clips = [];
  // Try the full phrase, then shorter versions if nothing comes back
  for (const q of [words.join(" "), words.slice(0, 2).join(" "), words[0]].filter((v, i, a) => v && a.indexOf(v) === i)) {
    const params = new URLSearchParams({ key, q, per_page: "20", safesearch: "true", order: "popular" });
    const r = await fetchRetry(`${PIXABAY}/videos/?${params}`);
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
  const key = U.secret("PEXELS_API_KEY");
  if (!key) return [];
  const cacheFile = path.join(U.ROOT, "state", "pexels-cache.json"), cache = U.readJSON(cacheFile, {});
  if (cache[query] && Date.now() - cache[query].t < 14 * 864e5) return cache[query].clips;
  const q = new URLSearchParams({ query, orientation: "portrait", size: "medium", per_page: "15" });
  const r = await fetchRetry(`https://api.pexels.com/videos/search?${q}`, { headers: { Authorization: key } });
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
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetchRetry(url); if (!r.ok) throw new Error(`download ${r.status}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
      return dest;
    } catch (e) { lastErr = e; await U.sleep(1500 * attempt); }
  }
  throw lastErr;
}

/* ---------- Audio: royalty-free tracks you add to assets/audio/<mood>/ or assets/audio/ ---------- */
function audioTracks(mood) {
  const base = path.join(U.ROOT, "assets", "audio"), list = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /\.(mp3|m4a|wav|aac)$/i.test(f)).sort().map((f) => path.join(d, f)) : []);
  const byMood = list(path.join(base, mood || "")), all = list(base);
  return byMood.length ? byMood : all;
}

/** When the punchline lands: later for longer setups (seconds). */
function punchTime(post) { const words = String(post.a || "").split(/\s+/).filter(Boolean).length; return Math.max(2.0, Math.min(3.8, 1.4 + words * 0.17)); }

/**
 * Build the Reel: footage (or a plain background), setup text the whole time, punchline from P seconds
 * with a zoom punch and a quick flash, music ducked under an optional sound effect that hits on the punchline.
 */
function ffmpegReel({ footage, bgColor, overlayA, overlayB, audio, sfx, punch, out }) {
  const P = punch || 2.6, dur = REEL_SECONDS;
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  let n = 0;
  if (footage) args.push("-stream_loop", "-1", "-i", footage); else args.push("-f", "lavfi", "-i", `color=c=${bgColor.replace("#", "0x")}:s=1080x1920:r=30`);
  const vIdx = n++;
  args.push("-loop", "1", "-i", overlayA); const aIdx = n++;
  let bIdx = null; if (overlayB) { args.push("-loop", "1", "-i", overlayB); bIdx = n++; }
  if (audio) args.push("-stream_loop", "-1", "-i", audio); else args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  const mIdx = n++;
  let sIdx = null; if (sfx && overlayB) { args.push("-i", sfx); sIdx = n++; }
  const f = [];
  f.push(`[${vIdx}:v]` + (footage ? "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,eq=brightness=-0.07:saturation=0.95" : "setsar=1,fps=30") + "[bg]");
  if (overlayB) f.push(`[bg]zoompan=z='if(gte(it,${P}),1.10,1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30[z]`);
  else f.push("[bg]null[z]");
  f.push(`[z][${aIdx}:v]overlay=0:0:format=auto[v1]`);
  if (overlayB) {
    f.push(`[v1][${bIdx}:v]overlay=0:0:format=auto:enable='gte(t,${P})'[v2]`);
    f.push(`[v2]drawbox=x=0:y=0:w=iw:h=ih:color=white@0.28:t=fill:enable='between(t,${P},${(P + 0.07).toFixed(2)})',format=yuv420p[v]`);
  } else f.push("[v1]format=yuv420p[v]");
  const musicVol = sIdx !== null ? 0.6 : 0.9;
  f.push(`[${mIdx}:a]aresample=44100,volume=${musicVol},afade=t=out:st=${dur - 0.7}:d=0.7[m]`);
  if (sIdx !== null) {
    const ms = Math.round(P * 1000);
    f.push(`[${sIdx}:a]aresample=44100,volume=1.4,adelay=${ms}|${ms},apad[s]`);
    f.push(`[m][s]amix=inputs=2:normalize=0:duration=first[a]`);
  } else f.push("[m]anull[a]");
  args.push("-filter_complex", f.join(";"), "-map", "[v]", "-map", "[a]", "-t", String(dur),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", "8M", "-bufsize", "16M", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", out);
  execFileSync("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
}

/* ---------- Sound effects: Freesound, CC0 only (no attribution needed) ---------- */
const FREESOUND = (process.env.FREESOUND_BASE || "https://freesound.org/apiv2").replace(/\/$/, "");
async function soundEffect(query, index) {
  const key = U.secret("FREESOUND_API_KEY");
  if (!key || !query) return { file: null, note: key ? "" : "no FREESOUND_API_KEY" };
  const cacheFile = path.join(U.ROOT, "state", "freesound-cache.json"), cache = U.readJSON(cacheFile, {});
  let hits = cache[query] && Date.now() - cache[query].t < 7 * 864e5 ? cache[query].hits : null;
  if (!hits) {
    const params = new URLSearchParams({ query, filter: 'license:"Creative Commons 0" duration:[0.2 TO 4]', fields: "id,name,previews,duration", sort: "rating_desc", page_size: "15", token: key });
    const r = await fetchRetry(`${FREESOUND}/search/text/?${params}`);
    if (!r.ok) return { file: null, note: `Freesound ${r.status}` };
    const j = await r.json();
    hits = (j.results || []).map((x) => ({ id: x.id, name: x.name, url: x.previews && (x.previews["preview-hq-mp3"] || x.previews["preview-lq-mp3"]) })).filter((x) => x.url);
    cache[query] = { t: Date.now(), hits }; U.writeJSON(cacheFile, cache);
  }
  if (!hits.length) return { file: null, note: `no CC0 sound for "${query}"` };
  const h = hits[(index || 0) % hits.length];
  const file = await download(h.url, path.join(os.tmpdir(), "meme-sfx", `${h.id}.mp3`));
  return { file, note: `sfx "${h.name}" (Freesound ${h.id}, CC0)` };
}

async function renderReel(post, page, overlays, outDir, ver) {
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
  let sfx = { file: null, note: "" };
  if (post.sfx && overlays[1]) { try { sfx = await soundEffect(post.sfx, post.sfxIndex || 0); } catch (e) { sfx = { file: null, note: `sfx error (${e.message})` }; } }
  const out = path.join(outDir, `v${ver}.mp4`);
  ffmpegReel({ footage, bgColor: page.bg, overlayA: overlays[0], overlayB: overlays[1] || null, audio, sfx: sfx.file, punch: punchTime(post), out });
  const cover = path.join(outDir, `v${ver}-cover.jpg`);
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", "1.5", "-i", out, "-frames:v", "1", "-q:v", "3", cover]);
  post.renderNote = `${note}; music: ${audio ? path.basename(audio) : "none (add tracks to assets/audio)"}${sfx.note ? "; " + sfx.note : ""}`;
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
        const photo = await photosFor(post);
        const frames = await tab.evaluate(([pg, p, imgs]) => window.renderPost(pg, p, imgs), [page, post, photo.urls]);
        if (post.format !== "reel") { post.renderNote = photo.note || null; post.visualSource = photo.source || null; }
        const files = [];
        for (const f of frames) {
          const ext = f.mime === "image/png" ? "png" : "jpg";
          const file = path.join(outDir, `v${ver}-${f.name}.${ext}`);
          fs.writeFileSync(file, Buffer.from(f.dataUrl.split(",")[1], "base64"));
          files.push(file);
        }
        let media = files;
        if (post.format === "reel") { media = await renderReel(post, page, files, outDir, ver); files.forEach((f) => fs.rmSync(f, { force: true })); }
        for (const f of fs.readdirSync(outDir)) if (!f.startsWith(`v${ver}`)) fs.rmSync(path.join(outDir, f), { force: true });
        const patch = {
          media: media.map((f) => path.posix.join(rel, path.basename(f))), renderVersion: ver, needsRender: false,
          renderedAt: new Date().toISOString(), renderError: null, renderNote: post.renderNote || null, footageSource: post.footageSource || null, visualSource: post.visualSource || null,
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

module.exports = { ffmpegReel, renderPending, pixabayClips, pixabayImages, soundEffect, punchTime };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
