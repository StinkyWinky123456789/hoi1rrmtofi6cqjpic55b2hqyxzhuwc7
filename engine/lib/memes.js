// Classic meme templates via memegen.link (free, open source, no API key).
// Claude picks a template and writes its lines; we render through memegen and frame it in the page's style.
"use strict";
const path = require("path");
const U = require("./util");

const BASE = (process.env.MEMEGEN_BASE || "https://api.memegen.link").replace(/\/$/, "");

// Well-known formats people instantly recognize. Only ids memegen actually serves are used.
// Templates built on politicians or polarizing public figures are deliberately left out.
const PREFERRED = [
  "drake", "db", "ds", "fine", "gru", "spongebob", "rollsafe", "pigeon", "stonks", "buzz", "cheems", "astronaut",
  "woman-cat", "exit", "gb", "panik-kalm-panik", "pooh", "both", "handshake", "chair", "mordor", "fry", "success",
  "aag", "doge", "kermit", "harold", "spiderman", "same", "pikachu", "headaches", "slap", "sadfrog", "money",
  "patrick", "ugandanknuck", "afraid", "officespace", "bad", "older", "home", "noidea", "ermg", "sohappy", "wonka",
];
const EXCLUDE = new Set(["cmm", "sad-biden", "sad-obama", "sad-bush", "sad-clinton", "sad-boehner", "trump", "biden", "crow"]);

async function templates() {
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

/** Render a template with its lines; returns a data: URL. */
async function render(id, lines) {
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

module.exports = { templates, render, encodeLine, imageUrl };
