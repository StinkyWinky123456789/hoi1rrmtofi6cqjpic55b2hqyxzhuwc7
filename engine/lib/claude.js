// Minimal Claude Messages API client with retries and a forced-JSON tool.
"use strict";
const { log, sleep } = require("./util");

const BASE = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");

/**
 * Ask Claude to return structured data by calling `toolName` with `schema`.
 * Returns the tool input object.
 */
async function askJSON({ model, system, prompt, toolName, toolDescription, schema, maxTokens = 16000 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const body = {
    model, max_tokens: maxTokens, system,
    messages: [{ role: "user", content: prompt }],
    tools: [{ name: toolName, description: toolDescription, input_schema: schema }],
    tool_choice: { type: "auto" },
  };
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await fetch(`${BASE}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 429 || r.status === 529 || r.status >= 500) throw Object.assign(new Error(`Claude API ${r.status}: ${j.error?.message || ""}`), { retry: true });
      if (!r.ok) throw new Error(`Claude API ${r.status}: ${j.error?.message || JSON.stringify(j).slice(0, 300)}`);
      const use = (j.content || []).find((c) => c.type === "tool_use" && c.name === toolName);
      if (use) return { data: use.input, usage: j.usage };
      // Fallback: JSON in a text block
      const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const m = text.match(/\{[\s\S]*\}/);
      if (m) return { data: JSON.parse(m[0]), usage: j.usage };
      throw Object.assign(new Error("Claude did not return structured output"), { retry: true });
    } catch (e) {
      lastErr = e;
      if (!e.retry && !/fetch failed|ECONN|ETIMEDOUT/.test(e.message)) throw e;
      const wait = Math.min(60000, 4000 * 2 ** (attempt - 1));
      log(`${e.message}; retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

module.exports = { askJSON };
