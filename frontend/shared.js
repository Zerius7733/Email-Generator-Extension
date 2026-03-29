export const STORAGE_KEYS = {
  settings: "settings",
  profileText: "profileText",
  lastCapture: "lastCapture",
  lastDraft: "lastDraft",
  popupState: "popupState"
};

export const DEFAULT_PROFILE = `Yibin is a Computer Engineering student at NTU focused on software development and AI.

Highlights:
- Built a live production system that helps businesses automate client responses on WhatsApp.
- Built intelligent end-to-end systems spanning embedded work, automation, full-stack software, and AI.
- Worked on an AI-driven incident query platform during a PSA hackathon to improve problem isolation efficiency.
- Reached finalist stage in a fintech hackathon by building an LLM workflow that combines online news sources into market insights.
- Interested in applying AI in real-world systems and learning from production engineering teams.

Strengths:
- Curious and motivated to understand systems deeply.
- Enjoys connecting user problems to practical technical solutions.
- Wants more real-world exposure through internships and applied projects.
`;

export const DEFAULT_SETTINGS = {
  applicantName: "Yibin",
  applicantEmail: "",
  targetEmail: "",
  tone: "professional and concise",
  provider: "openai",
  backendUrl: "http://127.0.0.1:8787",
  model: "",
  maxProfileChunks: 4
};

export async function getFromStorage(keys) {
  return chrome.storage.local.get(keys);
}

export async function setInStorage(values) {
  return chrome.storage.local.set(values);
}

export async function ensureDefaults() {
  const stored = await getFromStorage([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.profileText
  ]);

  const next = {};

  if (!stored[STORAGE_KEYS.settings]) {
    next[STORAGE_KEYS.settings] = DEFAULT_SETTINGS;
  }

  if (!stored[STORAGE_KEYS.profileText]) {
    next[STORAGE_KEYS.profileText] = DEFAULT_PROFILE;
  }

  if (Object.keys(next).length > 0) {
    await setInStorage(next);
  }
}

export function buildGmailComposeUrl({ to, subject, body }) {
  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    to: to || "",
    su: subject,
    body
  });
  return `https://mail.google.com/mail/?${params.toString()}`;
}
