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
  relatable: ["group chat", "alarm clock", "Monday meeting", "laundry pile", "social battery", "voice note", "3 AM thoughts", "inbox", "weekend plans", "snooze button", "leftovers", "small talk", "unread texts", "to-do list", "nap"],
};
function pageFromSystem(sys) { const m = /about ([^.]+)\./.exec(sys || ""); const t = (m ? m[1] : "").toLowerCase(); return t.includes("gym") ? "gym" : t.includes("anime") ? "anime" : t.includes("finance") ? "money" : "relatable"; }

function claudeHandler(body) {
  const tool = body.tools[0].name, prompt = body.messages[0].content;
  if (tool === "submit_memes") {
    const page = pageFromSystem(body.system), w = WORDS[page];
    const m = /Write (\d+) (IMAGE|CAROUSEL|REEL)/.exec(prompt), n = +m[1], kind = m[2];
    const tpls = page === "money" ? ["classic", "pov", "nobody", "tweet", "system", "versus", "ticker"] : ["classic", "pov", "nobody", "tweet", "system", "versus"];
    const memes = Array.from({ length: n }, (_, i) => {
      const x = w[i % w.length], y = w[(i * 7 + 3) % w.length];
      const syl = ["ka", "zo", "mi", "ru", "te", "lo", "vu", "ne", "pa", "shi", "bo", "ga"], R = () => Math.floor(Math.random() * 1e6), word = () => { const k = R(); return syl[k % 12] + syl[(k >> 4) % 12] + syl[(k >> 8) % 12] + syl[(k >> 12) % 12]; };
      const u1 = word(), u2 = word(), u3 = word();
      const base = { a: `When ${u1} ${x} ${u2}`, b: `${u3} ${y} mode`, caption: `This one is about ${x}.`, inspiredBy: i % 3 ? "evergreen" : "Dates coming up" };
      if (kind === "IMAGE") { const t = tpls[i % tpls.length]; return { ...base, template: t, ...(t === "versus" ? { l: ["What I planned", "What I did"] } : {}), ...(t === "ticker" ? { a: `$${x.replace(/\W/g, "").toUpperCase().slice(0, 8)} ▼ ${10 + i}%` } : {}) }; }
      if (kind === "CAROUSEL") return { ...base, a: `Types of ${u1} at the ${x}`, b: "", s: [`The ${u2} expert`, `The ${x} rookie`, `The one who forgot the ${u3}`, `You, reading this`] };
      return { ...base, footage: `${x} close up`, mood: ["dramatic", "hype", "chill", "sad", "funny"][i % 5] };
    });
    return { content: [{ type: "tool_use", id: "t1", name: tool, input: { memes } }], usage: { input_tokens: 1200, output_tokens: 3000 } };
  }
  const nums = [...prompt.matchAll(/^(\d+)\. \[/gm)].map((x) => +x[1]);
  return { content: [{ type: "text", text: "Here are the scores." }, { type: "tool_use", id: "t2", name: tool, input: { scores: nums.map((i) => ({ i, score: 4 + ((i * 37) % 60) / 10, reason: "solid, specific setup" })) } }], usage: { input_tokens: 2000, output_tokens: 800 } };
}

function start({ siteDir, ghRoot }) {
  const log = { claude: 0, ig: [], ghPuts: [] };
  let n = 1000;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code, obj, headers = {}) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", ...headers }); res.end(JSON.stringify(obj)); };
      const u = new URL(req.url, "http://x");
      if (req.method === "OPTIONS") return send(204, {});
      // Claude
      if (u.pathname === "/v1/messages") { log.claude++; return send(200, claudeHandler(JSON.parse(raw))); }
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
