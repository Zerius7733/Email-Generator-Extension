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
  applicationsCsvPath: path.resolve(__dirname, "..", "applications.csv"),
  providerTimeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS || 30000)
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
      const requestStartedAt = Date.now();
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

      const promptStartedAt = Date.now();
      const prompt = buildDraftPrompt({
        capture,
        retrievedProfile,
        settings: {
          ...settings,
          fullProfileText: profileText
        }
      });
      const promptBuildMs = Date.now() - promptStartedAt;

      const providerStartedAt = Date.now();
      const result = await generateDraft({
        provider,
        prompt,
        modelOverride: settings.model
      });
      const providerMs = Date.now() - providerStartedAt;
      const draft = ensureProductionLinkInDraft({
        draft: result,
        capture,
        settings
      });

      console.log(
        `[draft-email] provider=${provider} model=${result.model} promptChars=${prompt.length} retrievedChunks=${retrievedProfile.length} promptBuildMs=${promptBuildMs} providerMs=${providerMs} totalMs=${Date.now() - requestStartedAt}`
      );

      sendJson(res, 200, {
        ok: true,
        draft,
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
    keyDetails: Array.isArray(capture.keyDetails) ? capture.keyDetails.slice(0, 10) : []
  };

  const relevantProfileText = trimText(settings.fullProfileText || "", 2200);

  return [
    "Write a targeted job application email draft.",
    "Use only the facts from the job details and resume context below.",
    "Do not invent projects, metrics, or skills.",
    "Keep the tone professional, warm, specific, and concise.",
    "The email should sound like a real candidate wrote it, not a generic template.",
    "Prefer this paragraph structure:",
    "1. Greeting and one short opening paragraph stating interest in the role and company.",
    "2. One concrete project paragraph focused on the strongest relevant project or hackathon work.",
    "3. One paragraph on technical experience gained from those projects, such as backend systems, APIs, deployment, data workflows, or full-stack implementation.",
    "4. One short paragraph explaining why that experience makes the applicant a good fit for the role.",
    "5. One brief closing paragraph mentioning the resume and openness to discuss further.",
    "Prioritize concrete project experience over broad lists of coursework, tools, or generic strengths unless the job explicitly asks for them.",
    "Mention only projects, technical work, and experience that are directly relevant to the role.",
    "For each project or experience mentioned, make the relevance clear by connecting it to the job's responsibilities, domain, or required skills.",
    "Do not mention CCAs, student clubs, leadership activities, volunteering, sports, or unrelated extracurriculars unless the job details explicitly ask for them.",
    "Do not include filler achievements or background details that do not strengthen role fit.",
    "Avoid stiff phrases such as 'Beyond coursework' or long laundry lists of technologies unless needed for role fit.",
    "Prefer short, readable paragraphs instead of dense blocks.",
    "Prefer one standout project over listing many smaller projects.",
    "If a relevant deployed project exists, mention that it is live in production and place the link on its own line immediately after the sentence introducing the project.",
    "If helpful and factual, a short parenthetical note after the link may suggest how to access or test the platform.",
    "When a live product, deployed app, portfolio, or project link would strengthen the email, integrate the applicant production link naturally into the same paragraph as the project mention instead of adding a detached standalone sentence.",
    "If the job details explicitly ask for a live app, production URL, portfolio, or project link in the response email, make sure the applicant production link is included naturally in the body.",
    "Use a natural salutation like 'Dear <name>,' when a person is known, otherwise use the captured recruiter/team reference if available.",
    "Use sign-offs like 'Yours sincerely,' or 'Best regards,' based on the overall tone.",
    "Do not include the applicant email address in the sign-off or anywhere in the email body unless the job instructions explicitly require it.",
    "Style example to emulate:",
    "Dear [Name],",
    "",
    "I am writing to express my interest in the [Role] role at [Company]. I am currently a [Year/Discipline] student at [University], with experience building and deploying end-to-end applications.",
    "",
    "Recently, I worked on [Project], where [brief achievement or context]. We developed and deployed [Project], a platform that [brief description]:",
    "[Link]",
    "",
    "(Optional short access note if factual.)",
    "",
    "Through my projects, I have gained hands-on experience with [relevant systems or skills]. I am comfortable building practical application logic, integrating external systems, and shipping solutions that can be deployed and iterated on in real-world environments.",
    "",
    "I am particularly interested in this role because [specific role fit]. I am keen to contribute by [specific contribution areas].",
    "",
    "I have attached my resume for your consideration. I believe my experience may be a good fit for this role, and I would welcome the opportunity to discuss how I can contribute further.",
    "",
    "Yours sincerely,",
    "[Applicant Name]",
    "Return strict JSON with keys: subject, body, rationale.",
    `Tone: ${settings.tone || "formal, natural, project-focused, and concise"}`,
    `Applicant name: ${settings.applicantName || "Applicant"}`,
    `Applicant email: ${settings.applicantEmail || "not provided"}`,
    `Applicant production project name: ${settings.productionProjectName || "not provided"}`,
    `Applicant production link: ${settings.productionLink || "not provided"}`,
    "If both a production project name and production link are provided, treat the link as belonging to that project and refer to them together naturally in the email.",
    "",
    "Job details JSON:",
    JSON.stringify(structuredJob, null, 2),
    "",
    "Most relevant resume/profile context:",
    retrievedProfile.join("\n\n---\n\n"),
    "",
    "Additional resume/profile context:",
    relevantProfileText
  ].join("\n");
}

function trimText(text, maxChars) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeProvider(provider) {
  const normalized = String(provider || "").toLowerCase();
  if (normalized === "ollama") {
    return "ollama";
  }
  return "openai";
}

function ensureProductionLinkInDraft({ draft, capture, settings }) {
  const productionLink = normalizeWhitespace(settings.productionLink || "");
  const productionProjectName = normalizeWhitespace(settings.productionProjectName || "");
  if (!productionLink) {
    return draft;
  }

  const body = String(draft?.body || "");
  if (body.includes(productionLink)) {
    return draft;
  }

  const requirementText = [
    capture?.summary || "",
    ...(Array.isArray(capture?.keyDetails) ? capture.keyDetails : []),
    capture?.extractedText || ""
  ]
    .join("\n")
    .toLowerCase();

  const asksForLink = /(portfolio|project link|project links|github|live app|deployed|production link|website|response email)/i.test(
    requirementText
  );

  const linkedProject = productionProjectName
    ? `${productionProjectName}, which can be viewed here: ${productionLink}`
    : `one of my live projects, which can be viewed here: ${productionLink}`;

  const addition = asksForLink
    ? `I am also including ${linkedProject} to address the link request in the application instructions.`
    : `I have also worked on ${linkedProject}.`;

  return {
    ...draft,
    body: insertBeforeSignoff(body, addition),
    rationale: appendRationale(draft?.rationale, asksForLink, productionProjectName)
  };
}

function insertBeforeSignoff(body, addition) {
  const normalizedBody = String(body || "").trim();
  if (!normalizedBody) {
    return addition;
  }

  const signoffMatch = normalizedBody.match(/\n(?:Thank you[^\n]*|Best regards,|Regards,|Sincerely,)[\s\S]*$/i);
  if (!signoffMatch || typeof signoffMatch.index !== "number") {
    return `${normalizedBody}\n\n${addition}`;
  }

  const before = normalizedBody.slice(0, signoffMatch.index).trimEnd();
  const after = normalizedBody.slice(signoffMatch.index).trimStart();
  return `${before}\n\n${addition}\n\n${after}`;
}

function appendRationale(rationale, matchedRequirement, productionProjectName) {
  const base = String(rationale || "").trim();
  const projectReference = productionProjectName
    ? `Linked the production URL to ${productionProjectName}.`
    : "Included the configured production link as a live project reference.";
  const addition = matchedRequirement
    ? `${projectReference} Included the production link because the captured job details appear to request a link or portfolio in the response.`
    : projectReference;

  return base ? `${base} ${addition}` : addition;
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

  const response = await fetchWithTimeout(
    env.openAiApiUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.openAiApiKey}`
      },
      body: JSON.stringify({
        model: modelOverride || env.openAiModel,
        input: prompt
      })
    },
    env.providerTimeoutMs,
    "OpenAI"
  );

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
  const response = await fetchWithTimeout(
    `${env.ollamaBaseUrl}/api/generate`,
    {
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
    },
    env.providerTimeoutMs,
    "Ollama"
  );

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

async function fetchWithTimeout(url, options, timeoutMs, providerName) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${providerName} request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}


