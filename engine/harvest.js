// Harvest meme-worthy clips from public-domain films on the Internet Archive.
// For each page: search trusted public-domain collections (Prelinger by default) with that page's queries,
// download a few films, cut them at scene changes, have Claude look at two frames of every shot and keep
// only the ones with meme potential, then save the keepers to the clip library.
// Usage: node engine/harvest.js [--page gym] [--films 2] [--commit]
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const U = require("./lib/util");
const L = require("./lib/library");
const { askJSON } = require("./lib/claude");

const IA = (process.env.ARCHIVE_BASE || "https://archive.org").replace(/\/$/, "");
const UA = { "user-agent": "meme-engine/1.0 (clip harvester; github actions)" };
const PD_LICENSE = /publicdomain|\/zero\/1\.0/i;

async function getJSON(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); }
    catch (e) { lastErr = e; await U.sleep(2000 * attempt); }
  }
  throw new Error(`${url.split("?")[0]}: ${lastErr.message}`);
}

/** Only items from trusted public-domain collections, or explicitly marked public domain / CC0. Anything with another licence is skipped. */
function allowed(doc, A) {
  const lic = String(doc.licenseurl || "");
  if (lic) return PD_LICENSE.test(lic);
  const cols = [].concat(doc.collection || []);
  return cols.some((c) => A.collections.includes(c));
}

async function search(query, A) {
  const scope = A.anyPublicDomain
    ? `(collection:(${A.collections.join(" OR ")}) OR licenseurl:(*publicdomain*) OR licenseurl:(*zero/1.0*))`
    : `collection:(${A.collections.join(" OR ")})`;
  const q = `(${query}) AND mediatype:movies AND ${scope}`;
  const params = new URLSearchParams({ q, rows: "40", output: "json" });
  ["identifier", "title", "year", "downloads", "licenseurl", "collection"].forEach((f) => params.append("fl[]", f));
  params.append("sort[]", "downloads desc");
  const j = await getJSON(`${IA}/advancedsearch.php?${params}`);
  return (j.response && j.response.docs || []).filter((d) => allowed(d, A));
}

/** Pick a video file: decent quality but not huge. */
function pickFile(files, maxMB) {
  const vids = files.filter((f) => /\.(mp4|m4v|mpeg|mpg|avi|ogv)$/i.test(f.name) && Number(f.size || 0) > 300e3);
  const rank = (f) => { const fmt = String(f.format || ""); return /h\.264 hd/i.test(fmt) ? 0 : /h\.264/i.test(fmt) ? 1 : /^mpeg4$/i.test(fmt) ? 2 : /512kb/i.test(fmt) ? 3 : /\.mp4$/i.test(f.name) ? 4 : 5; };
  const fit = vids.filter((f) => Number(f.size) <= maxMB * 1e6).sort((a, b) => rank(a) - rank(b) || Number(a.size) - Number(b.size));
  return fit[0] || vids.sort((a, b) => Number(a.size) - Number(b.size))[0] || null;
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: UA, redirect: "follow" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fs.writeFileSync(dest + ".part", Buffer.from(await r.arrayBuffer()));
      fs.renameSync(dest + ".part", dest);
      return dest;
    } catch (e) { lastErr = e; await U.sleep(3000 * attempt); }
  }
  throw lastErr;
}

function probe(file) {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]).toString());
  return { duration: Number(j.format.duration || 0), hasAudio: j.streams.some((s) => s.codec_type === "audio") };
}

/** Scene cuts (seconds) in the first `limit` seconds. */
function sceneCuts(file, limit, threshold) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-t", String(limit), "-i", file, "-an", "-vf", `scale=320:-2,select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64e6 });
  return [...String(r.stderr).matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
}

/** Turn cuts into candidate shots between minS and maxS long (long shots are split). */
function shots(cuts, duration, A) {
  const bounds = [0, ...cuts.filter((t) => t > 0.3 && t < duration - 0.3), duration];
  const out = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    let s = bounds[i] + 0.15, e = bounds[i + 1] - 0.15;
    if (e - s < A.minSeconds) continue;
    while (e - s > A.maxSeconds * 1.6) { out.push([s, s + A.maxSeconds]); s += A.maxSeconds; }
    out.push([s, Math.min(e, s + A.maxSeconds)]);
  }
  // skip the opening titles; spread the rest evenly if there are too many
  const body = out.filter(([s]) => s > 8);
  const pool = body.length >= 6 ? body : out;
  if (pool.length <= A.candidatesPerFilm) return pool;
  const step = pool.length / A.candidatesPerFilm;
  return Array.from({ length: A.candidatesPerFilm }, (_, k) => pool[Math.floor(k * step)]);
}

/** Two frames of a shot side by side (start + later), small JPEG for Claude. */
function contact(file, s, e, out) {
  const t1 = s + (e - s) * 0.2, t2 = s + (e - s) * 0.8;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", t1.toFixed(2), "-i", file, "-ss", t2.toFixed(2), "-i", file,
    "-filter_complex", "[0:v]scale=320:240,setsar=1[a];[1:v]scale=320:240,setsar=1[b];[a][b]hstack", "-frames:v", "1", "-q:v", "6", out]);
  return fs.readFileSync(out).toString("base64");
}

const PICK_SCHEMA = {
  type: "object",
  properties: {
    keep: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer", description: "clip number" },
          desc: { type: "string", description: "what literally happens, 8-20 words" },
          pages: { type: "array", items: { type: "string" }, description: "page keys this clip fits" },
          fit: { type: "number", description: "meme potential 1-10" },
          idea: { type: "string", description: "one caption idea" },
          stillOk: { type: "boolean", description: "true if a single frame works as a still-image meme" },
        },
        required: ["i", "desc", "pages", "fit", "idea", "stillOk"],
      },
    },
  },
  required: ["keep"],
};

async function scout(cfg, film, cands, imgs, keepMax) {
  const pages = Object.entries(cfg.pages).map(([k, p]) => `- ${k}: ${p.niche}`).join("\n");
  const content = [{ type: "text", text: `You scout footage for these Instagram meme pages:\n${pages}\n\nBelow are ${cands.length} short clips from the public-domain film "${film.title}"${film.year ? ` (${film.year})` : ""}. Each image shows two frames of one clip (start, then later).\n\nKeep ONLY clips with real meme potential: strong or awkward facial expressions, absurd or dated actions, dramatic stares, people failing, weird demonstrations, reaction-worthy moments, anything a viewer would screenshot. Reject title cards, credits, maps, plain scenery, blurry or empty shots, and anything only funny if you explain it. Keep at most ${keepMax}; fewer is fine; keeping none is fine. Score fit honestly (8+ means it would genuinely make people laugh).` }];
  cands.forEach(([s, e], k) => { content.push({ type: "text", text: `Clip ${k + 1} (${(e - s).toFixed(1)}s):` }); content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgs[k] } }); });
  const { data, usage } = await askJSON({ model: cfg.judgeModel || cfg.model, system: "You are a sharp meme editor with great taste. Be picky.", content, toolName: "pick_clips", toolDescription: "Return the clips worth keeping", schema: PICK_SCHEMA, maxTokens: 4000 });
  return { keep: (data.keep || []).filter((x) => x.i >= 1 && x.i <= cands.length), usage };
}

function cutClip(file, s, e, hasAudio, out) {
  const args = ["-y", "-loglevel", "error", "-ss", s.toFixed(2), "-t", (e - s).toFixed(2), "-i", file,
    "-vf", "scale='min(960,iw)':-2:flags=bicubic,fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24"];
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "96k", "-ac", "2", "-ar", "44100"); else args.push("-an");
  args.push("-movflags", "+faststart", out);
  execFileSync("ffmpeg", args);
}
function still(file, t, out) { execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", t.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale='min(1080,iw)':-2", "-q:v", "3", out]); }

async function harvestFilm(cfg, A, doc, pageKey, seen) {
  const meta = await getJSON(`${IA}/metadata/${encodeURIComponent(doc.identifier)}`);
  const lic = (meta.metadata && meta.metadata.licenseurl) || doc.licenseurl || "";
  if (lic && !PD_LICENSE.test(lic)) { U.log(`  skip ${doc.identifier}: licence ${lic}`); return []; }
  const f = pickFile(meta.files || [], A.maxDownloadMB);
  if (!f) { U.log(`  skip ${doc.identifier}: no usable video file`); return []; }
  const tmp = path.join(os.tmpdir(), "meme-archive");
  const src = await download(`${IA}/download/${encodeURIComponent(doc.identifier)}/${f.name.split("/").map(encodeURIComponent).join("/")}`, path.join(tmp, `${doc.identifier}${path.extname(f.name)}`));
  const info = probe(src), limit = Math.min(info.duration, A.maxFilmMinutes * 60);
  const cands = shots(sceneCuts(src, limit, A.sceneThreshold), limit, A);
  if (!cands.length) { fs.rmSync(src, { force: true }); return []; }
  const imgs = cands.map(([s, e], k) => contact(src, s, e, path.join(tmp, `${doc.identifier}-c${k}.jpg`)));
  const film = { title: (meta.metadata && meta.metadata.title) || doc.title || doc.identifier, year: (meta.metadata && meta.metadata.year) || doc.year || "" };
  const { keep, usage } = await scout(cfg, film, cands, imgs, A.keepPerFilm);
  U.log(`  ${doc.identifier}: ${cands.length} shots → kept ${keep.length} (Claude ${usage ? usage.input_tokens + "+" + usage.output_tokens + " tokens" : ""})`);
  const added = [], pageKeys = Object.keys(cfg.pages);
  fs.mkdirSync(path.join(U.SITE, "library"), { recursive: true });
  for (const k of keep.sort((a, b) => b.fit - a.fit).slice(0, A.keepPerFilm)) {
    if (k.fit < A.minFit) continue;
    const [s, e] = cands[k.i - 1];
    const id = `ia-${doc.identifier.replace(/[^\w-]/g, "").slice(0, 40)}-${Math.round(s * 10)}`;
    const clip = {
      id, source: doc.identifier, title: film.title, year: film.year, sourceUrl: `https://archive.org/details/${doc.identifier}`,
      license: lic || `collection: ${[].concat(doc.collection || []).filter((c) => A.collections.includes(c)).join(", ")}`,
      start: +s.toFixed(2), dur: +(e - s).toFixed(2), hasAudio: info.hasAudio,
      file: `library/${id}.mp4`, poster: `library/${id}.jpg`,
      desc: String(k.desc).slice(0, 200), idea: String(k.idea || "").slice(0, 200), fit: k.fit, stillOk: !!k.stillOk,
      pages: [...new Set([...(k.pages || []).filter((p) => pageKeys.includes(p)), pageKey])],
      status: "new", uses: 0, addedAt: new Date().toISOString(), foundFor: pageKey,
    };
    cutClip(src, s, e, info.hasAudio, path.join(U.SITE, clip.file));
    still(src, s + (e - s) * 0.5, path.join(U.SITE, clip.poster));
    added.push(clip);
  }
  seen[doc.identifier] = new Date().toISOString().slice(0, 10);
  fs.rmSync(src, { force: true });
  return added;
}

async function main() {
  const args = process.argv.slice(2), cfg = U.loadConfig();
  const A = Object.assign({ collections: ["prelinger"], anyPublicDomain: false, filmsPerPage: 2, candidatesPerFilm: 40, keepPerFilm: 12, minFit: 6,
    minSeconds: 2.5, maxSeconds: 7, maxFilmMinutes: 20, maxDownloadMB: 400, sceneThreshold: 0.32, maxClips: 240 }, cfg.archive || {});
  if (A.enabled === false) { U.log("archive harvesting is off (config archive.enabled = false)"); return; }
  const only = args.includes("--page") ? args[args.indexOf("--page") + 1] : null;
  const films = args.includes("--films") ? Number(args[args.indexOf("--films") + 1]) : A.filmsPerPage;
  const seenFile = path.join(U.ROOT, "state", "archive-seen.json"), seen = U.readJSON(seenFile, {});
  const week = Number(U.isoWeekId(new Date().toISOString().slice(0, 10)).split("-W")[1]) || 0;
  let total = 0;
  for (const [key, pg] of Object.entries(cfg.pages)) {
    if (only && key !== only) continue;
    const queries = pg.archiveQueries || [];
    if (!queries.length) continue;
    U.log(`${key}: harvesting up to ${films} film(s)`);
    let got = 0;
    for (let qi = 0; qi < queries.length && got < films; qi++) {
      const query = queries[(week + qi) % queries.length];
      let docs;
      try { docs = (await search(query, A)).filter((d) => !seen[d.identifier]); }
      catch (e) { U.log(`  search "${query}" failed: ${e.message}`); continue; }
      for (const d of docs.slice(0, 3)) {
        if (got >= films) break;
        try {
          const added = await harvestFilm(cfg, A, d, key, seen);
          if (added.length) { const lib = L.load(), have = new Set(lib.clips.map((c) => c.id)); lib.clips.push(...added.filter((c) => !have.has(c.id))); L.save(lib); total += added.length; }
          got++;
        } catch (e) { U.log(`  ${d.identifier} failed: ${e.message}`); seen[d.identifier] = "failed"; }
        U.writeJSON(seenFile, seen);
      }
    }
  }
  const pruned = L.prune(A.maxClips);
  U.log(`Library: +${total} clip(s), pruned ${pruned}, now ${L.load().clips.length}`);
  if (args.includes("--commit") && !process.env.NO_GIT) {
    const C = require("./lib/changes");
    C.pushSite("Archive clips");
    const git = (a) => execFileSync("git", a, { cwd: U.ROOT, stdio: "inherit" });
    git(["add", "library", "state"]);
    if (spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: U.ROOT }).status !== 0) {
      git(["commit", "-q", "-m", "Archive clips"]);
      for (let i = 0; i < 4; i++) { if (spawnSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: U.ROOT, stdio: "inherit" }).status === 0) break; git(["pull", "-q", "--rebase", "origin", "main"]); }
    }
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { shots, allowed, pickFile };
