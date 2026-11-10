// Instagram long-lived tokens last 60 days. This refreshes each page's token and, if a GH_PAT secret
// with "Secrets: write" is present, saves the new token back into the repo secrets automatically.
"use strict";
const { execFileSync } = require("child_process");
const U = require("./lib/util");
const IG = require("./lib/instagram");

(async () => {
  const cfg = U.loadConfig();
  let bad = 0;
  for (const key of Object.keys(cfg.pages)) {
    const name = `IG_TOKEN_${key.toUpperCase()}`, token = process.env[name];
    if (!token) { U.log(`${key}: no ${name} secret yet`); continue; }
    try {
      if (IG.isSystemUserToken(token)) { U.log(`${key}: Unified Login system-user token; it never expires, nothing to refresh`); continue; }
      const j = await IG.refreshToken(token);
      console.log(`::add-mask::${j.access_token}`);
      const days = Math.round((j.expires_in || 0) / 86400);
      if (process.env.GH_TOKEN) {
        execFileSync("gh", ["secret", "set", name, "--repo", process.env.GITHUB_REPOSITORY], { input: j.access_token, stdio: ["pipe", "inherit", "inherit"] });
        U.log(`${key}: token refreshed and saved (valid ${days} days)`);
      } else U.log(`${key}: token refreshed (valid ${days} days) but NOT saved: add a GH_PAT secret so it can be stored`);
    } catch (e) { bad++; U.log(`${key}: ${e.message}`); }
  }
  if (bad) process.exit(1);
})();
