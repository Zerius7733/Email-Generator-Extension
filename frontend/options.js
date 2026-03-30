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
  "productionProjectName",
  "productionLink",
  "targetEmail",
  "tone",
  "backendUrl",
  "provider",
  "modelPreset",
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
let draftSaveTimer = null;

const MODEL_PRESETS = {
  openai: [
    { value: "", label: "Use backend default" },
    { value: "gpt-5", label: "gpt-5" },
    { value: "gpt-5-mini", label: "gpt-5-mini" },
    { value: "gpt-4.1", label: "gpt-4.1" },
    { value: "gpt-4.1-mini", label: "gpt-4.1-mini" }
  ],
  ollama: [
    { value: "", label: "Use backend default" },
    { value: "llama3.1:8b", label: "llama3.1:8b" },
    { value: "llama3.1:70b", label: "llama3.1:70b" },
    { value: "qwen2.5", label: "qwen2.5" },
    { value: "mistral", label: "mistral" }
  ]
};

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#991b1b" : "#655c51";
}

function normalizeBackendUrl(value) {
  return (value || DEFAULT_SETTINGS.backendUrl).replace(/\/+$/, "");
}

function getPresetOptions(provider) {
  return MODEL_PRESETS[provider] || MODEL_PRESETS.openai;
}

function syncModelControls({ provider, savedModel = "", preferCustom = false }) {
  const options = getPresetOptions(provider);
  const presetMarkup = options
    .map((option) => `<option value="${option.value}">${option.label}</option>`)
    .join("");

  fields.modelPreset.innerHTML = presetMarkup;

  const matchedPreset = options.find((option) => option.value === savedModel);
  if (matchedPreset && !preferCustom) {
    fields.modelPreset.value = savedModel;
    fields.model.value = "";
    return;
  }

  fields.modelPreset.value = "";
  fields.model.value = savedModel;
}

async function loadSettings() {
  const stored = await getFromStorage([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.profileText,
    STORAGE_KEYS.optionsDraft
  ]);

  const settings = {
    ...DEFAULT_SETTINGS,
    ...(stored[STORAGE_KEYS.settings] || {})
  };
  const draft = stored[STORAGE_KEYS.optionsDraft] || {};

  fields.applicantName.value = draft.applicantName ?? settings.applicantName;
  fields.applicantEmail.value = draft.applicantEmail ?? settings.applicantEmail;
  fields.productionProjectName.value = draft.productionProjectName ?? settings.productionProjectName ?? "";
  fields.productionLink.value = draft.productionLink ?? settings.productionLink ?? "";
  fields.targetEmail.value = draft.targetEmail ?? settings.targetEmail;
  fields.tone.value = draft.tone ?? settings.tone;
  fields.backendUrl.value = draft.backendUrl ?? settings.backendUrl;
  fields.provider.value = draft.provider ?? settings.provider;
  fields.maxProfileChunks.value = String(draft.maxProfileChunks ?? settings.maxProfileChunks);
  fields.profileText.value = draft.profileText ?? stored[STORAGE_KEYS.profileText] ?? DEFAULT_PROFILE;

  syncModelControls({
    provider: fields.provider.value,
    savedModel: draft.model ?? settings.model ?? ""
  });
}

function getDraftValues() {
  const customModel = fields.model.value.trim();
  const presetModel = fields.modelPreset.value;

  return {
    applicantName: fields.applicantName.value,
    applicantEmail: fields.applicantEmail.value,
    productionProjectName: fields.productionProjectName.value,
    productionLink: fields.productionLink.value,
    targetEmail: fields.targetEmail.value,
    tone: fields.tone.value,
    backendUrl: fields.backendUrl.value,
    provider: fields.provider.value,
    model: customModel || presetModel,
    maxProfileChunks: fields.maxProfileChunks.value,
    profileText: fields.profileText.value
  };
}

async function persistDraftValues() {
  await setInStorage({
    [STORAGE_KEYS.optionsDraft]: getDraftValues()
  });
}

function scheduleDraftSave() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    persistDraftValues().catch(() => {
      setStatus("Could not cache option edits.", true);
    });
  }, 200);
}

async function saveSettings() {
  const customModel = fields.model.value.trim();
  const presetModel = fields.modelPreset.value;

  const settings = {
    applicantName: fields.applicantName.value.trim(),
    applicantEmail: fields.applicantEmail.value.trim(),
    productionProjectName: fields.productionProjectName.value.trim(),
    productionLink: fields.productionLink.value.trim(),
    targetEmail: fields.targetEmail.value.trim(),
    tone: fields.tone.value.trim(),
    backendUrl: fields.backendUrl.value.trim(),
    provider: fields.provider.value,
    model: customModel || presetModel,
    maxProfileChunks: Number(fields.maxProfileChunks.value) || 4
  };

  await setInStorage({
    [STORAGE_KEYS.settings]: settings,
    [STORAGE_KEYS.profileText]: fields.profileText.value.trim(),
    [STORAGE_KEYS.optionsDraft]: getDraftValues()
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
  scheduleDraftSave();
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
  scheduleDraftSave();
  setStatus("Bundled profile restored and cached.");
});

fields.provider.addEventListener("change", () => {
  const customModel = fields.model.value.trim();
  const activeModel = customModel || fields.modelPreset.value;
  syncModelControls({
    provider: fields.provider.value,
    savedModel: activeModel,
    preferCustom: Boolean(customModel)
  });
  scheduleDraftSave();
});

fields.modelPreset.addEventListener("change", () => {
  if (fields.modelPreset.value) {
    fields.model.value = "";
  }
  scheduleDraftSave();
});

fields.model.addEventListener("input", () => {
  if (fields.model.value.trim()) {
    fields.modelPreset.value = "";
  }
});

for (const field of Object.values(fields)) {
  field.addEventListener("input", scheduleDraftSave);
  field.addEventListener("change", scheduleDraftSave);
}

loadSettings();
