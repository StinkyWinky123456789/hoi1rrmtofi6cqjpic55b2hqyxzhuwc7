// Scrape images from the sources in config/pages.json ("sources") into the image pool.
// For each source page: check robots.txt, open it in headless Chrome and scroll until no more images load,
// collect every image the page shows, download them slowly, skip anything already in the pool (perceptual
// hash, so re-uploads and resized copies count as duplicates), then have Claude screen the new ones:
// blank templates, reaction pics, cursed images and art are kept; finished memes (caption already on it),
// nudity/gore/hate and images centred on a child are rejected and never fetched again.
// Usage: node engine/scrape.js [--source id] [--max 300]
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const U = require("./lib/util");
const P = require("./lib/pool");
const { askJSON } = require("./lib/claude");

const UA = "MemeEngineBot/1.0 (+personal meme page tool; respects robots.txt)";

/* ---------- robots.txt ---------- */
async function robots(url) {
  const u = new URL(url);
  let txt = "";
  try { const r = await fetch(`${u.origin}/robots.txt`, { headers: { "user-agent": UA } }); if (r.ok) txt = await r.text(); else if (r.status >= 500) return { ok: false, why: `robots.txt HTTP ${r.status}` }; }
  catch (e) { return { ok: false, why: `robots.txt unreachable (${e.message})` }; }
  // groups that apply to us: "MemeEngineBot" if present, else "*"
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim(); if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") { if (!lastWasAgent) { cur = { agents: [], rules: [], delay: 0 }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false; if (!cur) continue;
    if (k === "allow" || k === "disallow") { if (v || k === "allow") cur.rules.push({ allow: k === "allow", path: v }); }
    if (k === "crawl-delay") cur.delay = Number(v) || 0;
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && "memeenginebot".includes(a)));
  const use = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  const rules = use.flatMap((g) => g.rules), delay = Math.max(0, ...use.map((g) => g.delay));
  const target = u.pathname + u.search;
  const match = (p) => { const re = new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")); return re.test(target); };
  let best = null;
  for (const r of rules) if (r.path && match(r.path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  if (best && !best.allow) return { ok: false, why: `robots.txt disallows ${best.path}` };
  return { ok: true, delay };
}

/* ---------- collect image URLs from a scrolling page ---------- */
async function collect(src, S) {
  const { chromium } = require("playwright-core");
  const exe = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean).find((p) => fs.existsSync(p));
  if (!exe) throw new Error("Chrome not found; set CHROME_PATH");
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 2000 } });
    const tab = await ctx.newPage();
    const net = new Map();
    tab.on("response", (r) => {
      const t = r.headers()["content-type"] || "";
      if (/^image\/(jpeg|png|webp|gif)/.test(t)) net.set(r.url(), { url: r.url(), type: t, len: Number(r.headers()["content-length"] || 0) });
    });
    await tab.goto(src.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await tab.waitForTimeout(2500);
    let stable = 0, last = 0;
    for (let i = 0; i < (S.maxScrolls || 250) && stable < 5; i++) {
      // scroll every way a site might listen for: position, wheel, and a synthetic scroll event
      await tab.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); window.dispatchEvent(new Event("scroll")); });
      await tab.mouse.wheel(0, 2500).catch(() => {});
      await tab.waitForTimeout(S.scrollWaitMs || 1500);
      const n = await tab.evaluate(() => document.images.length * 1e7 + document.body.scrollHeight);
      if (n === last) stable++; else { stable = 0; last = n; }
    }
    // lazy-loading sites only load images that scroll into view: walk down the page one screen at a time
    const height = await tab.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y < height; y += 1600) { await tab.evaluate((yy) => window.scrollTo(0, yy), y); await tab.waitForTimeout(S.stepWaitMs || 350); }
    await tab.waitForTimeout(1500);
    // images on the page: loaded ones must be big enough (skips icons, avatars, logos); not-yet-loaded ones
    // (lazy, data-src) are kept and size-checked after download
    const dom = await tab.evaluate((min) => [...document.images]
      .filter((i) => (i.naturalWidth ? i.naturalWidth >= min && i.naturalHeight >= min : !!(i.currentSrc || i.src || i.dataset.src)))
      .map((i) => {
        if (!i.naturalWidth && i.dataset.src) return { url: new URL(i.dataset.src, location.href).href, w: 0, h: 0, alt: (i.alt || "").slice(0, 120) };
        // prefer the largest srcset candidate
        let best = i.currentSrc || i.src;
        if (i.srcset) { const c = i.srcset.split(",").map((s) => s.trim().split(/\s+/)).map(([u, w]) => [u, parseInt(w) || 0]).sort((a, b) => b[1] - a[1]); if (c[0] && c[0][0]) best = new URL(c[0][0], location.href).href; }
        return { url: best, w: i.naturalWidth, h: i.naturalHeight, alt: (i.alt || "").slice(0, 120) };
      }), src.minSize || 200);
    const seen = new Set(), out = [];
    for (const d of dom) if (!seen.has(d.url) && !/\.svg(\?|$)/i.test(d.url)) { seen.add(d.url); out.push(d); }
    return { items: out, networkImages: net.size };
  } finally { await browser.close(); }
}

/* ---------- download + normalize ---------- */
async function fetchImage(url, referer) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, referer } });
      if (r.status === 404 || r.status === 403) throw Object.assign(new Error(`HTTP ${r.status}`), { fatal: true });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const t = r.headers.get("content-type") || "";
      if (!/^image\//.test(t)) throw Object.assign(new Error(`not an image (${t})`), { fatal: true });
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { lastErr = e; if (e.fatal) break; await U.sleep(1500 * attempt); }
  }
  throw lastErr;
}
function normalize(buf, tmpDir, base) {
  const raw = path.join(tmpDir, base + ".src"), full = path.join(tmpDir, base + ".jpg"), thumb = path.join(tmpDir, base + "-t.jpg");
  fs.writeFileSync(raw, buf);
  // first frame for GIFs; transparent areas go white; max 1080px
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-frames:v", "1", "-filter_complex", "[0:v]format=rgba,split[a][b];[a]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill[bg];[bg][b]overlay=format=auto,scale='min(1080,iw)':-2,format=yuvj420p", "-q:v", "3", full]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", full, "-vf", "scale=320:-2", "-q:v", "6", thumb]);
  const dims = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", full]).toString().trim().split(",").map(Number);
  fs.rmSync(raw, { force: true });
  return { full, thumb, w: dims[0], h: dims[1] };
}

/* ---------- Claude screening ---------- */
const SCREEN_SCHEMA = {
  type: "object",
  properties: {
    images: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer" },
          keep: { type: "boolean" },
          reason: { type: "string", description: "if rejected: finished meme / nsfw / gore / hate / child / unusable" },
          kind: { type: "string", enum: ["template", "reaction", "cursed", "art", "photo", "other"] },
          desc: { type: "string", description: "what the image shows, 8-25 words, as a meme maker would describe it" },
          tags: { type: "array", items: { type: "string" } },
          pages: { type: "array", items: { type: "string" }, description: "page keys it suits" },
          fit: { type: "number", description: "meme potential 1-10" },
          person: { type: "string", enum: ["none", "public", "private"], description: "is the main subject a real identifiable person? public = famous / already a well-known meme; private = ordinary person" },
        },
        required: ["i", "keep", "kind", "desc", "tags", "pages", "fit", "person"],
      },
    },
  },
  required: ["images"],
};
async function screen(cfg, batch) {
  const pages = Object.entries(cfg.pages).map(([k, p]) => `- ${k}: ${p.niche}`).join("\n");
  const content = [{ type: "text", text: `You screen raw images for these Instagram meme pages:\n${pages}\n\nWe want RAW material we caption ourselves: blank meme templates, reaction images, cursed images, weird/funny art and photos.\nReject (keep=false):\n- finished memes: a caption or joke text is already on the image (small incidental text like a sign or label is fine)\n- nudity or sexual content, gore, hate symbols\n- images whose main subject is a child\n- unusable: tiny, blurry, mostly text, logos, ads, UI screenshots\nFor kept images: describe what's in them so a writer can caption them without seeing them, say which pages they suit, and score meme potential honestly. Mark person="private" when the main subject is an ordinary, non-famous person who isn't already a widely known meme.` }];
  batch.forEach((b, k) => { content.push({ type: "text", text: `Image ${k + 1}${b.alt ? ` (alt text: ${b.alt})` : ""}:` }); content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(b.thumb).toString("base64") } }); });
  const { data } = await askJSON({ model: cfg.judgeModel || cfg.model, system: "You are a careful, picky meme editor.", content, toolName: "screen_images", toolDescription: "Return a verdict for every image", schema: SCREEN_SCHEMA, maxTokens: 6000 });
  const out = new Map();
  for (const x of data.images || []) if (x.i >= 1 && x.i <= batch.length) out.set(x.i - 1, x);
  return out;
}

async function scrapeSource(cfg, src, S, maxNew) {
  const r = await robots(src.url);
  if (!r.ok) { U.log(`${src.id}: skipped, ${r.why}`); return { added: 0, skipped: r.why }; }
  const delay = Math.max(S.delayMs || 700, (r.delay || 0) * 1000);
  const { items, networkImages } = await collect(src, S);
  const seen = P.loadSeen(src.id), shard = P.loadShard(src.id);
  shard.name = src.name || src.id; shard.url = src.url;
  const known = new Set(shard.items.map((x) => x.from));
  const fresh = items.filter((x) => !seen.urls[x.url] && !known.has(x.url));
  U.log(`${src.id}: page shows ${items.length} images (${networkImages} loaded), ${fresh.length} new; taking up to ${maxNew}`);
  const hashes = [...P.all().map((x) => ({ h: x.hash, h16: x.hash16 })), ...seen.blocked.map((b) => (typeof b === "string" ? { h: b } : b))];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pool-")), pending = [];
  let dups = 0, failed = 0;
  for (const it of fresh.slice(0, maxNew)) {
    await U.sleep(delay);
    try {
      const buf = await fetchImage(it.url, src.url);
      const n = normalize(buf, tmp, `x${pending.length}-${dups}-${failed}`);
      const h = P.dhash(n.full);
      if (n.w < (src.minSize || 200) || n.h < (src.minSize || 200)) { seen.urls[it.url] = "small"; continue; }
      const h16 = P.dhash(n.full, 16);
      if (P.isDup(h, h16, hashes)) { dups++; seen.urls[it.url] = "dup"; continue; }
      hashes.push({ h, h16 });
      pending.push({ ...it, ...n, hash: h, hash16: h16 });
    } catch (e) { failed++; if (e.fatal) seen.urls[it.url] = "failed"; }
  }
  let added = 0, rejected = 0;
  const pageKeys = Object.keys(cfg.pages), outDir = path.join(P.POOL_DIR, src.id);
  fs.mkdirSync(path.join(outDir, "t"), { recursive: true });
  for (let k = 0; k < pending.length; k += S.screenBatch || 20) {
    const batch = pending.slice(k, k + (S.screenBatch || 20));
    let verdicts;
    try { verdicts = await screen(cfg, batch); } catch (e) { U.log(`${src.id}: screening failed (${e.message}); will retry next run`); continue; }
    batch.forEach((b, j) => {
      const v = verdicts.get(j);
      if (!v) return; // not judged: try again next run
      seen.urls[b.url] = v.keep ? "kept" : "rejected";
      if (!v.keep || (v.fit || 0) < (S.minFit || 5)) { rejected++; seen.blocked.push({ h: b.hash, h16: b.hash16 }); return; }
      const id = `${src.id.slice(0, 12)}-${b.hash}`;
      fs.copyFileSync(b.full, path.join(outDir, `${id}.jpg`)); fs.copyFileSync(b.thumb, path.join(outDir, "t", `${id}.jpg`));
      shard.items.push({
        id, source: src.id, from: b.url, file: `${src.id}/${id}.jpg`, thumb: `${src.id}/t/${id}.jpg`, hash: b.hash, hash16: b.hash16, w: b.w, h: b.h,
        kind: v.kind, desc: String(v.desc || "").slice(0, 220), tags: (v.tags || []).slice(0, 8).map(String),
        pages: (v.pages || []).filter((p) => pageKeys.includes(p)), fit: v.fit, person: v.person || "none",
        status: "new", uses: {}, addedAt: new Date().toISOString(),
      });
      added++;
    });
    saveShardSafe(shard); P.saveSeen(src.id, seen);
  }
  P.saveSeen(src.id, seen); saveShardSafe(shard);
  fs.rmSync(tmp, { recursive: true, force: true });
  U.log(`${src.id}: +${added} kept, ${rejected} rejected, ${dups} duplicates skipped, ${failed} failed downloads`);
  return { added, rejected, dups, failed };
}
function saveShardSafe(shard) { shard.items.forEach((x) => { if (!x.pages.length) x.pages = []; }); P.saveShard(shard); }

/** Banned items: delete the file, remember the hash so it's never scraped again. */
function pruneBanned() {
  let n = 0;
  for (const doc of P.shards()) {
    const seen = P.loadSeen(doc.source), keep = [];
    for (const x of doc.items) {
      if (x.status === "banned") { seen.blocked.push({ h: x.hash, h16: x.hash16 }); for (const f of [x.file, x.thumb]) fs.rmSync(path.join(P.POOL_DIR, f), { force: true }); n++; }
      else keep.push(x);
    }
    if (keep.length !== doc.items.length) { doc.items = keep; P.saveShard(doc); P.saveSeen(doc.source, seen); }
  }
  return n;
}

async function main() {
  const args = process.argv.slice(2), cfg = U.loadConfig();
  const S = Object.assign({ delayMs: 700, maxScrolls: 250, scrollWaitMs: 1500, screenBatch: 20, minFit: 5, maxNewPerRun: 400 }, cfg.scrape || {});
  const only = args.includes("--source") ? args[args.indexOf("--source") + 1] : null;
  const max = args.includes("--max") ? Number(args[args.indexOf("--max") + 1]) : null;
  U.log(`Removed ${pruneBanned()} banned image(s)`);
  for (const src of cfg.sources || []) {
    if (only ? src.id !== only : src.enabled === false) continue;
    try { await scrapeSource(cfg, src, S, max || src.maxNewPerRun || S.maxNewPerRun); }
    catch (e) { U.log(`${src.id}: failed: ${e.message}`); }
  }
  U.log(`Pool: ${P.all().length} images`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { robots };
