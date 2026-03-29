const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");

loadEnv(path.join(__dirname, ".env"));

const env = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "127.0.0.1",
  defaultProvider: (process.env.DEFAULT_PROVIDER || "openai").toLowerCase(),
  openAiApiKey: process.env.OPENAI_API_KEY || "",
  openAiApiUrl: process.env.OPENAI_API_URL || "https://api.openai.com/v1/responses",
  openAiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  ollamaBaseUrl: trimTrailingSlash(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"),
  ollamaModel: process.env.OLLAMA_MODEL || "llama3.1:8b",
  applicationsCsvPath: path.resolve(__dirname, "..", "applications.csv")
};

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      providerDefault: env.defaultProvider,
      openAiConfigured: Boolean(env.openAiApiKey),
      ollamaBaseUrl: env.ollamaBaseUrl,
      ollamaModel: env.ollamaModel,
      applicationsCsvPath: env.applicationsCsvPath
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/extract-profile-file") {
    try {
      const body = await readJson(req);
      const result = await extractProfileFile(body);
      sendJson(res, 200, {
        ok: true,
        text: result.text,
        fileType: result.fileType,
        warnings: result.warnings
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : "Profile extraction failed."
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/log-application") {
    try {
      const body = await readJson(req);
      const row = appendApplicationRow(body);
      sendJson(res, 200, {
        ok: true,
        row
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : "Application logging failed."
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/draft-email") {
    try {
      const body = await readJson(req);
      const capture = body.capture || {};
      const profileText = typeof body.profileText === "string" ? body.profileText : "";
      const settings = body.settings || {};
      const provider = normalizeProvider(body.provider || settings.provider || env.defaultProvider);
      const retrievedProfile = rankChunks({
        query: [
          capture.jobTitle,
          capture.company,
          capture.location,
          capture.summary,
          capture.extractedText
        ].join("\n"),
        profileText,
        limit: Number(settings.maxProfileChunks) || 4
      });

      const prompt = buildDraftPrompt({
        capture,
        retrievedProfile,
        settings
      });

      const result = await generateDraft({
        provider,
        prompt,
        modelOverride: settings.model
      });

      sendJson(res, 200, {
        ok: true,
        draft: result,
        provider,
        retrievedProfile
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : "Draft generation failed."
      });
    }
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: `Route not found: ${req.method} ${url.pathname}`
  });
});

server.listen(env.port, env.host, () => {
  console.log(`Job email backend listening on http://${env.host}:${env.port}`);
  console.log(`Default provider: ${env.defaultProvider}`);
});

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

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 15_000_000) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (_error) {
        reject(new Error("Invalid JSON request body."));
      }
    });

    req.on("error", reject);
  });
}

function normalizeWhitespace(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function tokenize(text) {
  return normalizeWhitespace(text)
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/i)
    .filter(Boolean);
}

function textToChunks(text, chunkSize = 650) {
  const clean = normalizeWhitespace(text);
  if (!clean) {
    return [];
  }

  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(clean.length, start + chunkSize);
    chunks.push(clean.slice(start, end));
    start = end;
  }
  return chunks;
}

function rankChunks({ query, profileText, limit = 4 }) {
  const queryTokens = tokenize(query);
  const uniqueQueryTokens = new Set(queryTokens);
  const chunks = textToChunks(profileText);

  const scored = chunks.map((chunk) => {
    const counts = new Map();
    for (const token of tokenize(chunk)) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }

    let score = 0;
    for (const token of uniqueQueryTokens) {
      if (counts.has(token)) {
        score += 3 + counts.get(token);
      }
    }

    if (/ai|llm|automation|python|software|engineering|intern/i.test(chunk)) {
      score += 2;
    }

    return { chunk, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.chunk);
}

function buildDraftPrompt({ capture, retrievedProfile, settings }) {
  const structuredJob = {
    title: capture.jobTitle || "",
    company: capture.company || "",
    location: capture.location || "",
    recruiterEmail: capture.recruiterEmail || "",
    url: capture.url || "",
    pageTitle: capture.pageTitle || "",
    summary: capture.summary || "",
    keyDetails: capture.keyDetails || [],
    extractedText: capture.extractedText || ""
  };

  return [
    "Write a targeted job application email draft.",
    "Use only the facts from the job details and resume context below.",
    "Do not invent projects, metrics, or skills.",
    "Keep the tone professional, specific, and concise.",
    "Return strict JSON with keys: subject, body, rationale.",
    `Tone: ${settings.tone || "professional and concise"}`,
    `Applicant name: ${settings.applicantName || "Applicant"}`,
    `Applicant email: ${settings.applicantEmail || "not provided"}`,
    "",
    "Job details JSON:",
    JSON.stringify(structuredJob, null, 2),
    "",
    "Most relevant resume/profile context:",
    retrievedProfile.join("\n\n---\n\n")
  ].join("\n");
}

function normalizeProvider(provider) {
  const normalized = String(provider || "").toLowerCase();
  if (normalized === "ollama") {
    return "ollama";
  }
  return "openai";
}

async function extractProfileFile(body) {
  const fileName = String(body.fileName || "").trim();
  const mimeType = String(body.mimeType || "").trim().toLowerCase();
  const base64 = String(body.base64 || "").trim();

  if (!fileName || !base64) {
    throw new Error("fileName and base64 are required.");
  }

  const buffer = Buffer.from(base64, "base64");
  const lowerName = fileName.toLowerCase();

  if (mimeType.startsWith("text/") || /\.(txt|md|json)$/i.test(lowerName)) {
    return {
      text: buffer.toString("utf8"),
      fileType: "text",
      warnings: []
    };
  }

  if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) {
    const parsed = await pdfParse(buffer);
    const text = normalizeWhitespace(parsed.text || "");
    return {
      text,
      fileType: "pdf",
      warnings: text ? [] : ["No extractable PDF text found. This file may require OCR."]
    };
  }

  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lowerName.endsWith(".docx")
  ) {
    const parsed = await mammoth.extractRawText({ buffer });
    return {
      text: normalizeWhitespace(parsed.value || ""),
      fileType: "docx",
      warnings: parsed.messages?.map((item) => item.message).filter(Boolean) || []
    };
  }

  throw new Error(`Unsupported file type: ${fileName}`);
}

function appendApplicationRow(body) {
  const capture = body.capture || {};
  const inputEmail = normalizeWhitespace(body.recipientEmail || "");
  const row = {
    Company: normalizeWhitespace(capture.company) || "NA",
    "Job Title": normalizeWhitespace(capture.jobTitle || capture.pageTitle) || "NA",
    Status: normalizeWhitespace(body.status) || "Pending",
    Date: new Date().toISOString().slice(0, 10),
    link: normalizeWhitespace(capture.url) || "NA",
    portal: inferPortalName(capture.url),
    EMAIL: inputEmail || normalizeWhitespace(capture.recruiterEmail) || "NA"
  };

  ensureApplicationsCsvExists();
  const line = csvLine([
    row.Company,
    row["Job Title"],
    row.Status,
    row.Date,
    row.link,
    row.portal,
    row.EMAIL
  ]);
  fs.appendFileSync(env.applicationsCsvPath, `${line}\n`, "utf8");
  return row;
}

function ensureApplicationsCsvExists() {
  if (fs.existsSync(env.applicationsCsvPath)) {
    return;
  }

  fs.writeFileSync(
    env.applicationsCsvPath,
    "Company,Job Title,Status,Date,link,portal,EMAIL\n",
    "utf8"
  );
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function csvLine(values) {
  return values.map(csvEscape).join(",");
}

function inferPortalName(urlValue) {
  try {
    const url = new URL(urlValue);
    const host = url.hostname.replace(/^www\./, "");
    return host || "NA";
  } catch (_error) {
    return "NA";
  }
}

async function generateDraft({ provider, prompt, modelOverride }) {
  if (provider === "ollama") {
    return generateWithOllama({ prompt, modelOverride });
  }
  return generateWithOpenAi({ prompt, modelOverride });
}

async function generateWithOpenAi({ prompt, modelOverride }) {
  if (!env.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured in backend/.env.");
  }

  const response = await fetch(env.openAiApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.openAiApiKey}`
    },
    body: JSON.stringify({
      model: modelOverride || env.openAiModel,
      input: prompt
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${text}`);
  }

  const payload = await response.json();
  const outputText =
    payload?.output_text ||
    payload?.output?.map((item) => (item?.content || []).map((part) => part?.text || "").join(""))?.join("") ||
    "";

  return parseDraftJson(outputText, modelOverride || env.openAiModel);
}

async function generateWithOllama({ prompt, modelOverride }) {
  const response = await fetch(`${env.ollamaBaseUrl}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: modelOverride || env.ollamaModel,
      prompt,
      stream: false,
      format: "json"
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama request failed: ${response.status} ${text}`);
  }

  const payload = await response.json();
  return parseDraftJson(payload?.response || "", modelOverride || env.ollamaModel);
}

function parseDraftJson(outputText, modelUsed) {
  if (!outputText) {
    throw new Error("The provider response did not include text.");
  }

  const firstBrace = outputText.indexOf("{");
  const lastBrace = outputText.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("The provider response was not valid JSON.");
  }

  const parsed = JSON.parse(outputText.slice(firstBrace, lastBrace + 1));
  return {
    subject: normalizeWhitespace(parsed.subject || ""),
    body: String(parsed.body || "").trim(),
    rationale: normalizeWhitespace(parsed.rationale || ""),
    model: modelUsed
  };
}


