// Generate next week's queue for every page:
//   signals -> Claude writes 2x candidates -> dedupe -> Claude judges -> best posts fill the slots.
// Usage: node engine/generate.js [YYYY-MM-DD week start] [--page gym] [--force]
"use strict";
const path = require("path");
const fs = require("fs");
const U = require("./lib/util");
const { askJSON } = require("./lib/claude");
const { collectSignals } = require("./collect");
const Memes = require("./lib/memes");

const TEMPLATE_GUIDE = `Image templates (the joke must work as text on a branded graphic; no photo is added):
- classic: "a" = caption bar on top, "b" = big punchline over the graphic.
- pov: "a" = the POV situation (without the word POV), "b" = short reaction/punchline (or "").
- nobody: "a" = setup line (e.g. "Nobody:", "Me at 3 AM:", "My boss:"), "b" = punchline.
- tweet: "a" = one punchy text post written lowercase-casual, "b" = "".
- system: video-game style notification. "a" = the event ("Quest failed: ..."), "b" = reward/penalty line.
- versus: two labeled panels. "l" = [top label, bottom label], "a" = top panel text, "b" = bottom panel text.
- ticker: (money page only) "a" = stock-ticker headline with ▲ or ▼ and a %, like "$SLEEP ▼ 40%", "b" = punchline.
- meme: a CLASSIC MEME TEMPLATE everyone recognizes. "mt" = template id from the list below, "ml" = exactly that template's number of text lines (each under 8 words, the joke lives in these), "a" = optional short caption above the image (or ""). Use the template the way the internet uses it (Drake = reject/prefer, Distracted Boyfriend = me / new thing / current thing, This Is Fine = calm in chaos...).`;

function buildSlots(cfg, key, weekStart) {
  const pg = cfg.pages[key], slots = [];
  for (let d = 0; d < 7; d++) {
    const ymd = U.addDays(weekStart, d), wd = U.weekday(ymd);
    pg.slots.slice(0, cfg.postsPerDay).forEach((time, i) => {
      const format = i === pg.reelSlot ? "reel" : (cfg.carouselDays.includes(wd) && i === pg.carouselSlot ? "carousel" : "image");
      slots.push({ ymd, time, index: i, format, at: U.zonedToUtc(ymd, time, cfg.timezone).toISOString() });
    });
  }
  return slots;
}

function signalText(sig) {
  const sec = (title, arr) => (arr && arr.length ? `${title}:\n${arr.map((x) => "- " + x).join("\n")}\n` : "");
  return [
    sec("Dates coming up", sig.holidays),
    sec("What the US is searching on Google right now", sig.trends),
    sec("Niche news this week", sig.niche),
    sec("What people in this niche are posting on X (TOPICS ONLY: never reuse their wording or jokes)", sig.x),
    sec("Our best performers recently (most DM sends per reach): do more like these", sig.performance?.top),
    sec("Our worst performers recently: avoid these angles", sig.performance?.bottom),
  ].join("\n");
}

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    memes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          template: { type: "string", description: "image template name (images only)" },
          a: { type: "string" }, b: { type: "string" },
          l: { type: "array", items: { type: "string" }, description: "versus labels" },
          s: { type: "array", items: { type: "string" }, description: "carousel slides" },
          footage: { type: "string", description: "reels: 3-6 word stock-footage search showing real people or things" },
          visual: { type: "string", description: "images and carousels: 3-6 word stock-photo search for the photo behind the joke (versus: the TOP panel's photo)" },
          visual2: { type: "string", description: "versus only: 3-6 word stock-photo search for the BOTTOM panel's photo" },
          mood: { type: "string", enum: ["dramatic", "hype", "chill", "sad", "funny"], description: "reels: audio mood" },
          sfx: { type: "string", description: "reels: 1-3 word sound effect that hits on the punchline" },
          caption: { type: "string", description: "one short caption line, no hashtags" },
          mt: { type: "string", description: "meme template id (template 'meme' only)" },
          ml: { type: "array", items: { type: "string" }, description: "meme template text lines (template 'meme' only)" },
          inspiredBy: { type: "string", description: "which signal inspired it, or 'evergreen'" },
        },
        required: ["a", "caption"],
      },
    },
  },
  required: ["memes"],
};

function systemPrompt(pg, key) {
  return `You are the head writer for "${pg.name}" (${pg.handle}), an Instagram meme page about ${pg.niche}.
Voice: ${pg.voice}.
Content pillars: ${pg.pillars.join("; ")}.
Page rules: ${pg.rules}

Hard rules for every meme:
- 100% original jokes. Trends and other people's posts are topics only; never copy or lightly reword someone else's joke.
- No real people, no copyrighted characters, no brand logos. ${key === "anime" ? "Show titles may be named in words." : "No brand or product names."}
- No engagement bait ("tag a friend", "like if", "comment YES", "send this to").
- Punch at situations, never at groups of people. Advertiser-safe: no slurs, sex, drugs or violence.
- Readable in one second: short, specific, concrete. A good meme makes the viewer think of ONE friend and DM it to them.
- Vary angles: don't repeat the same setup or punchline structure across memes.

Spice (this matters most):
- Be SPECIFIC, never general. Name the exact exercise, show, situation, time of day, number, or piece of niche slang. "Me when life is hard" is banned; "Me at 6 AM after two scoops of pre-workout" is the bar.
- Exaggerate hard, take a side, and lovingly roast the audience. Write like the funniest person in the group chat for this niche, not like a brand.
- Prefer insider jokes that only this niche gets over broad jokes anyone could make.
- Punchlines can be loud: caps, absurd escalation, deadpan understatement. Never bland.

Visual style for this page: ${pg.visualStyle || "real-world photos and footage that fit the niche"}

Example memes that set the bar (match this energy, never copy them):
${(pg.examples || []).map((x) => "- " + x).join("\n")}`;
}

async function writeCandidates(cfg, key, pg, sig, avoid, format, count) {
  const pieces = [];
  const memeList = format === "image" ? await Memes.templates() : [];
  const memeGuide = memeList.length ? `\nMeme templates you can use (id: name, number of lines, example):\n${memeList.map((t) => `- ${t.id}: ${t.name}, ${t.lines} lines, e.g. ${JSON.stringify(t.example)}`).join("\n")}` : "";
  for (let left = count; left > 0; left -= 25) {
    const n = Math.min(25, left);
    const spec = format === "image"
      ? `Write ${n} IMAGE memes. ${memeList.length ? "About 40% must be classic meme templates (template \"meme\"); spread the rest across " : "Mix "}the other templates (${key === "money" ? "classic, pov, nobody, tweet, system, versus, ticker" : "classic, pov, nobody, tweet, system, versus"}), no single format more than 40%.\n${TEMPLATE_GUIDE}${memeGuide}\nPHOTOS (required): EVERY non-template meme gets a "visual": a 3-6 word stock-photo search for the exact real photo that makes the joke hit (e.g. "bodybuilder flexing gym mirror", "man shocked staring at phone", "raccoon in trash can night"). Describe what's literally in the photo: people, action, place. versus memes also need "visual2" for the bottom panel, so the two photos contrast (e.g. "man sleeping couch" vs "bodybuilder lifting heavy").`
      : format === "carousel"
        ? `Write ${n} CAROUSEL memes: "a" = title slide (a list people want to save or send, like "Types of people at the gym"), "s" = 3 to 6 slides, each under 14 words. Leave "b" empty. "visual" (required) = a 2-4 word stock-photo search broad enough to return several different photos for the slides (e.g. "gym people lifting", "sports fans watching game").`
        : `Write ${n} REEL concepts (7-10 second vertical video: text over stock footage). "a" = on-screen hook under 12 words, readable instantly. "b" = payoff line under 12 words, or "". "footage" = a 3-6 word stock-footage search for real footage that matches the joke, showing people or things actually doing it (e.g. "muscular man deadlift gym", "sports fans cheering bar", "pigeon walking city street", "neon tokyo street night"). Describe literally what's on screen; no brands or famous people. "mood" = background music mood. "sfx" = the meme sound effect that hits exactly when the punchline appears: pick from "vine boom", "record scratch", "airhorn", "crowd gasp", "sad trombone", "dramatic sting", "cartoon boing", "glass shatter", "crowd laugh", "bruh", "ding", "explosion" or similar 1-3 word sounds. The video shows "a" first, then "b" lands with a zoom and the sound, so "b" must be the punchline.`;
    const prompt = `${signalText(sig)}
Recently used ideas (do NOT repeat these):
${avoid.slice(-60).map((x) => "- " + x).join("\n") || "- none yet"}

${spec}
Keep "a" under 90 characters and "b" under 100. Call submit_memes with all ${n}.`;
    const { data, usage } = await askJSON({ model: cfg.model, system: systemPrompt(pg, key), prompt, toolName: "submit_memes", toolDescription: "Submit the memes", schema: ITEM_SCHEMA });
    U.log(`${key}: Claude wrote ${data.memes?.length || 0} ${format} candidates (${usage?.input_tokens || "?"} in / ${usage?.output_tokens || "?"} out tokens)`);
    pieces.push(...(data.memes || []).map((m) => ({ ...m, format })));
  }
  return pieces;
}

/** If Claude forgets a photo search, use a safe niche default so every meme still gets a photo. */
const NICHE_PHOTO = { gym: "people lifting weights gym", anime: "neon city street night", money: "man stressed looking at phone", shitpost: "funny animal staring camera" };
function fallbackVisual(key) { return NICHE_PHOTO[key] || "people laughing"; }

let memeIds = new Map(); // id -> line count, filled before cleaning
function clean(m, key) {
  const str = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
  const out = { format: m.format, a: str(m.a, 120), b: str(m.b, 130), caption: str(m.caption, 300), inspiredBy: str(m.inspiredBy, 120) };
  if (m.format === "image") {
    if (m.template === "meme" && m.mt && memeIds.has(m.mt)) {
      out.template = "meme"; out.mt = m.mt;
      const n = memeIds.get(m.mt);
      out.ml = Array.from({ length: n }, (_, i) => str((m.ml || [])[i], 90));
      out.visual = ""; out.b = "";
      return out;
    }
    out.visual = str(m.visual, 70) || fallbackVisual(key, out);
    if (m.template === "versus") out.visual2 = str(m.visual2, 70) || out.visual;
    const allowed = key === "money" ? ["classic", "pov", "nobody", "tweet", "system", "versus", "ticker"] : ["classic", "pov", "nobody", "tweet", "system", "versus"];
    out.template = allowed.includes(m.template) ? m.template : "classic";
    if (out.template === "versus") out.l = (Array.isArray(m.l) && m.l.length >= 2 ? m.l.slice(0, 2) : ["Expectation", "Reality"]).map((x) => str(x, 40));
    if (out.template === "tweet") out.b = "";
  }
  if (m.format === "carousel") { out.s = (m.s || []).map((x) => str(x, 140)).filter(Boolean).slice(0, 6); out.b = ""; out.visual = str(m.visual, 70) || fallbackVisual(key, out); }
  if (m.format === "reel") { out.template = "classic"; out.footage = str(m.footage, 60) || "city night timelapse"; out.mood = m.mood || "funny"; out.sfx = str(m.sfx, 30) || "vine boom"; }
  return out;
}

async function judge(cfg, key, pg, cands) {
  const list = cands.map((c, i) => `${i}. [${c.format}${c.template ? "/" + c.template : ""}${c.mt ? " " + c.mt : ""}] ${U.postText(c)}`).join("\n");
  const prompt = `Score each meme for "${pg.name}" (${pg.niche}) from 1 to 10. Be a tough editor: most should land 4-7.
10 = people will DM it to a specific friend instantly; it's clear in one second; fresh angle; perfect for the page's voice.
Mark generic memes down hard: if the joke could appear on any meme page, or doesn't name a specific situation, thing or piece of niche slang, it scores 5 or lower. Reward specificity, edge and escalation.
Give 1 to anything that breaks the page rules, copies a known joke, needs context to understand, or isn't advertiser-safe.
Page rules: ${pg.rules}

${list}

Call submit_scores with a score and a 3-8 word reason for every number.`;
  const schema = { type: "object", properties: { scores: { type: "array", items: { type: "object", properties: { i: { type: "integer" }, score: { type: "number" }, reason: { type: "string" } }, required: ["i", "score"] } } }, required: ["scores"] };
  const { data } = await askJSON({ model: cfg.judgeModel, system: "You are a sharp, honest meme editor.", prompt, toolName: "submit_scores", toolDescription: "Submit scores", schema, maxTokens: 12000 });
  for (const s of data.scores || []) if (cands[s.i]) { cands[s.i].score = Math.max(0, Math.min(10, +s.score || 0)); cands[s.i].why = String(s.reason || "").slice(0, 80); }
  for (const c of cands) if (c.score == null) c.score = 0;
}

function dedupe(cands, history, xTexts) {
  const kept = [];
  for (const c of cands) {
    const t = U.postText(c);
    if (t.length < 8) continue;
    if (history.some((h) => U.jaccard(t, h) > 0.6)) continue;
    if (xTexts.some((x) => U.jaccard(t, x) > 0.5)) continue; // too close to someone else's post
    if (kept.some((k) => U.jaccard(t, U.postText(k)) > 0.55)) continue;
    kept.push(c);
  }
  return kept;
}

function assign(slots, cands, pg, cfg, key, weekId) {
  const pools = { image: [], carousel: [], reel: [] };
  for (const c of cands.sort((x, y) => y.score - x.score)) pools[c.format].push(c);
  const posts = [];
  let prevTpl = null;
  for (const s of slots) {
    const pool = pools[s.format].length ? pools[s.format] : pools.image; // fall back to an image if a format runs dry
    if (!pool.length) continue;
    let idx = pool.findIndex((c) => c.template !== prevTpl);
    if (idx < 0 || idx > 3) idx = 0; // don't sacrifice much quality for variety
    const c = pool.splice(idx, 1)[0];
    prevTpl = c.template;
    const id = `${key}-${s.ymd.replace(/-/g, "")}-${s.index + 1}`;
    posts.push({
      id, page: key, week: weekId, date: s.ymd, time: s.time, scheduledAt: s.at,
      format: c.format, template: c.template || null, a: c.a, b: c.b || "", l: c.l, s: c.s, mt: c.mt, ml: c.ml,
      footage: c.footage, mood: c.mood, sfx: c.sfx, sfxIndex: 0, footageIndex: 0, audioIndex: 0, customClip: null,
      visual: c.visual || "", visual2: c.visual2 || "", imageIndex: 0,
      caption: `${c.caption}\n\nFollow ${pg.handle} for daily ${pg.noun} memes.\n\n${pg.tags.slice(0, 5).join(" ")}`,
      score: c.score, why: c.why || "", inspiredBy: c.inspiredBy || "",
      status: "pending", needsRender: true, renderVersion: 0, approvedVersion: null,
      media: [], attempts: 0, lastError: null, igMediaId: null, postedAt: null,
    });
  }
  return posts;
}

async function generatePage(cfg, key, weekStart, signals, force) {
  const pg = cfg.pages[key], weekId = U.isoWeekId(weekStart), file = U.queueFile(weekId, key);
  // A week that was cleared out (or fully rejected) in the review queue regenerates without --force
  const live = fs.existsSync(file) ? U.readJSON(file, { posts: [] }).posts.filter((p) => !["rejected"].includes(p.status)) : [];
  if (fs.existsSync(file) && !force && live.length) { U.log(`${key}: ${weekId} already generated, skipping (use --force to redo)`); return null; }
  memeIds = new Map((await Memes.templates()).map((t) => [t.id, t.lines]));
  const slots = buildSlots(cfg, key, weekStart);
  const need = { image: 0, carousel: 0, reel: 0 };
  slots.forEach((s) => need[s.format]++);
  const histFile = path.join(U.ROOT, "state", `history-${key}.json`), history = U.readJSON(histFile, []);
  const sig = signals[key];
  let cands = [];
  for (const f of ["image", "carousel", "reel"]) {
    if (!need[f]) continue;
    const n = Math.ceil(need[f] * cfg.candidateMultiplier) + (f === "image" ? 2 : 1);
    cands.push(...(await writeCandidates(cfg, key, pg, sig, history.concat(cands.map(U.postText)), f, n)).map((m) => clean(m, key)));
  }
  const before = cands.length;
  cands = dedupe(cands, history, sig.x || []);
  U.log(`${key}: ${before} candidates, ${cands.length} after de-duplication`);
  await judge(cfg, key, pg, cands);
  cands = cands.filter((c) => c.score >= 3);
  // Top up any format that came up short (duplicates or low scores), up to two extra rounds
  for (let round = 1; round <= 2; round++) {
    const short = Object.keys(need).filter((f) => need[f] && cands.filter((c) => c.format === f).length < need[f]);
    if (!short.length) break;
    for (const f of short) {
      const missing = need[f] - cands.filter((c) => c.format === f).length;
      U.log(`${key}: short ${missing} ${f}(s); asking for more (round ${round})`);
      let extra = (await writeCandidates(cfg, key, pg, sig, history.concat(cands.map(U.postText)), f, Math.ceil(missing * 1.6) + 1)).map((m) => clean(m, key));
      extra = dedupe(extra, history.concat(cands.map(U.postText)), sig.x || []);
      if (extra.length) { await judge(cfg, key, pg, extra); cands.push(...extra.filter((c) => c.score >= 3)); }
    }
  }
  const posts = assign(slots, cands, pg, cfg, key, weekId);
  U.writeJSON(file, { week: weekId, page: key, weekStart, generatedAt: new Date().toISOString(), model: cfg.model, posts });
  U.writeJSON(histFile, history.concat(posts.map(U.postText)).slice(-600));
  const avg = posts.reduce((t, p) => t + p.score, 0) / (posts.length || 1);
  U.log(`${key}: queued ${posts.length}/${slots.length} posts for ${weekId}, average score ${avg.toFixed(1)}`);
  return posts;
}

async function main() {
  const args = process.argv.slice(2);
  const cfg = U.loadConfig();
  const weekStart = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || U.nextMonday(new Date(), cfg.timezone);
  const onlyPage = args.includes("--page") ? args[args.indexOf("--page") + 1] : null;
  const force = args.includes("--force");
  U.log(`Generating week of ${weekStart} (${U.isoWeekId(weekStart)})`);
  const signals = await collectSignals(cfg, weekStart);
  U.writeJSON(path.join(U.ROOT, "state", "signals", `${U.isoWeekId(weekStart)}.json`), signals);
  let failed = 0;
  for (const key of Object.keys(cfg.pages)) {
    if (onlyPage && key !== onlyPage) continue;
    try { await generatePage(cfg, key, weekStart, signals, force); }
    catch (e) { failed++; U.log(`${key}: generation failed: ${e.message}`); }
  }
  if (failed) process.exit(1);
}

module.exports = { buildSlots, dedupe, assign, clean };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
