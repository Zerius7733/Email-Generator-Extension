import {
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  buildGmailComposeUrl,
  getFromStorage,
  setInStorage
} from "./shared.js";

const captureBtn = document.getElementById("captureBtn");
const generateBtn = document.getElementById("generateBtn");
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

function getPopupState() {
  return {
    recipientEmail: recipientEmailEl.value,
    subject: subjectEl.value,
    body: bodyEl.value,
    rationale: rationaleEl.textContent || ""
  };
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
    STORAGE_KEYS.popupState
  ]);

  const popupState = stored[STORAGE_KEYS.popupState] || null;
  renderCapture(stored[STORAGE_KEYS.lastCapture], popupState);

  if (popupState) {
    subjectEl.value = popupState.subject || "";
    bodyEl.value = popupState.body || "";
    rationaleEl.textContent = popupState.rationale || "";
    return;
  }

  const draft = stored[STORAGE_KEYS.lastDraft];
  if (draft) {
    subjectEl.value = draft.subject || "";
    bodyEl.value = draft.body || "";
    rationaleEl.textContent = draft.rationale || "";
  } else {
    subjectEl.value = "";
    bodyEl.value = "";
    rationaleEl.textContent = "";
  }
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
  subjectEl.value = "";
  bodyEl.value = "";
  rationaleEl.textContent = "";

  const storedBeforeReset = await getFromStorage([STORAGE_KEYS.lastCapture]);
  recipientEmailEl.value = displayEmail(storedBeforeReset[STORAGE_KEYS.lastCapture]?.recruiterEmail);
  await persistPopupState();

  setStatus("Sending job details to backend...");

  const stored = await getFromStorage([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.profileText,
    STORAGE_KEYS.lastCapture
  ]);

  const settings = {
    ...DEFAULT_SETTINGS,
    ...(stored[STORAGE_KEYS.settings] || {})
  };
  const profileText = stored[STORAGE_KEYS.profileText] || "";
  const capture = stored[STORAGE_KEYS.lastCapture];

  if (!capture) {
    throw new Error("Capture a job page first.");
  }

  if (!profileText.trim()) {
    throw new Error("Add your resume or profile text in Options before generating.");
  }

  const response = await fetch(`${normalizeBackendUrl(settings.backendUrl)}/draft-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      provider: settings.provider,
      capture,
      profileText,
      settings: {
        applicantName: settings.applicantName,
        applicantEmail: settings.applicantEmail,
        tone: settings.tone,
        model: settings.model,
        maxProfileChunks: settings.maxProfileChunks
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Backend request failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  if (!payload?.ok || !payload?.draft) {
    throw new Error(payload?.error || "Backend did not return a draft.");
  }

  const draft = payload.draft;
  subjectEl.value = draft.subject || "";
  bodyEl.value = draft.body || "";
  rationaleEl.textContent = draft.rationale || "";

  if (!normalizedRecipientValue()) {
    recipientEmailEl.value = displayEmail(capture.recruiterEmail);
  }

  await setInStorage({
    [STORAGE_KEYS.lastDraft]: {
      ...draft,
      recipientEmail: recipientEmailEl.value,
      provider: payload.provider
    },
    [STORAGE_KEYS.popupState]: getPopupState()
  });

  setStatus(`Draft generated via ${payload.provider}.`);
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

window.addEventListener("beforeunload", () => {
  clearTimeout(saveTimer);
});

loadState();

