// The image pool: blank templates, reaction pics, cursed images and art scraped from configured sources.
// Index:  library/pool/<source>.json on main ({ items: [...] }; the review app stars/bans items there).
// Files:  the "pool" branch (<source>/<id>.jpg + <source>/t/<id>.jpg), served from raw.githubusercontent.com.
// Dedupe: every image gets a 64-bit perceptual hash (dHash); near-identical images are never stored twice,
//         an image isn't reused on a page, nor on any page within crossPageDays, and finished posts are
//         hashed too so a post that looks like an earlier one gets flagged in review.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const U = require("./util");

const DIR = path.join(U.ROOT, "library", "pool");
const POOL_DIR = process.env.POOL_DIR ? path.resolve(process.env.POOL_DIR) : path.join(U.ROOT, "pool-files");
const poolBase = () => (process.env.POOL_BASE || (process.env.GITHUB_REPOSITORY ? `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/pool` : "")).replace(/\/$/, "");

/* ---------- perceptual hash ---------- */
/** dHash: n×n bits (8 → 64-bit, catches re-uploads/resizes; 16 → 256-bit, sees caption differences). */
function dhash(file, n = 8) {
  const px = execFileSync("ffmpeg", ["-loglevel", "error", "-i", file, "-frames:v", "1", "-vf", `scale=${n + 1}:${n}:flags=area,format=gray`, "-f", "rawvideo", "-"]);
  let bits = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) bits += px[y * (n + 1) + x] > px[y * (n + 1) + x + 1] ? "1" : "0";
  return BigInt("0b" + bits).toString(16).padStart((n * n) / 4, "0");
}
const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
function distance(a, b) { if (a.length !== b.length) return 999; let d = 0; for (let i = 0; i < a.length; i++) d += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)]; return d; }
/** First stored hash within `max` of 64 bits of h (≤10 = same picture, resized or re-saved), or null. */
function nearest(h, hashes, max = 10) { for (const x of hashes) if (distance(h, x) <= max) return x; return null; }
/** Same picture? Coarse 64-bit match (survives resizing/re-saving) confirmed by the finer 256-bit hash,
 *  so mostly-flat images with sparse coarse hashes don't falsely match each other. */
function isDup(h, h16, known) {
  for (const k of known) {
    const coarse = distance(h, k.h);
    if (coarse > 10) continue;
    if (h16 && k.h16 ? distance(h16, k.h16) <= 20 : coarse <= 4) return true;
  }
  return false;
}

/* ---------- index shards ---------- */
function shardFile(source) { return path.join(DIR, `${source}.json`); }
function loadShard(source) { return U.readJSON(shardFile(source), { source, items: [] }); }
function saveShard(doc) { fs.mkdirSync(DIR, { recursive: true }); U.writeJSON(shardFile(doc.source), doc); }
function shards() { return fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => loadShard(f.replace(/\.json$/, ""))) : []; }
function all() { return shards().flatMap((s) => s.items); }
function byId() { return new Map(all().map((x) => [x.id, x])); }

/** State the review app never needs: URLs already handled and hashes that must never come back (rejected/banned). */
function seenFile(source) { return path.join(U.ROOT, "state", `pool-seen-${source}.json`); }
function loadSeen(source) { return U.readJSON(seenFile(source), { urls: {}, blocked: [] }); }
function saveSeen(source, s) { U.writeJSON(seenFile(source), s); }

/* ---------- picking for posts ---------- */
const daysAgo = (iso) => (Date.now() - Date.parse(iso)) / 864e5;
/** Images a page may use now, best first. Private-person images are only used if you starred them. */
function forPage(page, opts = {}) {
  const reuseDays = opts.reuseDays ?? 365, crossDays = opts.crossPageDays ?? 21;
  return all().filter((x) => {
    if (x.status === "banned" || !(x.pages || []).includes(page)) return false;
    if (x.person === "private" && x.status !== "starred") return false;
    const u = x.uses || {};
    if (u[page] && daysAgo(u[page]) < reuseDays) return false;
    if (Object.values(u).some((d) => daysAgo(d) < crossDays)) return false;
    return true;
  }).sort((a, b) => (b.status === "starred") - (a.status === "starred") || (b.fit || 0) - (a.fit || 0) || a.id.localeCompare(b.id));
}

function markUsed(page, ids) {
  if (!ids.length) return;
  const want = new Set(ids), now = new Date().toISOString();
  for (const doc of shards()) {
    let touched = false;
    for (const x of doc.items) if (want.has(x.id)) { x.uses = Object.assign({}, x.uses, { [page]: now }); touched = true; }
    if (touched) saveShard(doc);
  }
}

/** A pool image as a data: URL (local copy first, else the pool branch over HTTPS). */
async function dataUrl(item) {
  const local = path.join(POOL_DIR, item.file);
  if (fs.existsSync(local)) return `data:image/jpeg;base64,${fs.readFileSync(local).toString("base64")}`;
  const base = poolBase();
  if (!base) throw new Error("no POOL_BASE / GITHUB_REPOSITORY to fetch pool images from");
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`${base}/${item.file.split("/").map(encodeURIComponent).join("/")}`);
      if (!r.ok) throw new Error(`pool image HTTP ${r.status}`);
      return `data:image/jpeg;base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
    } catch (e) { lastErr = e; await U.sleep(1000 * attempt); }
  }
  throw lastErr;
}

/* ---------- finished-post near-duplicate check ---------- */
const RENDER_HASHES = path.join(U.ROOT, "state", "render-hashes.json");
/** Hash a rendered post image; returns the id of an earlier post it looks identical to (or null). */
function checkRendered(postId, page, file) {
  let h; try { h = dhash(file, 16); } catch { return null; }
  const db = U.readJSON(RENDER_HASHES, {});
  let dup = null;
  for (const [id, v] of Object.entries(db)) if (id !== postId && distance(h, v.h) <= 10) { dup = id; break; }
  db[postId] = { h, page, at: new Date().toISOString().slice(0, 10) };
  // keep a year of history
  for (const [id, v] of Object.entries(db)) if (daysAgo(v.at) > 366) delete db[id];
  U.writeJSON(RENDER_HASHES, db);
  return dup;
}

module.exports = { DIR, POOL_DIR, poolBase, dhash, distance, nearest, isDup, loadShard, saveShard, shards, all, byId, loadSeen, saveSeen, forPage, markUsed, dataUrl, checkRendered };
