import {
  STORAGE_KEYS,
  STALE_DRAFT_JOB_MS,
  BACKEND_HEALTH_TIMEOUT_MS,
  DEFAULT_SETTINGS,
  buildGmailComposeUrl,
  getFromStorage,
  setInStorage
} from "./shared.js";

const captureBtn = document.getElementById("captureBtn");
const generateBtn = document.getElementById("generateBtn");
const resetBtn = document.getElementById("resetBtn");
const applyBtn = document.getElementById("applyBtn");
const statusEl = document.getElementById("status");
const captureMetaEl = document.getElementById("captureMeta");
const previewEl = document.getElementById("preview");
const recipientEmailEl = document.getElementById("recipientEmail");
const subjectEl = document.getElementById("subject");
const bodyEl = document.getElementById("body");
const rationaleEl = document.getElementById("rationale");
const copyEmailBtn = document.getElementById("copyEmailBtn");
const copySubjectBtn = document.getElementById("copySubjectBtn");
const copyBodyBtn = document.getElementById("copyBodyBtn");
const gmailBtn = document.getElementById("gmailBtn");

let saveTimer = null;
let storageListenerAttached = false;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#991b1b" : "#6d675d";
}

function displayEmail(value) {
  const email = (value || "").trim();
  return email || "NA";
}

function normalizedRecipientValue() {
  const current = (recipientEmailEl.value || "").trim();
  if (!current || current.toUpperCase() === "NA") {
    return "";
  }
  return current;
}

function normalizeBackendUrl(value) {
  return (value || DEFAULT_SETTINGS.backendUrl).replace(/\/+$/, "");
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Backend health check timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function getPopupState() {
  return {
    recipientEmail: recipientEmailEl.value,
    subject: subjectEl.value,
    body: bodyEl.value,
    rationale: rationaleEl.textContent || ""
  };
}

function renderDraft(draft, recipientEmail) {
  subjectEl.value = draft?.subject || "";
  bodyEl.value = draft?.body || "";
  rationaleEl.textContent = draft?.rationale || "";

  if (recipientEmail) {
    recipientEmailEl.value = recipientEmail;
  }
}

function updateStatusFromDraftJob(draftJob) {
  if (!draftJob) {
    return;
  }

  if (draftJob.status === "running") {
    if (draftJob.startedAt && Date.now() - Date.parse(draftJob.startedAt) > STALE_DRAFT_JOB_MS) {
      setStatus("The previous draft job appears stuck. Generate again.", true);
      return;
    }
    setStatus("Generating draft in background...");
    return;
  }

  if (draftJob.status === "completed") {
    setStatus(`Draft generated via ${draftJob.provider || "provider"}.`);
    return;
  }

  if (draftJob.status === "error") {
    setStatus(draftJob.error || "Draft generation failed.", true);
  }
}

async function persistPopupState() {
  await setInStorage({
    [STORAGE_KEYS.popupState]: getPopupState()
  });
}

function schedulePopupStateSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    persistPopupState().catch(() => {
      setStatus("Could not save popup edits.", true);
    });
  }, 200);
}

function renderCapture(capture, popupState) {
  if (!capture) {
    captureMetaEl.textContent = "No page captured yet.";
    captureMetaEl.classList.add("empty");
    previewEl.classList.add("hidden");
    previewEl.removeAttribute("src");
    recipientEmailEl.value = popupState?.recipientEmail || "NA";
    return;
  }

  captureMetaEl.classList.remove("empty");
  captureMetaEl.innerHTML = [
    `<strong>${capture.jobTitle || capture.pageTitle || "Untitled role"}</strong>`,
    capture.company || "Company not found",
    capture.location || "Location not found",
    capture.url || ""
  ].join("<br>");

  recipientEmailEl.value = popupState?.recipientEmail || displayEmail(capture.recruiterEmail);

  if (capture.screenshotDataUrl) {
    previewEl.src = capture.screenshotDataUrl;
    previewEl.classList.remove("hidden");
  }
}

async function loadState() {
  const stored = await getFromStorage([
    STORAGE_KEYS.lastCapture,
    STORAGE_KEYS.lastDraft,
    STORAGE_KEYS.popupState,
    STORAGE_KEYS.draftJob
  ]);

  const popupState = stored[STORAGE_KEYS.popupState] || null;
  renderCapture(stored[STORAGE_KEYS.lastCapture], popupState);

  updateStatusFromDraftJob(stored[STORAGE_KEYS.draftJob]);

  if (stored[STORAGE_KEYS.draftJob]?.status === "running") {
    const backendReachable = await isBackendReachable();
    if (!backendReachable) {
      await resetDraftJobOnly("Backend is not connected. Draft generation was reset. Start the backend and try again.");
    }
  }

  if (popupState) {
    renderDraft(popupState, popupState.recipientEmail);
    return;
  }

  const draft = stored[STORAGE_KEYS.lastDraft];
  if (draft) {
    renderDraft(draft, draft.recipientEmail);
  } else {
    renderDraft(null, "");
  }
}

function resetRenderedState() {
  renderCapture(null, null);
  renderDraft(null, "");
}

function clearRenderedDraftOnly() {
  renderDraft(null, recipientEmailEl.value);
}

async function isBackendReachable() {
  const stored = await getFromStorage([STORAGE_KEYS.settings]);
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(stored[STORAGE_KEYS.settings] || {})
  };

  try {
    const response = await fetchWithTimeout(
      `${normalizeBackendUrl(settings.backendUrl)}/health`,
      { method: "GET" },
      BACKEND_HEALTH_TIMEOUT_MS
    );
    return response.ok;
  } catch (_error) {
    return false;
  }
}

async function resetDraftJobOnly(message) {
  const result = await chrome.runtime.sendMessage({
    type: "reset-draft-job-state"
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Could not reset draft state.");
  }

  clearRenderedDraftOnly();
  setStatus(message, true);
}

async function captureCurrentTab() {
  setStatus("Capturing current page and extracting job details...");

  const result = await chrome.runtime.sendMessage({
    type: "capture-job"
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Capture failed.");
  }

  const stored = await getFromStorage([STORAGE_KEYS.popupState]);
  const popupState = stored[STORAGE_KEYS.popupState] || null;
  renderCapture(result.capture, popupState);
  await persistPopupState();
  setStatus("Job page captured.");
}

async function generateDraft() {
  const storedBeforeReset = await getFromStorage([STORAGE_KEYS.lastCapture]);
  recipientEmailEl.value = displayEmail(storedBeforeReset[STORAGE_KEYS.lastCapture]?.recruiterEmail);

  const backendReachable = await isBackendReachable();
  if (!backendReachable) {
    await resetDraftJobOnly("Backend is not connected. Draft generation was reset. Start the backend and try again.");
    return;
  }

  renderDraft(null, recipientEmailEl.value);
  await persistPopupState();

  setStatus("Starting background draft generation...");

  const result = await chrome.runtime.sendMessage({
    type: "start-draft-generation"
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Could not start draft generation.");
  }

  if (result.alreadyRunning) {
    setStatus("Draft generation is already running in the background.");
    return;
  }

  setStatus("Generating draft in background...");
}

async function resetDraftSession() {
  setStatus("Resetting captured and generated draft state...");

  const result = await chrome.runtime.sendMessage({
    type: "reset-draft-session"
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Could not reset draft state.");
  }

  resetRenderedState();
  setStatus("Draft session reset.");
}

async function applyApplication() {
  const stored = await getFromStorage([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.lastCapture
  ]);

  const settings = {
    ...DEFAULT_SETTINGS,
    ...(stored[STORAGE_KEYS.settings] || {})
  };
  const capture = stored[STORAGE_KEYS.lastCapture];

  if (!capture) {
    throw new Error("Capture a job page first.");
  }

  setStatus("Writing application to applications.csv...");

  const response = await fetch(`${normalizeBackendUrl(settings.backendUrl)}/log-application`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      capture,
      recipientEmail: normalizedRecipientValue(),
      status: "Pending"
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Apply request failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  if (!payload?.ok) {
    throw new Error(payload?.error || "Could not append to applications.csv.");
  }

  await persistPopupState();
  setStatus(`Saved to applications.csv for ${payload.row.Company}.`);
}

async function copyValue(value, label) {
  await navigator.clipboard.writeText(value);
  setStatus(`${label} copied.`);
}

captureBtn.addEventListener("click", async () => {
  try {
    await captureCurrentTab();
  } catch (error) {
    setStatus(error.message, true);
  }
});

generateBtn.addEventListener("click", async () => {
  try {
    await generateDraft();
  } catch (error) {
    setStatus(error.message, true);
  }
});

resetBtn.addEventListener("click", async () => {
  try {
    await resetDraftSession();
  } catch (error) {
    setStatus(error.message, true);
  }
});

applyBtn.addEventListener("click", async () => {
  try {
    await applyApplication();
  } catch (error) {
    setStatus(error.message, true);
  }
});

copyEmailBtn.addEventListener("click", async () => {
  await copyValue(recipientEmailEl.value, "Email");
});

copySubjectBtn.addEventListener("click", async () => {
  await copyValue(subjectEl.value, "Subject");
});

copyBodyBtn.addEventListener("click", async () => {
  await copyValue(bodyEl.value, "Body");
});

gmailBtn.addEventListener("click", async () => {
  const stored = await getFromStorage([STORAGE_KEYS.settings, STORAGE_KEYS.lastCapture]);
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(stored[STORAGE_KEYS.settings] || {})
  };

  const manualEmail = normalizedRecipientValue();
  const capture = stored[STORAGE_KEYS.lastCapture];
  const extractedEmail = (capture?.recruiterEmail || "").trim();
  const to = manualEmail || settings.targetEmail || extractedEmail;
  const url = buildGmailComposeUrl({
    to,
    subject: subjectEl.value,
    body: bodyEl.value
  });
  await persistPopupState();
  await chrome.tabs.create({ url });
});

recipientEmailEl.addEventListener("input", schedulePopupStateSave);
subjectEl.addEventListener("input", schedulePopupStateSave);
bodyEl.addEventListener("input", schedulePopupStateSave);

if (!storageListenerAttached && globalThis.chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    if (changes[STORAGE_KEYS.popupState]?.newValue) {
      const popupState = changes[STORAGE_KEYS.popupState].newValue;
      renderDraft(popupState, popupState.recipientEmail);
    }

    if (changes[STORAGE_KEYS.draftJob]?.newValue) {
      updateStatusFromDraftJob(changes[STORAGE_KEYS.draftJob].newValue);
    }
  });
  storageListenerAttached = true;
}

window.addEventListener("beforeunload", () => {
  clearTimeout(saveTimer);
});

loadState();

