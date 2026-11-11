// Collect trend signals for next week's memes. Signals are TOPICS, never content to repost.
// Sources: holidays table, Google Trends daily RSS, AniList airing schedule, Stooq index closes,
// X recent search (pay-per-use, hard monthly cap), and this page's own past performance.
"use strict";
const path = require("path");
const U = require("./lib/util");

const HOLIDAYS = [
  ["2026-11-26", "Thanksgiving (US)"], ["2026-11-27", "Black Friday"], ["2026-11-30", "Cyber Monday"],
  ["2026-12-21", "Winter solstice, shortest day of the year"], ["2026-12-24", "Christmas Eve"], ["2026-12-25", "Christmas"],
  ["2026-12-31", "New Year's Eve"], ["2027-01-01", "New Year's Day: resolution season starts"], ["2027-01-04", "First Monday back at work/school after the holidays"],
  ["2027-01-18", "Martin Luther King Jr. Day (US)"], ["2027-02-14", "Valentine's Day"], ["2027-03-14", "Daylight saving time starts (US): lose an hour of sleep"],
  ["2027-03-17", "St. Patrick's Day"], ["2027-04-01", "April Fools' Day"], ["2027-04-15", "US tax day"], ["2027-05-09", "Mother's Day (US)"],
  ["2027-06-20", "Father's Day (US)"], ["2027-07-04", "Independence Day (US)"], ["2027-10-31", "Halloween"],
];

async function getText(url, opts = {}, timeoutMs = 15000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal, headers: { "User-Agent": "meme-engine/1.0", ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

function holidaySignals(weekStart) {
  const end = U.addDays(weekStart, 13);
  return HOLIDAYS.filter(([d]) => d >= U.addDays(weekStart, -1) && d <= end).map(([d, n]) => `${U.prettyDate(d)}: ${n}`);
}

async function googleTrends() {
  const xml = await getText("https://trends.google.com/trending/rss?geo=US");
  return [...xml.matchAll(/<item>[\s\S]*?<title>([^<]+)<\/title>/g)].map((m) => m[1].trim()).slice(0, 20);
}

async function anilist(weekStart, tz) {
  const from = Math.floor(U.zonedToUtc(weekStart, "00:00", tz).getTime() / 1000), to = from + 7 * 86400;
  const query = `query($from:Int,$to:Int){
    airing: Page(perPage: 50){ airingSchedules(airingAt_greater:$from, airingAt_lesser:$to, sort:TIME){ episode media{ title{ english romaji } popularity isAdult } } }
    trending: Page(perPage: 12){ media(type:ANIME, sort:TRENDING_DESC, isAdult:false){ title{ english romaji } } } }`;
  const body = await getText("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query, variables: { from, to } }) });
  const j = JSON.parse(body).data;
  const name = (m) => m.title.english || m.title.romaji;
  const seen = new Set();
  const airing = j.airing.airingSchedules.filter((s) => s.media && !s.media.isAdult).sort((a, b) => b.media.popularity - a.media.popularity)
    .filter((s) => { const n = name(s.media); if (seen.has(n)) return false; seen.add(n); return true; }).slice(0, 12)
    .map((s) => `${name(s.media)} episode ${s.episode} airs this week`);
  const trending = j.trending.media.map((m) => `Trending anime: ${name(m)}`);
  return [...airing, ...trending];
}

async function markets() {
  const out = [];
  const say = (label, date, d1, d5) => `${label} closed ${date} ${d1 >= 0 ? "up" : "down"} ${Math.abs(d1).toFixed(1)}% on the day, ${d5 >= 0 ? "up" : "down"} ${Math.abs(d5).toFixed(1)}% over 5 trading days`;
  for (const [yh, sq, label] of [["^GSPC", "^spx", "S&P 500"], ["^IXIC", "^ndq", "Nasdaq"], ["BTC-USD", "btcusd", "Bitcoin"]]) {
    try {
      const j = JSON.parse(await getText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yh)}?range=1mo&interval=1d`, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } }));
      const r = j.chart.result[0], closes = r.indicators.quote[0].close, ts = r.timestamp;
      const rows = ts.map((t, i) => [t, closes[i]]).filter((x) => x[1] != null);
      if (rows.length < 6) throw new Error("not enough data");
      const last = rows.at(-1), prev = rows.at(-2), wk = rows.at(-6);
      out.push(say(label, new Date(last[0] * 1000).toISOString().slice(0, 10), (last[1] / prev[1] - 1) * 100, (last[1] / wk[1] - 1) * 100));
      continue;
    } catch (e) { U.log(`markets (Yahoo) ${label}: ${e.message}`); }
    try {
      const csv = (await getText(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sq)}&i=d`)).trim().split("\n");
      const rows = csv.slice(1).map((l) => l.split(",")).filter((r) => r.length >= 5 && !isNaN(+r[4]));
      if (rows.length < 6) continue;
      const last = rows.at(-1), prev = rows.at(-2), wk = rows.at(-6);
      out.push(say(label, last[0], (+last[4] / +prev[4] - 1) * 100, (+last[4] / +wk[4] - 1) * 100));
    } catch (e) { U.log(`markets (Stooq) ${label}: ${e.message}`); }
  }
  return out;
}

/** X recent search, billed per post returned ($0.005 each). Enforces config.xMonthlyReadCap. */
async function xSearch(cfg, pageKey) {
  const token = U.secret("X_BEARER_TOKEN");
  if (!token) return [];
  const usageFile = path.join(U.ROOT, "state", "x-usage.json");
  const month = new Date().toISOString().slice(0, 7);
  const usage = U.readJSON(usageFile, {});
  const used = usage[month] || 0, left = cfg.xMonthlyReadCap - used;
  const want = Math.min(cfg.xReadsPerPagePerRun, left);
  if (want < 10) { U.log(`X: monthly cap reached (${used}/${cfg.xMonthlyReadCap}), skipping ${pageKey}`); return []; }
  const q = new URLSearchParams({ query: cfg.pages[pageKey].xQuery, max_results: String(Math.min(100, want)), sort_order: "relevancy", "tweet.fields": "public_metrics" });
  const r = await fetch(`https://api.x.com/2/tweets/search/recent?${q}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 402) { U.log(`X ${pageKey}: no X credits left (add credit in console.x.com → Billing); skipping X trends`); return []; }
  if (!r.ok) { U.log(`X ${pageKey}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`); return []; }
  const data = j.data || [];
  usage[month] = used + data.length; U.writeJSON(usageFile, usage);
  U.log(`X ${pageKey}: ${data.length} posts read (month total ${usage[month]}/${cfg.xMonthlyReadCap}, about $${(usage[month] * 0.005).toFixed(2)})`);
  return data.map((t) => ({ text: t.text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim(), likes: t.public_metrics?.like_count || 0 }))
    .filter((t) => t.text.length > 20).sort((a, b) => b.likes - a.likes).slice(0, 15).map((t) => t.text.slice(0, 220));
}

/** What worked and what flopped on this page recently (from metrics.js). */
function performance(pageKey) {
  const cutoff = Date.now() - 45 * 864e5, rows = [];
  for (const q of U.listQueueFiles().filter((f) => f.page === pageKey)) {
    for (const p of U.readJSON(q.file, { posts: [] }).posts) {
      if (p.status === "posted" && p.metrics && p.metrics.reach > 0 && Date.parse(p.postedAt) > cutoff) {
        rows.push({ p, rate: (p.metrics.shares || 0) / p.metrics.reach, saves: (p.metrics.saved || 0) / p.metrics.reach });
      }
    }
  }
  if (rows.length < 6) return { top: [], bottom: [] };
  rows.sort((x, y) => y.rate - x.rate);
  const fmt = (r) => `[${r.p.format}/${r.p.template || "-"}] "${U.postText(r.p).slice(0, 140)}" sends per 1k reach: ${(r.rate * 1000).toFixed(1)}`;
  return { top: rows.slice(0, 5).map(fmt), bottom: rows.slice(-5).map(fmt) };
}

async function safe(label, fn) { try { const v = await fn(); U.log(`${label}: ${v.length} signals`); return v; } catch (e) { U.log(`${label} failed: ${e.message}`); return []; } }

async function collectSignals(cfg, weekStart) {
  const tz = cfg.timezone;
  const common = { holidays: holidaySignals(weekStart), trends: await safe("Google Trends", googleTrends) };
  const anime = await safe("AniList", () => anilist(weekStart, tz));
  const mkt = await safe("Markets", markets);
  const out = {};
  for (const key of Object.keys(cfg.pages)) {
    out[key] = {
      ...common,
      niche: key === "anime" ? anime : key === "money" ? mkt : [],
      x: await safe(`X ${key}`, () => xSearch(cfg, key)),
      performance: performance(key),
    };
  }
  return out;
}

module.exports = { collectSignals, holidaySignals, markets };

if (require.main === module) {
  (async () => {
    const cfg = U.loadConfig(), wk = process.argv[2] || U.nextMonday(new Date(), cfg.timezone);
    const s = await collectSignals(cfg, wk);
    U.writeJSON(path.join(U.ROOT, "state", "signals", `${U.isoWeekId(wk)}.json`), s);
    console.log(JSON.stringify(s, null, 2));
  })().catch((e) => { console.error(e); process.exit(1); });
}
