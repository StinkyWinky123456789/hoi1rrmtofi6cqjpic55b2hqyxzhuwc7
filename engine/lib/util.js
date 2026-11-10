// Shared helpers: config, time zones, queue files, text similarity.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SITE = process.env.SITE_DIR ? path.resolve(process.env.SITE_DIR) : path.join(ROOT, "site");

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
function loadConfig() { return readJSON(path.join(ROOT, "config", "pages.json")); }
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Dates (all "ymd" strings are calendar dates in the configured time zone) ---------- */
function tzParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second, weekday: p.weekday };
}
function tzOffsetMs(date, tz) {
  const p = tzParts(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(date.getTime() / 1000) * 1000;
}
/** Local wall time in tz -> UTC Date. */
function zonedToUtc(ymd, hhmm, tz) {
  const [y, m, d] = ymd.split("-").map(Number), [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  t = guess - tzOffsetMs(new Date(t), tz); // second pass handles DST edges
  return new Date(t);
}
function ymdOf(date, tz) { const p = tzParts(date, tz); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; }
function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function weekday(ymd) { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); } // 0 = Sun
/** The Monday that starts the next full week after `now` (in tz). */
function nextMonday(now, tz) {
  const today = ymdOf(now, tz), wd = weekday(today);
  return addDays(today, wd === 0 ? 1 : 8 - wd);
}
function isoWeekId(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d)); const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - yearStart) / 864e5 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}
function prettyDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/* ---------- Queue files: queue/<week>/<page>.json ---------- */
const QUEUE = path.join(ROOT, "queue");
function queueFile(week, page) { return path.join(QUEUE, week, `${page}.json`); }
function listQueueFiles() {
  if (!fs.existsSync(QUEUE)) return [];
  const out = [];
  for (const w of fs.readdirSync(QUEUE).sort()) {
    const dir = path.join(QUEUE, w);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) out.push({ week: w, page: f.replace(/\.json$/, ""), file: path.join(dir, f) });
  }
  return out;
}

/* ---------- Text similarity for de-duplication ---------- */
const STOP = new Set("the a an and or of to in on at for my me i is it you your this that be with when like just are was".split(" "));
function tokens(s) { return new Set(String(s || "").toLowerCase().replace(/[^a-z0-9$%' ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))); }
function jaccard(a, b) {
  const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
function postText(p) { return [p.a, p.b, ...(p.s || [])].filter(Boolean).join(" "); }

module.exports = {
  ROOT, SITE, QUEUE, readJSON, writeJSON, loadConfig, log, sleep,
  tzParts, zonedToUtc, ymdOf, addDays, weekday, nextMonday, isoWeekId, prettyDate,
  queueFile, listQueueFiles, tokens, jaccard, postText,
};
