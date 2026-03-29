import {
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  getFromStorage,
  setInStorage
} from "./shared.js";

const ids = [
  "applicantName",
  "applicantEmail",
  "targetEmail",
  "tone",
  "backendUrl",
  "provider",
  "model",
  "maxProfileChunks",
  "profileText"
];

const fields = Object.fromEntries(
  ids.map((id) => [id, document.getElementById(id)])
);

const statusEl = document.getElementById("status");
const importFileEl = document.getElementById("importFile");
const saveBtn = document.getElementById("saveBtn");
const resetBtn = document.getElementById("resetBtn");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#991b1b" : "#655c51";
}

function normalizeBackendUrl(value) {
  return (value || DEFAULT_SETTINGS.backendUrl).replace(/\/+$/, "");
}

async function loadSettings() {
  const stored = await getFromStorage([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.profileText
  ]);

  const settings = {
    ...DEFAULT_SETTINGS,
    ...(stored[STORAGE_KEYS.settings] || {})
  };

  fields.applicantName.value = settings.applicantName;
  fields.applicantEmail.value = settings.applicantEmail;
  fields.targetEmail.value = settings.targetEmail;
  fields.tone.value = settings.tone;
  fields.backendUrl.value = settings.backendUrl;
  fields.provider.value = settings.provider;
  fields.model.value = settings.model;
  fields.maxProfileChunks.value = String(settings.maxProfileChunks);
  fields.profileText.value = stored[STORAGE_KEYS.profileText] || DEFAULT_PROFILE;
}

async function saveSettings() {
  const settings = {
    applicantName: fields.applicantName.value.trim(),
    applicantEmail: fields.applicantEmail.value.trim(),
    targetEmail: fields.targetEmail.value.trim(),
    tone: fields.tone.value.trim(),
    backendUrl: fields.backendUrl.value.trim(),
    provider: fields.provider.value,
    model: fields.model.value.trim(),
    maxProfileChunks: Number(fields.maxProfileChunks.value) || 4
  };

  await setInStorage({
    [STORAGE_KEYS.settings]: settings,
    [STORAGE_KEYS.profileText]: fields.profileText.value.trim()
  });

  setStatus("Settings saved.");
}

async function importProfileFile(file) {
  const stored = await getFromStorage([STORAGE_KEYS.settings]);
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(stored[STORAGE_KEYS.settings] || {})
  };

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  const response = await fetch(`${normalizeBackendUrl(settings.backendUrl)}/extract-profile-file`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type,
      base64: btoa(binary)
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Profile import failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  if (!payload?.ok) {
    throw new Error(payload?.error || "Profile import failed.");
  }

  fields.profileText.value = payload.text || "";
  const warningText = payload.warnings?.length ? ` Warnings: ${payload.warnings.join(" ")}` : "";
  setStatus(`Loaded ${file.name} as ${payload.fileType}.${warningText}`);
}

importFileEl.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  try {
    await importProfileFile(file);
  } catch (error) {
    setStatus(error.message, true);
  }
});

saveBtn.addEventListener("click", async () => {
  try {
    await saveSettings();
  } catch (error) {
    setStatus(error.message, true);
  }
});

resetBtn.addEventListener("click", () => {
  fields.profileText.value = DEFAULT_PROFILE;
  setStatus("Bundled profile restored. Save if you want to keep it.");
});

loadSettings();
