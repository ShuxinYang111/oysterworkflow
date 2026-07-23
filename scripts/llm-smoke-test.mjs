#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// EN: Load ~/.codex/.env into process.env with optional forced overrides.
function loadEnvFile(envPath, forceKeys = []) {
  let raw = "";
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    const shouldOverride = forceKeys.includes(key);
    if (!process.env[key] || shouldOverride) {
      process.env[key] = value;
    }
  }
}

function resolveApiKey(config) {
  const direct = (config.apiKey || "").trim();
  if (direct) {
    const match = direct.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (!match) {
      return direct;
    }
    const envValue = (process.env[match[1]] || "").trim();
    if (envValue) {
      return envValue;
    }
  }
  if (config.apiKeyEnv) {
    const envValue = (process.env[String(config.apiKeyEnv)] || "").trim();
    if (envValue) {
      return envValue;
    }
  }
  return "";
}

function collectReferencedEnvKeys(config) {
  const keys = new Set();
  const direct = (config.apiKey || "").trim();
  const directMatch = direct.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (directMatch) {
    keys.add(directMatch[1]);
  }
  if (typeof config.apiKeyEnv === "string" && config.apiKeyEnv.trim()) {
    keys.add(config.apiKeyEnv.trim());
  }
  return [...keys];
}

function resolveConfigPath(projectRootDir) {
  const localConfigPath = path.resolve(
    projectRootDir,
    "config",
    "llm.local.json",
  );
  if (fs.existsSync(localConfigPath)) {
    return localConfigPath;
  }
  return path.resolve(projectRootDir, "config", "llm.config.json");
}

function buildLargePrompt() {
  const events = [];
  for (let index = 0; index < 120; index += 1) {
    events.push({
      id: `e${index + 1}`,
      tsIso: `2026-03-10T00:00:${String(index % 60).padStart(2, "0")}Z`,
      eventType: "ocr",
      appName: "Google Chrome",
      windowName: "Sample Window",
      textContent: `Sample text block ${index + 1} with additional context for testing.`,
    });
  }
  return [
    'Reply with a JSON object {"ok":true,"eventsCount":120}.',
    "Context:",
    JSON.stringify({ events }, null, 2),
  ].join("\n");
}

async function readTextWithTimeout(response, timeoutMs) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("read timeout")), timeoutMs);
  });
  try {
    const text = await Promise.race([response.text(), timeoutPromise]);
    return String(text);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function runTest(input) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });

    const status = response.status;
    let snippet = "";
    try {
      const raw = await readTextWithTimeout(response, input.timeoutMs);
      snippet = raw.replace(/\s+/g, " ").slice(0, 300);
    } catch (error) {
      snippet = `read-error:${error instanceof Error ? error.message : String(error)}`;
      try {
        await response.body?.cancel();
      } catch {
        // best-effort
      }
    }

    return {
      name: input.name,
      ok: response.ok,
      status,
      ms: Date.now() - startedAt,
      snippet,
    };
  } catch (error) {
    return {
      name: input.name,
      ok: false,
      status: 0,
      ms: Date.now() - startedAt,
      snippet: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

const projectRootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const configPath = resolveConfigPath(projectRootDir);
const rawConfig = fs.readFileSync(configPath, "utf8");
const config = JSON.parse(rawConfig);
loadEnvFile(
  path.join(process.env.HOME || "", ".codex", ".env"),
  collectReferencedEnvKeys(config),
);

const apiKey = resolveApiKey(config);
if (!apiKey) {
  console.error("NO_API_KEY_RESOLVED");
  process.exit(1);
}

const baseUrl = String(config.baseUrl || "").replace(/\/+$/, "");
const model = String(config.model || "");
if (!baseUrl || !model) {
  console.error("MISSING_BASEURL_OR_MODEL");
  process.exit(1);
}

const systemPrompt = "You are a test harness.";
const smallUser = 'Reply with a JSON object {"ok":true}.';
const largeUser = buildLargePrompt();

const tests = [
  {
    name: "responses/xhigh/small",
    url: `${baseUrl}/responses`,
    timeoutMs: 30_000,
    body: {
      model,
      stream: true,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }],
        },
        { role: "user", content: [{ type: "input_text", text: smallUser }] },
      ],
      text: { format: { type: "json_object" } },
      reasoning: { effort: "xhigh" },
    },
  },
  {
    name: "responses/xhigh/large",
    url: `${baseUrl}/responses`,
    timeoutMs: 90_000,
    body: {
      model,
      stream: true,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }],
        },
        { role: "user", content: [{ type: "input_text", text: largeUser }] },
      ],
      text: { format: { type: "json_object" } },
      reasoning: { effort: "xhigh" },
    },
  },
  {
    name: "responses/high/large",
    url: `${baseUrl}/responses`,
    timeoutMs: 90_000,
    body: {
      model,
      stream: true,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }],
        },
        { role: "user", content: [{ type: "input_text", text: largeUser }] },
      ],
      text: { format: { type: "json_object" } },
      reasoning: { effort: "high" },
    },
  },
  {
    name: "responses/medium/large",
    url: `${baseUrl}/responses`,
    timeoutMs: 90_000,
    body: {
      model,
      stream: true,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }],
        },
        { role: "user", content: [{ type: "input_text", text: largeUser }] },
      ],
      text: { format: { type: "json_object" } },
      reasoning: { effort: "medium" },
    },
  },
  {
    name: "chat/large",
    url: `${baseUrl}/chat/completions`,
    timeoutMs: 90_000,
    body: {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: largeUser },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    },
  },
];

console.log(`configPath=${configPath}`);
console.log(`baseUrl=${baseUrl}`);
console.log(`model=${model}`);

for (const test of tests) {
  const result = await runTest({
    ...test,
    apiKey,
  });
  console.log(
    `${result.name} status=${result.status} ok=${result.ok} ms=${result.ms} snippet=${result.snippet}`,
  );
}
