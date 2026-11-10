// Download the open-source (OFL) display fonts from the Google Fonts repository into ./fonts.
// Inter ships with the repo. Skips files that already exist.
"use strict";
const fs = require("fs");
const path = require("path");

const BASE = "https://raw.githubusercontent.com/google/fonts/main/ofl/";
const FONTS = [
  ["anton/Anton-Regular.ttf", "Anton-Regular.ttf"],
  ["rajdhani/Rajdhani-Bold.ttf", "Rajdhani-Bold.ttf"],
  ["archivoblack/ArchivoBlack-Regular.ttf", "ArchivoBlack-Regular.ttf"],
  ["jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf", "JetBrainsMono.ttf"],
];

(async () => {
  const dir = path.resolve(__dirname, "..", "fonts");
  fs.mkdirSync(dir, { recursive: true });
  let failed = 0;
  for (const [src, name] of FONTS) {
    const dest = path.join(dir, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 10000) continue;
    try {
      const r = await fetch(BASE + src);
      if (!r.ok) throw new Error(`${r.status}`);
      fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
      console.log("font:", name);
    } catch (e) { failed++; console.warn(`font ${name} not downloaded (${e.message}); a fallback font will be used`); }
  }
  if (failed) console.warn(`${failed} font(s) missing`);
})();
