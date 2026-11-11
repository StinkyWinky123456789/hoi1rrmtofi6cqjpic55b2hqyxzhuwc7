// Classic meme templates from two libraries:
//  - Imgflip (needs IMGFLIP_API_KEY): the 100 most-captioned templates right now, plus niche searches with Premium.
//    Template ids look like "if-181913649". Captioned through Imgflip's own API so text lands in the right boxes.
//  - memegen.link (free, open source, no key): fills in classics Imgflip doesn't cover.
// Claude picks a template and writes its lines; we render it and frame it in the page's style.
"use strict";
const path = require("path");
const U = require("./util");

const BASE = (process.env.MEMEGEN_BASE || "https://api.memegen.link").replace(/\/$/, "");
const IMGFLIP = (process.env.IMGFLIP_BASE || "https://api.imgflip.com").replace(/\/$/, "");
const imgflipKey = () => U.secret("IMGFLIP_API_KEY");
const imgflipPremium = () => /^(1|true|yes)$/i.test(String(process.env.IMGFLIP_PREMIUM || "").trim());
// Leave out templates built on politicians / polarizing public figures (name match)
const EXCLUDE_NAME = /trump|biden|obama|hillary|clinton|bernie|putin|kanye|epstein|hitler|nazi|pelosi|desantis|kamala|zelensky|musk|bush|boehner/i;

// Well-known formats people instantly recognize. Only ids memegen actually serves are used.
// Templates built on politicians or polarizing public figures are deliberately left out.
const PREFERRED = [
  "drake", "db", "ds", "fine", "gru", "spongebob", "rollsafe", "pigeon", "stonks", "buzz", "cheems", "astronaut",
  "woman-cat", "exit", "gb", "panik-kalm-panik", "pooh", "both", "handshake", "chair", "mordor", "fry", "success",
  "aag", "doge", "kermit", "harold", "spiderman", "same", "pikachu", "headaches", "slap", "sadfrog", "money",
  "patrick", "ugandanknuck", "afraid", "officespace", "bad", "older", "home", "noidea", "ermg", "sohappy", "wonka",
];
const EXCLUDE = new Set(["cmm", "sad-biden", "sad-obama", "sad-bush", "sad-clinton", "sad-boehner", "trump", "biden", "crow"]);

/** Imgflip's top templates (free endpoint), cached 3 days. */
async function imgflipTop() {
  const cacheFile = path.join(U.ROOT, "state", "imgflip-templates.json"), cache = U.readJSON(cacheFile, null);
  if (cache && Date.now() - cache.t < 3 * 864e5) return cache.list;
  try {
    const r = await fetch(`${IMGFLIP}/get_memes`), j = await r.json();
    if (!j.success) throw new Error(j.error_message || `HTTP ${r.status}`);
    const list = j.data.memes.map((m) => ({ id: `if-${m.id}`, name: m.name, lines: m.box_count || 2, captions: m.captions || 0, example: [] }));
    U.writeJSON(cacheFile, { t: Date.now(), list });
    return list;
  } catch (e) { U.log(`imgflip templates unavailable (${e.message})`); return cache ? cache.list : []; }
}

/** Premium only: niche templates for a page (e.g. "anime", "gym"), popular ones only, cached 7 days. */
async function imgflipSearch(queries) {
  if (!imgflipPremium() || !queries || !queries.length) return [];
  const cacheFile = path.join(U.ROOT, "state", "imgflip-search.json"), cache = U.readJSON(cacheFile, {});
  const out = [];
  for (const q of queries) {
    let list = cache[q] && Date.now() - cache[q].t < 7 * 864e5 ? cache[q].list : null;
    if (!list) {
      try {
        const r = await fetch(`${IMGFLIP}/search_memes`, { method: "POST", headers: { Authorization: `Bearer ${imgflipKey()}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ query: q, type: "image", include_nsfw: "0" }) });
        const j = await r.json();
        if (!j.success) throw new Error(j.error_message || `HTTP ${r.status}`);
        list = j.data.memes.filter((m) => (m.captions || 0) >= 500).slice(0, 12).map((m) => ({ id: `if-${m.id}`, name: m.name, lines: m.box_count || 2, captions: m.captions || 0, example: [], niche: q }));
        cache[q] = { t: Date.now(), list }; U.writeJSON(cacheFile, cache);
      } catch (e) { U.log(`imgflip search "${q}" failed (${e.message})`); list = []; }
    }
    out.push(...list);
  }
  return out;
}

// memegen ids -> the same template's Imgflip name (normalized), so the menu doesn't list a format twice
const MG_EQUIV = {
  drake: "drakehotlinebling", db: "distractedboyfriend", ds: "twobuttons", gru: "grusplan", spongebob: "mockingspongebob",
  rollsafe: "rollsafethinkaboutit", pigeon: "isthisapigeon", buzz: "xxeverywhere", cheems: "buffdogevscheems", astronaut: "alwayshasbeen",
  "woman-cat": "womanyellingatcat", exit: "leftexit12offramp", gb: "expandingbrain", pooh: "tuxedowinniethepooh", handshake: "epichandshake",
  chair: "americanchopperargument", mordor: "onedoesnotsimply", fry: "futuramafry", success: "successkid", doge: "doge",
  kermit: "butthatsnoneofmybusiness", harold: "hidethepainharold", pikachu: "surprisedpikachu", slap: "batmanslappingrobin",
  fine: "thisisfine", "panik-kalm-panik": "panikkalmpanik", stonks: "stonks", wonka: "condescendingwonka", same: "theyrethesamepicture",
};

/** The template menu for a page: Imgflip trending + niche (if a key is set), then memegen classics not already covered. */
async function templates(page) {
  const mg = await memegenTemplates();
  if (!imgflipKey()) return mg;
  const norm = (n) => String(n).toLowerCase().replace(/[^a-z0-9]/g, "");
  const seen = new Set(), out = [];
  const add = (t) => { const k = norm(t.name); if (seen.has(k) || seen.has(t.id) || EXCLUDE_NAME.test(t.name)) return; seen.add(k); seen.add(t.id); out.push(t); };
  (await imgflipSearch(page && page.imgflipSearch)).forEach(add);
  (await imgflipTop()).sort((a, b) => b.captions - a.captions).forEach(add);
  mg.filter((t) => !seen.has(MG_EQUIV[t.id])).forEach(add);
  return out.slice(0, 110);
}

async function memegenTemplates() {
  const cacheFile = path.join(U.ROOT, "state", "memegen-templates.json");
  const cache = U.readJSON(cacheFile, null);
  let all = cache && Date.now() - cache.t < 7 * 864e5 ? cache.list : null;
  if (!all) {
    try {
      const r = await fetch(`${BASE}/templates/`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      all = (await r.json()).map((t) => ({ id: t.id, name: t.name, lines: t.lines || 2, example: (t.example && t.example.text) || [] }));
      U.writeJSON(cacheFile, { t: Date.now(), list: all });
    } catch (e) { U.log(`memegen templates unavailable (${e.message})`); all = cache ? cache.list : []; }
  }
  const byId = new Map(all.filter((t) => !EXCLUDE.has(t.id)).map((t) => [t.id, t]));
  const picked = PREFERRED.map((id) => byId.get(id)).filter(Boolean);
  return picked.length >= 12 ? picked : [...byId.values()].slice(0, 60);
}

/** memegen URL escaping: https://memegen.link/#special-characters */
function encodeLine(s) {
  const t = String(s || "").trim();
  if (!t) return "_";
  return t.replace(/_/g, "__").replace(/-/g, "--").replace(/ /g, "_").replace(/\?/g, "~q").replace(/&/g, "~a").replace(/%/g, "~p")
    .replace(/#/g, "~h").replace(/\//g, "~s").replace(/\\/g, "~b").replace(/</g, "~l").replace(/>/g, "~g").replace(/"/g, "''").replace(/\n/g, "~n");
}
function imageUrl(id, lines) { return `${BASE}/images/${encodeURIComponent(id)}/${lines.map(encodeLine).join("/")}.png?width=1080`; }

/** Caption an Imgflip template (text goes into the template's own boxes); returns { dataUrl, url }. */
async function renderImgflip(id, lines) {
  const key = imgflipKey();
  if (!key) throw new Error("no IMGFLIP_API_KEY");
  const body = new URLSearchParams({ template_id: id.replace(/^if-/, ""), font: "impact", max_font_size: "60" });
  lines.forEach((t, i) => body.append(`boxes[${i}][text]`, String(t || " ")));
  if (imgflipPremium()) body.append("no_watermark", "1");
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`${IMGFLIP}/caption_image`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" }, body });
      const j = await r.json().catch(() => ({ success: false, error_message: `HTTP ${r.status}` }));
      if (!j.success) { const e = new Error(`imgflip: ${j.error_message}`); if (r.status === 401 || r.status === 403 || /key|auth/i.test(j.error_message || "")) e.fatal = true; throw e; }
      const img = await fetch(j.data.url);
      const type = img.headers.get("content-type") || "image/jpeg";
      if (!img.ok || !type.startsWith("image/")) throw new Error(`imgflip image ${img.status}`);
      return { dataUrl: `data:${type};base64,${Buffer.from(await img.arrayBuffer()).toString("base64")}`, url: j.data.url };
    } catch (e) { lastErr = e; if (e.fatal) break; await U.sleep(1500 * attempt); }
  }
  throw lastErr;
}

/** Render a template with its lines; returns a data: URL. */
async function render(id, lines) {
  if (String(id).startsWith("if-")) return (await renderImgflip(id, lines)).dataUrl;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(imageUrl(id, lines));
      const type = r.headers.get("content-type") || "";
      if (!type.startsWith("image/")) throw new Error(`memegen ${r.status} ${type}`);
      if (r.status === 404) throw new Error(`memegen has no template "${id}"`); // memegen answers 404 with a placeholder image
      return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
    } catch (e) { lastErr = e; if (/no template/.test(e.message)) break; await U.sleep(1500 * attempt); }
  }
  throw lastErr;
}

/** Where the finished meme came from, for the review card. */
function sourceUrl(id, lines) { return String(id).startsWith("if-") ? `https://imgflip.com/memetemplate/${String(id).slice(3)}` : imageUrl(id, lines); }

module.exports = { templates, render, renderImgflip, encodeLine, imageUrl, sourceUrl };
