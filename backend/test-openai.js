const fs = require("fs");
const path = require("path");

loadEnv(path.join(__dirname, ".env"));

const apiKey = process.env.OPENAI_API_KEY || "";
const apiUrl = process.env.OPENAI_API_URL || "https://api.openai.com/v1/responses";
const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const timeoutMs = Number(process.env.PROVIDER_TIMEOUT_MS || 30000);

async function main() {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured in backend/.env.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    console.log(`Testing OpenAI connectivity to ${apiUrl}`);
    console.log(`Model: ${model}`);
    console.log(`Timeout: ${timeoutMs}ms`);

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        input: "Reply with exactly OK."
      }),
      signal: controller.signal
    });

    const text = await response.text();
    console.log(`HTTP ${response.status} ${response.statusText}`);
    console.log(text);

    if (!response.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error(`OpenAI request timed out after ${timeoutMs}ms.`);
      process.exitCode = 1;
      return;
    }

    const causeMessage =
      error instanceof Error && error.cause && typeof error.cause === "object" && "message" in error.cause
        ? String(error.cause.message)
        : error instanceof Error
          ? error.message
          : String(error);

    console.error(`OpenAI connectivity test failed: ${causeMessage}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
