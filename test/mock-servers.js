// Local stand-ins for the Claude API, Instagram API, GitHub contents API and the Pages media host.
// Used only by test/run-tests.js.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const WORDS = {
  gym: ["leg day", "pre-workout", "protein shake", "squat rack", "rest day", "bulking", "gym crush", "foam roller", "deadlift", "mirror selfie", "6 AM alarm", "spotter", "shaker bottle", "cardio", "PR attempt"],
  anime: ["filler arc", "power level", "training montage", "side character", "season finale", "manhwa chapter", "plot armor", "villain monologue", "opening song", "cliffhanger", "beach episode", "time skip", "tournament arc", "rival", "sensei"],
  money: ["portfolio", "payday", "budget app", "rent day", "savings account", "market dip", "index fund", "impulse buy", "coffee habit", "credit score", "tax refund", "subscription", "paycheck", "piggy bank", "red candle"],
  shitpost: ["group chat", "alarm clock", "Monday meeting", "laundry pile", "social battery", "voice note", "3 AM thoughts", "inbox", "weekend plans", "snooze button", "leftovers", "small talk", "unread texts", "to-do list", "nap"],
};
function pageFromSystem(sys) { const m = /about ([^.]+)\./.exec(sys || ""); const t = (m ? m[1] : "").toLowerCase(); return t.includes("gym") ? "gym" : t.includes("anime") ? "anime" : t.includes("finance") ? "money" : "shitpost"; }

function claudeHandler(body, log) {
  const tool = body.tools[0].name, raw0 = body.messages[0].content;
  if (tool === "pick_clips") {
    const n = raw0.filter((c) => c.type === "image").length;
    log.picks = (log.picks || 0) + 1; log.pickImages = (log.pickImages || 0) + n;
    const keep = Array.from({ length: Math.min(5, n) }, (_, k) => ({ i: k + 1, desc: `man in suit stares at camera in shock, shot ${k + 1}`, pages: ["gym", "anime", "money", "shitpost", "bogus"], fit: k === 4 ? 4 : 8, idea: "me when the pre-workout kicks in", stillOk: true }));
    return { content: [{ type: "tool_use", id: "t3", name: tool, input: { keep } }], usage: { input_tokens: 9000, output_tokens: 700 } };
  }
  const prompt = raw0;
  if (tool === "submit_memes") {
    const page = pageFromSystem(body.system), w = WORDS[page];
    const m = /Write (\d+) (IMAGE|CAROUSEL|REEL)/.exec(prompt), n = +m[1], kind = m[2];
    const clipMenu = [...prompt.matchAll(/^- (ia-[\w-]+): /gm)].map((x) => x[1]);
    const menu = [...prompt.matchAll(/^- ([\w-]+): (.+?), (\d+) (?:lines|boxes)/gm)].map((x) => ({ id: x[1], name: x[2], lines: +x[3] }));
    log.memeMenus = (log.memeMenus || []).concat(kind === "IMAGE" ? [menu.map((t) => t.id)] : []);
    const tpls = page === "money" ? ["classic", "pov", "nobody", "tweet", "system", "versus", "ticker"] : ["classic", "pov", "nobody", "tweet", "system", "versus"];
    const memes = Array.from({ length: n }, (_, i) => {
      const x = w[i % w.length], y = w[(i * 7 + 3) % w.length];
      const syl = ["ka", "zo", "mi", "ru", "te", "lo", "vu", "ne", "pa", "shi", "bo", "ga"], R = () => Math.floor(Math.random() * 1e6), word = () => { const k = R(); return syl[k % 12] + syl[(k >> 4) % 12] + syl[(k >> 8) % 12] + syl[(k >> 12) % 12]; };
      const u1 = word(), u2 = word(), u3 = word();
      const base = { a: `When ${u1} ${x} ${u2}`, b: `${u3} ${y} mode`, caption: `This one is about ${x}.`, inspiredBy: i % 3 ? "evergreen" : "Dates coming up" };
      if (kind === "IMAGE" && i % 3 === 2 && menu.length) { const t = menu[Math.floor(i / 3) % menu.length]; return { ...base, template: "meme", mt: t.id, ml: [`${u1} ${x}`, `${u2} ${y}`] }; }
      if (kind === "IMAGE" && i % 6 === 0 && clipMenu.length) return { ...base, template: "classic", visual: `${x} person close up`, still: clipMenu[(i / 6) % clipMenu.length] };
      if (kind === "IMAGE") { const t = tpls[i % tpls.length]; return { ...base, template: t, visual: `${x} person close up`, visual2: `${y} person relaxing`, ...(t === "versus" ? { l: ["What I planned", "What I did"] } : {}), ...(t === "ticker" ? { a: `$${x.replace(/\W/g, "").toUpperCase().slice(0, 8)} ▼ ${10 + i}%` } : {}) }; }
      if (kind === "CAROUSEL") return { ...base, visual: `${x} people`, a: `Types of ${u1} at the ${x}`, b: "", s: [`The ${u2} expert`, `The ${x} rookie`, `The one who forgot the ${u3}`, `You, reading this`] };
      return { ...base, footage: `${x} close up`, mood: ["dramatic", "hype", "chill", "sad", "funny"][i % 5], sfx: "vine boom", ...(i % 2 === 0 && clipMenu.length ? { clip: clipMenu[(i / 2) % clipMenu.length] } : {}) };
    });
    return { content: [{ type: "tool_use", id: "t1", name: tool, input: { memes } }], usage: { input_tokens: 1200, output_tokens: 3000 } };
  }
  const nums = [...prompt.matchAll(/^(\d+)\. \[/gm)].map((x) => +x[1]);
  return { content: [{ type: "text", text: "Here are the scores." }, { type: "tool_use", id: "t2", name: tool, input: { scores: nums.map((i) => ({ i, score: 4 + ((i * 37) % 60) / 10, reason: "solid, specific setup" })) } }], usage: { input_tokens: 2000, output_tokens: 800 } };
}

function start({ siteDir, ghRoot, assetDir }) {
  const log = { claude: 0, ig: [], ghPuts: [] };
  let n = 1000;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code, obj, headers = {}) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", ...headers }); res.end(JSON.stringify(obj)); };
      const u = new URL(req.url, "http://x");
      if (req.method === "OPTIONS") return send(204, {});
      // Pixabay stand-in: photos at /pixabay/api/, videos at /pixabay/api/videos/, files at /assets/*
      if (u.pathname === "/pixabay/api/" || u.pathname === "/pixabay/api") {
        log.pixabayImg = (log.pixabayImg || 0) + 1;
        return send(200, { hits: [1, 2, 3].map((k) => ({ id: k, largeImageURL: `http://127.0.0.1:${server.address().port}/assets/photo${k}.jpg`, pageURL: `https://pixabay.example/photo/${k}` })) });
      }
      if (u.pathname === "/pixabay/api/videos/" || u.pathname === "/pixabay/api/videos") {
        return send(200, { hits: [1, 2].map((k) => ({ id: k, duration: 6, pageURL: `https://pixabay.example/video/${k}`, videos: { large: { url: `http://127.0.0.1:${server.address().port}/assets/clip${k}.mp4`, width: 1080, height: 1920 } } })) });
      }
      // Internet Archive stand-in
      if (u.pathname === "/archive/advancedsearch.php") {
        log.iaSearch = (log.iaSearch || []).concat([u.searchParams.get("q")]);
        return send(200, { response: { numFound: 2, docs: [
          { identifier: "film_nc", title: "Not Free", licenseurl: "http://creativecommons.org/licenses/by-nc/3.0/", collection: ["prelinger"], downloads: 9e6 },
          { identifier: "film_one", title: "Your Posture Counts", year: "1952", collection: ["prelinger"], downloads: 1e6 },
        ] } });
      }
      if (u.pathname.startsWith("/archive/metadata/")) {
        const id = u.pathname.split("/").pop(), f = path.join(assetDir, "film.mp4");
        return send(200, { metadata: { identifier: id, title: "Your Posture Counts", year: "1952" }, files: [{ name: `${id}.ogv`, format: "Ogg Video", size: "999" }, { name: `${id}_512kb.mp4`, format: "512Kb MPEG4", size: String(fs.statSync(f).size) }] });
      }
      if (u.pathname.startsWith("/archive/download/")) {
        log.iaDownloads = (log.iaDownloads || []).concat([u.pathname]);
        res.writeHead(200, { "content-type": "video/mp4" }); return fs.createReadStream(path.join(assetDir, "film.mp4")).pipe(res);
      }
      // Imgflip stand-in
      if (u.pathname === "/imgflip/get_memes") {
        return send(200, { success: true, data: { memes: [["181913649", "Drake Hotline Bling", 2, 900000], ["87743020", "Two Buttons", 3, 700000], ["112126428", "Distracted Boyfriend", 3, 800000], ["99999", "Sad Biden", 2, 5000]].map(([id, name, box_count, captions]) => ({ id, name, url: `https://i.imgflip.com/${id}.jpg`, width: 600, height: 600, box_count, captions })) } });
      }
      if (u.pathname === "/imgflip/search_memes") {
        if (req.headers.authorization !== "Bearer test-imgflip") return send(200, { success: false, error_message: "Invalid API key" });
        return send(200, { success: true, data: { memes: [{ id: "555", name: "Gym Mirror Guy", box_count: 2, captions: 4000 }, { id: "556", name: "Obscure Thing", box_count: 2, captions: 3 }] } });
      }
      if (u.pathname === "/imgflip/caption_image") {
        const params = new URLSearchParams(raw);
        log.imgflipCaptions = (log.imgflipCaptions || []).concat([{ auth: req.headers.authorization, params: Object.fromEntries(params) }]);
        if (req.headers.authorization !== "Bearer test-imgflip") return send(200, { success: false, error_message: "Invalid API key" });
        if (!params.get("boxes[0][text]")) return send(200, { success: false, error_message: "No texts specified" });
        return send(200, { success: true, data: { url: `http://127.0.0.1:${server.address().port}/assets/meme.png`, page_url: "https://imgflip.example/i/abc" } });
      }
      // Memegen stand-in
      if (u.pathname === "/memegen/templates/" || u.pathname === "/memegen/templates") {
        return send(200, [["drake", "Drakeposting", 2], ["db", "Distracted Boyfriend", 3], ["fine", "This is Fine", 2]].map(([id, name, lines]) => ({ id, name, lines, keywords: [] })));
      }
      if (u.pathname.startsWith("/memegen/images/") && assetDir) {
        log.memegen = (log.memegen || 0) + 1;
        res.writeHead(200, { "content-type": "image/png" }); return fs.createReadStream(path.join(assetDir, "meme.png")).pipe(res);
      }
      // Freesound stand-in
      if (u.pathname.startsWith("/freesound/search/text")) {
        log.freesound = (log.freesound || 0) + 1;
        const q = u.searchParams; if (!/Creative Commons 0/.test(q.get("filter") || "")) return send(400, { detail: "expected CC0 filter" });
        return send(200, { results: [1, 2].map((k) => ({ id: k, name: `boom${k}`, duration: 1, previews: { "preview-hq-mp3": `http://127.0.0.1:${server.address().port}/assets/sfx.mp3` } })) });
      }
      if (u.pathname.startsWith("/assets/") && assetDir) {
        const f = path.join(assetDir, path.basename(u.pathname));
        if (fs.existsSync(f)) { res.writeHead(200, { "content-type": f.endsWith(".mp4") ? "video/mp4" : f.endsWith(".mp3") ? "audio/mpeg" : f.endsWith(".png") ? "image/png" : "image/jpeg" }); return fs.createReadStream(f).pipe(res); }
      }
      // Claude
      if (u.pathname === "/v1/messages") { log.claude++; return send(200, claudeHandler(JSON.parse(raw), log)); }
      // Instagram
      if (u.pathname.startsWith("/v27.0/")) {
        const parts = u.pathname.split("/").slice(2), params = Object.fromEntries(new URLSearchParams(raw || u.search));
        log.ig.push({ method: req.method, path: parts.join("/"), params });
        if (req.method === "POST" && parts[1] === "media") {
          if (params.image_url && !/\.jpg/.test(params.image_url)) return send(400, { error: { message: "Only JPEG images are supported", code: 9004 } });
          return send(200, { id: String(++n) });
        }
        if (req.method === "POST" && parts[1] === "media_publish") return send(200, { id: "IG" + ++n });
        if (req.method === "GET" && params.fields === "status_code,status") return send(200, { status_code: "FINISHED" });
        if (req.method === "GET" && params.fields === "permalink") return send(200, { permalink: `https://www.instagram.com/p/${parts[0]}/` });
        if (req.method === "GET" && parts[1] === "insights") return send(200, { data: [{ name: "reach", values: [{ value: 1000 }] }, { name: "shares", values: [{ value: 42 }] }, { name: "saved", values: [{ value: 9 }] }, { name: "likes", values: [{ value: 120 }] }] });
        return send(404, { error: { message: "mock: unknown" } });
      }
      // GitHub contents API (for the review app)
      const gm = /^\/repos\/[^/]+\/[^/]+\/contents\/(.*)$/.exec(u.pathname);
      if (gm) {
        const rel = decodeURIComponent(gm[1]), branch = u.searchParams.get("ref") || (raw ? JSON.parse(raw).branch : "main");
        const root = branch === "media" ? siteDir : ghRoot, file = path.join(root, rel);
        if (req.method === "GET") {
          if (!fs.existsSync(file)) return send(404, { message: "Not Found" });
          if (fs.statSync(file).isDirectory()) return send(200, fs.readdirSync(file).map((name) => ({ name, type: fs.statSync(path.join(file, name)).isDirectory() ? "dir" : "file" })));
          const buf = fs.readFileSync(file);
          return send(200, { content: buf.toString("base64"), sha: require("crypto").createHash("sha1").update(buf).digest("hex") });
        }
        if (req.method === "PUT") {
          const b = JSON.parse(raw), buf = Buffer.from(b.content, "base64");
          if (fs.existsSync(file) && b.sha) { const cur = require("crypto").createHash("sha1").update(fs.readFileSync(file)).digest("hex"); if (cur !== b.sha) return send(409, { message: "sha mismatch" }); }
          fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf);
          log.ghPuts.push({ rel, branch: b.branch, bytes: buf.length });
          return send(200, { content: { sha: require("crypto").createHash("sha1").update(buf).digest("hex") } });
        }
      }
      // Static media / review site (Pages stand-in)
      const f = path.join(siteDir, decodeURIComponent(u.pathname.replace(/^\/site\//, "/")) );
      if (u.pathname.startsWith("/site/") && fs.existsSync(f) && fs.statSync(f).isFile()) {
        const ext = path.extname(f), type = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png", ".mp4": "video/mp4", ".otf": "font/otf", ".ttf": "font/ttf" }[ext] || "application/octet-stream";
        res.writeHead(200, { "content-type": type, "content-length": fs.statSync(f).size });
        return req.method === "HEAD" ? res.end() : fs.createReadStream(f).pipe(res);
      }
      send(404, { message: "mock: not found " + u.pathname });
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port, log })));
}

module.exports = { start };
