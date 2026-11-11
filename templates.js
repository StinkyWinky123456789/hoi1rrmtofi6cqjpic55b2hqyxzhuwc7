/* Meme Engine - shared canvas templates.
 * Used by engine/render.html (headless Chrome in GitHub Actions) and review/index.html (live preview).
 * Exposes window.MemeTemplates.
 *
 * A "page" is a brand from config/pages.json. A "post" has:
 *   format: "image" | "carousel" | "reel"
 *   template: classic | pov | nobody | tweet | system | versus | ticker   (carousel/reel ignore it)
 *   a, b: text fields; l: [label1, label2] (versus); s: [slide texts] (carousel)
 */
(function (global) {
  "use strict";

  const inter = (w, n) => `${w} ${n}px Inter, "Helvetica Neue", Arial, sans-serif`;
  const mono = (w, n) => `${w} ${n}px "JetBrains Mono", Consolas, ui-monospace, monospace`;
  const headFont = (t, n) => `${t.headW} ${n}px "${t.head}", ${t.headFb ? t.headFb + ", " : ""}Impact, "Arial Black", sans-serif`;
  const up = (t, s) => (t.upper ? String(s).toUpperCase() : String(s));
  function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }

  function wrap(c, text, maxW) {
    const out = [];
    String(text).split("\n").forEach((par) => {
      const words = par.split(/[ \t]+/).filter(Boolean);
      let line = "";
      if (!words.length) { out.push(""); return; }
      words.forEach((w) => {
        const test = line ? line + " " + w : w;
        if (c.measureText(test).width > maxW && line) { out.push(line); line = w; } else line = test;
      });
      out.push(line);
    });
    return out;
  }
  function fit(c, text, font, maxW, maxH, start, min, lh) {
    for (let n = Math.round(start); n >= min; n -= 2) {
      c.font = font(n);
      const lines = wrap(c, text, maxW);
      const widest = Math.max(0, ...lines.map((l) => c.measureText(l).width));
      if (lines.length * n * lh <= maxH && widest <= maxW) return { size: n, lines, h: lines.length * n * lh, font: font(n) };
    }
    c.font = font(min);
    const lines = wrap(c, text, maxW);
    return { size: min, lines, h: lines.length * min * lh, font: font(min) };
  }
  function draw(c, f, x, y, lh, align, fill, stroke) {
    c.font = f.font; c.textAlign = align; c.textBaseline = "top";
    f.lines.forEach((l, i) => {
      const yy = y + i * f.size * lh + ((lh - 1) * f.size) / 2;
      if (stroke) { c.lineJoin = "round"; c.miterLimit = 2; c.lineWidth = f.size * 0.16; c.strokeStyle = stroke; c.strokeText(l, x, yy); }
      c.fillStyle = fill; c.fillText(l, x, yy);
    });
  }
  function rr(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function cover(c, img, x, y, w, h, r) {
    c.save(); rr(c, x, y, w, h, r || 0); c.clip();
    const k = Math.max(w / img.width, h / img.height), iw = img.width * k, ih = img.height * k;
    c.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih); c.restore();
  }
  function hash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) {
    return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function trySpacing(c, v) { try { c.letterSpacing = v; } catch (e) { /* older canvas */ } }

  function bgFill(c, W, H, t) { c.fillStyle = t.bg; c.fillRect(0, 0, W, H); }
  function watermark(c, W, H, t) {
    const y = H - 58; c.font = inter(600, 30); c.textAlign = "center"; c.textBaseline = "middle";
    const tw = c.measureText(t.handle).width;
    c.fillStyle = t.accent; c.beginPath(); c.arc(W / 2 - tw / 2 - 18, y, 7, 0, Math.PI * 2); c.fill();
    c.fillStyle = t.muted; c.fillText(t.handle, W / 2 + 6, y);
  }
  function placeholder(c, x, y, w, h, t) {
    c.save(); rr(c, x, y, w, h, 28); c.clip();
    const g = c.createLinearGradient(x, y, x + w, y + h); g.addColorStop(0, t.card); g.addColorStop(1, t.bg);
    c.fillStyle = g; c.fillRect(x, y, w, h);
    c.strokeStyle = hexA(t.accent, 0.08); c.lineWidth = 18;
    for (let i = -h; i < w + h; i += 70) { c.beginPath(); c.moveTo(x + i, y); c.lineTo(x + i - h, y + h); c.stroke(); }
    c.font = headFont(t, Math.min(w, h) * 0.5); c.textAlign = "center"; c.textBaseline = "middle";
    c.fillStyle = hexA(t.accent, 0.12); c.fillText(t.mono, x + w / 2, y + h / 2);
    c.restore();
  }

  /* ---------- Feed templates ---------- */
  function tClassic(c, W, H, t, d, s) {
    bgFill(c, W, H, t);
    const pad = 64;
    let topText = d.a || "";
    if (d.tpl === "pov" && !/^pov/i.test(topText)) topText = "POV: " + topText;
    const top = fit(c, topText, (n) => inter(700, n), W - 2 * pad, H * 0.26, 64 * s, 28, 1.2);
    const topH = top.h + 100;
    draw(c, top, pad, 50, 1.2, "left", t.text);
    const ix = 40, iy = topH, iw = W - 80, ih = H - topH - 112;
    if (d.img) cover(c, d.img, ix, iy, iw, ih, 28); else placeholder(c, ix, iy, iw, ih, t);
    if (d.b) {
      const bt = fit(c, up(t, d.b), (n) => headFont(t, n), iw - 80, ih * 0.42, 100 * s, 34, 1.08);
      draw(c, bt, W / 2, iy + ih - bt.h - 40, 1.08, "center", "#ffffff", "#000000");
    }
    watermark(c, W, H, t);
  }
  function tNobody(c, W, H, t, d, s) {
    bgFill(c, W, H, t);
    const pad = 96, gap = 38;
    const fa = fit(c, d.a || "", (n) => inter(700, n), W - 2 * pad, H * 0.2, 56 * s, 26, 1.22);
    const fb = fit(c, d.b || "", (n) => inter(800, n), W - 2 * pad, H * (d.img ? 0.28 : 0.5), 86 * s, 32, 1.16);
    const imgH = d.img ? Math.max(200, Math.min(H * 0.42, H - 220 - fa.h - fb.h - gap * 2)) : 0;
    const total = fa.h + gap + fb.h + (d.img ? gap + imgH : 0);
    let y = Math.max(60, (H - 100 - total) / 2);
    draw(c, fa, pad, y, 1.22, "left", t.muted); y += fa.h + gap;
    c.fillStyle = t.accent; c.fillRect(pad - 34, y + 6, 10, Math.max(10, fb.h - 12));
    draw(c, fb, pad, y, 1.16, "left", t.text); y += fb.h;
    if (d.img) cover(c, d.img, pad - 34, y + gap, W - 2 * pad + 34, imgH, 24);
    watermark(c, W, H, t);
  }
  function tTweet(c, W, H, t, d, s) {
    bgFill(c, W, H, t);
    const cx = 60, cw = W - 120, ip = 56, av = 104;
    const ft = fit(c, d.a || "", (n) => inter(600, n), cw - 2 * ip, H * 0.46, 66 * s, 30, 1.28);
    const imgH = d.img ? Math.min(cw * 0.62, H - 520 - ft.h) : 0;
    const ch = ip + av + 40 + ft.h + (d.img && imgH > 120 ? 32 + imgH : 0) + ip;
    const cy = Math.max(50, (H - 90 - ch) / 2);
    c.save(); c.shadowColor = "rgba(0,0,0,.25)"; c.shadowBlur = 40; c.shadowOffsetY = 12;
    rr(c, cx, cy, cw, ch, 36); c.fillStyle = t.card; c.fill(); c.restore();
    c.fillStyle = t.accent; c.beginPath(); c.arc(cx + ip + av / 2, cy + ip + av / 2, av / 2, 0, Math.PI * 2); c.fill();
    c.font = headFont(t, 46); c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = t.accInk;
    c.fillText(t.mono, cx + ip + av / 2, cy + ip + av / 2 + 2);
    c.textAlign = "left"; c.textBaseline = "alphabetic";
    c.font = inter(800, 40); c.fillStyle = t.text; c.fillText(t.name, cx + ip + av + 26, cy + ip + 46);
    c.font = inter(500, 32); c.fillStyle = t.muted; c.fillText(t.handle, cx + ip + av + 26, cy + ip + 92);
    draw(c, ft, cx + ip, cy + ip + av + 40, 1.28, "left", t.text);
    if (d.img && imgH > 120) cover(c, d.img, cx + ip, cy + ip + av + 40 + ft.h + 32, cw - 2 * ip, imgH, 20);
    watermark(c, W, H, t);
  }
  function tSystem(c, W, H, t, d, s) {
    bgFill(c, W, H, t);
    if (d.img) { c.save(); c.globalAlpha = 0.28; cover(c, d.img, 0, 0, W, H, 0); c.restore(); }
    c.strokeStyle = hexA(t.accent, 0.07); c.lineWidth = 2;
    for (let x = 0; x < W; x += 60) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
    for (let y = 0; y < H; y += 60) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
    const px = 80, pw = W - 160, ip = 60;
    const fa = fit(c, d.a || "", (n) => inter(800, n), pw - 2 * ip, H * 0.32, 72 * s, 30, 1.2);
    const fb = d.b ? fit(c, d.b, (n) => inter(600, n), pw - 2 * ip, H * 0.2, 50 * s, 26, 1.25) : null;
    const ph = ip + 46 + 34 + fa.h + (fb ? 34 + fb.h : 0) + ip;
    const py = Math.max(60, (H - 90 - ph) / 2);
    c.save(); rr(c, px, py, pw, ph, 18); c.fillStyle = hexA(t.card, 0.92); c.fill();
    c.shadowColor = t.accent; c.shadowBlur = 44; c.lineWidth = 4; c.strokeStyle = t.accent; c.stroke(); c.restore();
    c.fillStyle = t.accent;
    const L = 46, T = 10, o = 10, xr = px + pw + o, yb = py + ph + o, xl = px - o, yt = py - o;
    c.fillRect(xl, yt, L, T); c.fillRect(xl, yt, T, L);
    c.fillRect(xr - L, yt, L, T); c.fillRect(xr - T, yt, T, L);
    c.fillRect(xl, yb - T, L, T); c.fillRect(xl, yb - L, T, L);
    c.fillRect(xr - L, yb - T, L, T); c.fillRect(xr - T, yb - L, T, L);
    c.font = headFont(t, 44); c.textAlign = "center"; c.textBaseline = "top"; c.fillStyle = t.accent;
    trySpacing(c, "10px"); c.fillText("NOTIFICATION", W / 2 + 5, py + ip - 6); trySpacing(c, "0px");
    c.fillStyle = hexA(t.accent, 0.5); c.fillRect(px + ip, py + ip + 58, pw - 2 * ip, 3);
    let y = py + ip + 46 + 34;
    draw(c, fa, W / 2, y, 1.2, "center", t.text); y += fa.h;
    if (fb) draw(c, fb, W / 2, y + 34, 1.25, "center", t.accent);
    watermark(c, W, H, t);
  }
  function tVersus(c, W, H, t, d, s) {
    bgFill(c, W, H, t);
    const x = 50, w = W - 100, top = 50, gap = 30, bottom = 112;
    const ph = (H - top - bottom - gap) / 2;
    const labels = d.l && d.l.length === 2 ? d.l : ["Expectation", "Reality"];
    [[labels[0], d.a, 0], [labels[1], d.b, 1]].forEach(([lab, txt, i]) => {
      const y = top + i * (ph + gap);
      rr(c, x, y, w, ph, 32);
      if (i === 1) { c.fillStyle = hexA(t.accent, 0.12); c.fill(); c.lineWidth = 4; c.strokeStyle = t.accent; c.stroke(); }
      else { c.fillStyle = t.card; c.fill(); }
      c.font = inter(800, 32);
      const L = String(lab || "").toUpperCase(), lw = c.measureText(L).width + 44;
      rr(c, x + 36, y + 36, lw, 58, 29); c.fillStyle = i === 1 ? t.accent : t.muted; c.fill();
      c.fillStyle = i === 1 ? t.accInk : t.bg; c.textAlign = "left"; c.textBaseline = "middle";
      c.fillText(L, x + 58, y + 66);
      const f = fit(c, up(t, txt || ""), (n) => (t.upper ? headFont(t, n) : inter(800, n)), w - 100, ph - 170, 84 * s, 30, 1.12);
      draw(c, f, W / 2, y + 110 + (ph - 110 - f.h) / 2 - 10, 1.12, "center", t.text);
    });
    watermark(c, W, H, t);
  }
  function tTicker(c, W, H, t, d, s) {
    bgFill(c, W, H, t);
    const a = String(d.a || "").replace(/ ([▲▼]) /g, " $1 ");
    const isDown = a.includes("▼");
    const col = isDown ? t.down || "#ff5a5a" : a.includes("▲") ? t.up || "#35d07f" : t.accent;
    c.fillStyle = "rgba(0,0,0,.28)"; c.fillRect(0, 0, W, 74);
    c.font = mono(500, 27); c.textAlign = "left"; c.textBaseline = "middle"; c.fillStyle = t.muted;
    c.fillText("▲ COFFEE +300%   ▼ SLEEP -41%   ▲ COPIUM +999%   ▼ MOTIVATION -88%   ▲ HOPE +2%", 24, 38);
    const pad = 70;
    const fa = fit(c, a, (n) => mono(700, n), W - 2 * pad, H * 0.2, 108 * s, 36, 1.12);
    draw(c, fa, pad, 130, 1.12, "left", col);
    const cy0 = 130 + fa.h + 50, chH = H * (H > 1400 ? 0.34 : 0.3), cx0 = pad, chW = W - 2 * pad;
    c.strokeStyle = "rgba(255,255,255,.07)"; c.lineWidth = 2;
    for (let i = 0; i <= 4; i++) { const y = cy0 + (chH * i) / 4; c.beginPath(); c.moveTo(cx0, y); c.lineTo(cx0 + chW, y); c.stroke(); }
    const r = rng(hash(a)), pts = [];
    let v = isDown ? 0.18 : 0.82;
    for (let i = 0; i < 42; i++) { v += (r() - 0.5) * 0.16 + (isDown ? 0.017 : -0.017); v = Math.max(0.04, Math.min(0.96, v)); pts.push([cx0 + (chW * i) / 41, cy0 + chH * v]); }
    const g = c.createLinearGradient(0, cy0, 0, cy0 + chH); g.addColorStop(0, hexA(col, 0.35)); g.addColorStop(1, hexA(col, 0));
    c.beginPath(); c.moveTo(pts[0][0], cy0 + chH); pts.forEach((p) => c.lineTo(p[0], p[1])); c.lineTo(pts.at(-1)[0], cy0 + chH); c.closePath(); c.fillStyle = g; c.fill();
    c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]))); c.strokeStyle = col; c.lineWidth = 7; c.lineJoin = "round"; c.stroke();
    const last = pts.at(-1); c.fillStyle = col; c.beginPath(); c.arc(last[0], last[1], 12, 0, Math.PI * 2); c.fill();
    if (d.b) { const fb = fit(c, d.b, (n) => inter(800, n), W - 2 * pad, H - (cy0 + chH + 60) - 120, 70 * s, 30, 1.16); draw(c, fb, pad, cy0 + chH + 60, 1.16, "left", t.text); }
    watermark(c, W, H, t);
  }
  const FEED = { classic: tClassic, pov: tClassic, nobody: tNobody, tweet: tTweet, system: tSystem, versus: tVersus, ticker: tTicker };

  /* ---------- Carousel ---------- */
  function slideList(post) { return [post.a || "", ...(post.s || []).filter((x) => String(x).trim()), "__cta__"]; }
  function tSlide(c, W, H, t, post, s, k) {
    bgFill(c, W, H, t);
    const list = slideList(post), n = list.length, pad = 90;
    c.font = inter(800, 30); c.textAlign = "left"; c.textBaseline = "top"; c.fillStyle = t.accent;
    c.fillText(t.name.toUpperCase(), pad, 64);
    if (k === 0) {
      const f = fit(c, up(t, list[0]), (n2) => (t.upper ? headFont(t, n2) : inter(800, n2)), W - 2 * pad, H * 0.55, 124 * s, 40, 1.08);
      const y = (H - f.h) / 2 - 30; draw(c, f, pad, y, 1.08, "left", t.text);
      c.fillStyle = t.accent; c.fillRect(pad, y + f.h + 30, 170, 12);
      c.font = inter(700, 34); c.textAlign = "right"; c.fillStyle = t.muted; c.textBaseline = "alphabetic"; c.fillText("SWIPE  →", W - pad, H - 130);
    } else if (list[k] === "__cta__") {
      c.fillStyle = t.accent; c.beginPath(); c.arc(W / 2, H / 2 - 150, 110, 0, Math.PI * 2); c.fill();
      c.font = headFont(t, 96); c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = t.accInk; c.fillText(t.mono, W / 2, H / 2 - 146);
      const fh = fit(c, "Follow " + t.handle, (n2) => inter(800, n2), W - 2 * pad, 90, 64, 36, 1.1);
      c.font = fh.font; c.fillStyle = t.text; c.fillText("Follow " + t.handle, W / 2, H / 2 + 30);
      c.font = inter(500, 40); c.fillStyle = t.muted; c.fillText("for daily " + t.noun + " memes", W / 2, H / 2 + 100);
    } else {
      c.font = mono(700, 40); c.fillStyle = t.accent; c.textAlign = "right"; c.textBaseline = "top"; c.fillText(k + "/" + (n - 2), W - pad, 60);
      const f = fit(c, list[k], (n2) => inter(800, n2), W - 2 * pad, H * 0.6, 86 * s, 30, 1.18);
      const y = (H - f.h) / 2 - 20;
      c.fillStyle = t.accent; c.fillRect(pad - 36, y + 8, 10, Math.max(10, f.h - 16));
      draw(c, f, pad, y, 1.18, "left", t.text);
    }
    watermark(c, W, H, t);
  }

  /* ---------- Reel text overlay (transparent) ---------- */
  function tOverlay(c, W, H, t, post, s) {
    c.clearRect(0, 0, W, H);
    let a = post.a || "";
    if (post.template === "pov" && a && !/^pov/i.test(a)) a = "POV: " + a;
    const fa = fit(c, up(t, a), (n) => headFont(t, n), W - 140, 560, 104 * s, 40, 1.08);
    draw(c, fa, W / 2, 250, 1.08, "center", "#ffffff", "#000000");
    c.font = inter(700, 32); c.textAlign = "center"; c.textBaseline = "top"; c.lineWidth = 7; c.strokeStyle = "rgba(0,0,0,.8)";
    c.strokeText(t.handle, W / 2, 250 + fa.h + 28); c.fillStyle = "#fff"; c.fillText(t.handle, W / 2, 250 + fa.h + 28);
    if (post.b) {
      const fb = fit(c, up(t, post.b), (n) => headFont(t, n), W - 140, 440, 92 * s, 36, 1.08);
      draw(c, fb, W / 2, H * 0.72 - fb.h, 1.08, "center", "#ffffff", "#000000");
    }
  }

  function renderProfile(c, W, t) {
    c.fillStyle = t.bg; c.fillRect(0, 0, W, W);
    c.strokeStyle = t.accent; c.lineWidth = 26; c.beginPath(); c.arc(W / 2, W / 2, W * 0.4, 0, Math.PI * 2); c.stroke();
    const f = fit(c, t.mono, (n) => headFont(t, n), W * 0.58, W * 0.42, 420, 120, 1);
    c.font = f.font; c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = t.text; c.fillText(t.mono, W / 2, W / 2 + f.size * 0.04);
    c.font = inter(800, 46); c.fillStyle = t.accent; trySpacing(c, "8px");
    c.fillText("MEMES", W / 2 + 4, W / 2 + W * 0.25); trySpacing(c, "0px");
  }

  const SIZES = { feed: [1080, 1350], square: [1080, 1080], story: [1080, 1920], reel: [1080, 1920] };

  /** Draw one frame of a post. kind: "feed" | "slide" | "overlay". */
  function drawPost(c, W, H, page, post, opts) {
    const o = opts || {}, s = o.scale || 1;
    if (o.kind === "overlay") return tOverlay(c, W, H, page, post, s);
    if (o.kind === "slide") return tSlide(c, W, H, page, post, s, o.slide || 0);
    const d = { tpl: post.template, a: post.a, b: post.b, l: post.l, img: o.img || null };
    (FEED[post.template] || tClassic)(c, W, H, page, d, s);
  }

  /** Which frames a post needs: [{kind, slide?, w, h, name}] */
  function framesFor(post) {
    if (post.format === "carousel") {
      return slideList(post).map((_, k) => ({ kind: "slide", slide: k, w: 1080, h: 1350, name: `${String(k + 1).padStart(2, "0")}` }));
    }
    if (post.format === "reel") return [{ kind: "overlay", w: 1080, h: 1920, name: "overlay" }];
    return [{ kind: "feed", w: 1080, h: 1350, name: "feed" }];
  }

  global.MemeTemplates = { drawPost, framesFor, slideList, renderProfile, SIZES, TEMPLATE_NAMES: Object.keys(FEED) };
})(typeof window !== "undefined" ? window : globalThis);
