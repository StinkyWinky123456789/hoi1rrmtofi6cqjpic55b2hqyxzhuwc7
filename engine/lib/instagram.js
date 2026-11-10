// Instagram publishing and insights. Works with both Meta token types:
//  - Unified Login / Facebook Login tokens (start with "EAA", used by new Meta apps) -> graph.facebook.com
//  - Instagram Login tokens (start with "IG") -> graph.instagram.com
// The publishing endpoints are the same on both hosts.
"use strict";
const { sleep, log } = require("./util");

function baseFor(token) {
  if (process.env.IG_API_BASE) return process.env.IG_API_BASE.replace(/\/$/, "");
  return /^EAA/.test(token || "") ? "https://graph.facebook.com" : "https://graph.instagram.com";
}
const isSystemUserToken = (token) => /^EAA/.test(token || "");
const VER = process.env.IG_API_VERSION || "v27.0";

function creds(pageKey) {
  const K = pageKey.toUpperCase();
  const id = process.env[`IG_USER_ID_${K}`], token = process.env[`IG_TOKEN_${K}`];
  return id && token ? { id, token } : null;
}

async function call(method, pathname, params, token) {
  const url = new URL(`${baseFor(token)}/${VER}/${pathname.replace(/^\//, "")}`);
  const body = new URLSearchParams({ ...params, access_token: token });
  let r;
  if (method === "GET") { for (const [k, v] of body) url.searchParams.set(k, v); r = await fetch(url); }
  else r = await fetch(url, { method, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw Object.assign(new Error(`Instagram ${r.status}: ${e.message || "unknown error"}${e.error_subcode ? ` (subcode ${e.error_subcode})` : ""}`), { code: e.code, subcode: e.error_subcode, status: r.status });
  }
  return j;
}

async function waitFinished(containerId, token, maxSeconds) {
  const start = Date.now();
  for (;;) {
    const j = await call("GET", containerId, { fields: "status_code,status" }, token);
    if (j.status_code === "FINISHED" || j.status_code === "PUBLISHED") return;
    if (j.status_code === "ERROR" || j.status_code === "EXPIRED") throw new Error(`container ${j.status_code}: ${j.status || ""}`);
    if ((Date.now() - start) / 1000 > maxSeconds) throw new Error(`container still ${j.status_code} after ${maxSeconds}s`);
    await sleep(maxSeconds > 60 ? 15000 : 3000);
  }
}

/** urls: absolute public URLs of the post's media. Returns {id, permalink}. */
async function publish(pageKey, post, urls) {
  const c = creds(pageKey);
  if (!c) throw new Error(`missing IG_USER_ID_${pageKey.toUpperCase()} / IG_TOKEN_${pageKey.toUpperCase()} secrets`);
  let creation;
  if (post.format === "image") {
    creation = (await call("POST", `${c.id}/media`, { image_url: urls[0], caption: post.caption }, c.token)).id;
    await waitFinished(creation, c.token, 60);
  } else if (post.format === "carousel") {
    const kids = [];
    for (const u of urls.slice(0, 20)) kids.push((await call("POST", `${c.id}/media`, { image_url: u, is_carousel_item: "true" }, c.token)).id);
    for (const k of kids) await waitFinished(k, c.token, 60);
    creation = (await call("POST", `${c.id}/media`, { media_type: "CAROUSEL", children: kids.join(","), caption: post.caption }, c.token)).id;
    await waitFinished(creation, c.token, 60);
  } else if (post.format === "reel") {
    const params = { media_type: "REELS", video_url: urls[0], caption: post.caption, share_to_feed: "true" };
    if (urls[1]) params.cover_url = urls[1];
    creation = (await call("POST", `${c.id}/media`, params, c.token)).id;
    await waitFinished(creation, c.token, 360);
  } else throw new Error(`unknown format ${post.format}`);
  const pub = await call("POST", `${c.id}/media_publish`, { creation_id: creation }, c.token);
  let permalink = null;
  try { permalink = (await call("GET", pub.id, { fields: "permalink" }, c.token)).permalink; } catch (e) { log("permalink lookup failed:", e.message); }
  return { id: pub.id, permalink };
}

/** Insights for one media item. Tries the full metric set, then a smaller one. */
async function insights(pageKey, mediaId) {
  const c = creds(pageKey); if (!c) return null;
  for (const metric of ["reach,likes,comments,shares,saved,views", "reach,likes,comments,shares,saved", "reach,likes,comments"]) {
    try {
      const j = await call("GET", `${mediaId}/insights`, { metric }, c.token);
      const out = {};
      for (const d of j.data || []) out[d.name] = d.total_value?.value ?? d.values?.[0]?.value ?? 0;
      return out;
    } catch (e) { if (!/metric/i.test(e.message)) throw e; }
  }
  return null;
}

async function refreshToken(token) {
  if (isSystemUserToken(token)) return { access_token: token, expires_in: 0, neverExpires: true };
  const url = new URL(`${baseFor(token)}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token"); url.searchParams.set("access_token", token);
  const r = await fetch(url); const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`refresh failed: ${j.error?.message || r.status}`);
  return j; // {access_token, token_type, expires_in}
}

module.exports = { publish, insights, refreshToken, creds, isSystemUserToken };
