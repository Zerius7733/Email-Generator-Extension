import {
  STORAGE_KEYS,
  STALE_DRAFT_JOB_MS,
  DEFAULT_SETTINGS,
  getFromStorage,
  ensureDefaults,
  removeFromStorage,
  setInStorage
} from "./shared.js";

const OFFSCREEN_DOCUMENT_PATH = "frontend/offscreen.html";
let creatingOffscreenDocument = null;

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaults();
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaults();
});

async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  return tabs[0];
}

async function requestExtraction(tabId) {
  return chrome.tabs.sendMessage(tabId, {
    type: "extract-job-details"
  });
}

function shouldRetryWithInjection(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("Could not establish connection") || message.includes("Receiving end does not exist");
}

async function extractJobDetails(tab) {
  try {
    return await requestExtraction(tab.id);
  } catch (error) {
    if (!shouldRetryWithInjection(error)) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["frontend/content.js"]
    });

    return requestExtraction(tab.id);
  }
}

async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["WORKERS"],
      justification: "Run draft generation reliably while the popup is closed."
    });
  }

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

async function closeOffscreenDocument() {
  if (!(await hasOffscreenDocument())) {
    return;
  }

  await chrome.offscreen.closeDocument();
}

async function cancelDraftGenerationIfNeeded() {
  if (!(await hasOffscreenDocument())) {
    return;
  }

  try {
    await chrome.runtime.sendMessage({ type: "cancel-draft-generation" });
  } catch (_error) {
    // Ignore cancellation errors and continue clearing local state.
  }
}

function displayEmail(value) {
  const email = String(value || "").trim();
  return email || "NA";
}

function normalizeBackendUrl(value) {
  return (value || DEFAULT_SETTINGS.backendUrl).replace(/\/+$/, "");
}

function isRecoverableOffscreenError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /Extension context invalidated|Receiving end does not exist|storage is unavailable|message port closed/i.test(message);
}

async function sendDraftJobToOffscreen(payload, attemptRecovery = true) {
  try {
    return await chrome.runtime.sendMessage({
      type: "run-draft-generation",
      ...payload
    });
  } catch (error) {
    if (!attemptRecovery || !isRecoverableOffscreenError(error)) {
      throw error;
    }

    await closeOffscreenDocument();
    await ensureOffscreenDocument();
    return chrome.runtime.sendMessage({
      type: "run-draft-generation",
      ...payload
    });
  }
}

async function startDraftGeneration() {
  const stored = await getFromStorage([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.profileText,
    STORAGE_KEYS.lastCapture,
    STORAGE_KEYS.popupState,
    STORAGE_KEYS.draftJob
  ]);
  const draftJob = stored[STORAGE_KEYS.draftJob];
  const runningTooLong =
    draftJob?.status === "running" &&
    draftJob.startedAt &&
    Date.now() - Date.parse(draftJob.startedAt) > STALE_DRAFT_JOB_MS;

  if (runningTooLong) {
    await setInStorage({
      [STORAGE_KEYS.draftJob]: {
        status: "error",
        completedAt: new Date().toISOString(),
        error: "Previous draft job was reset after timing out."
      }
    });
  }

  if (draftJob?.status === "running" && !runningTooLong) {
    return { ok: true, started: false, alreadyRunning: true };
  }

  const settings = {
    ...DEFAULT_SETTINGS,
    ...(stored[STORAGE_KEYS.settings] || {})
  };
  const profileText = stored[STORAGE_KEYS.profileText] || "";
  const capture = stored[STORAGE_KEYS.lastCapture];
  const popupState = stored[STORAGE_KEYS.popupState] || {};

  if (!capture) {
    throw new Error("Capture a job page first.");
  }

  if (!profileText.trim()) {
    throw new Error("Add your resume or profile text in Options before generating.");
  }

  const recipientEmail = displayEmail(capture.recruiterEmail);
  const startedAt = new Date().toISOString();

  await setInStorage({
    [STORAGE_KEYS.draftJob]: {
      status: "running",
      provider: settings.provider,
      startedAt,
      error: ""
    },
    [STORAGE_KEYS.popupState]: {
      ...popupState,
      recipientEmail,
      subject: "",
      body: "",
      rationale: ""
    }
  });

  await ensureOffscreenDocument();
  sendDraftJobToOffscreen({
    backendUrl: normalizeBackendUrl(settings.backendUrl),
    provider: settings.provider,
    capture,
    profileText,
    settings: {
      applicantName: settings.applicantName,
      applicantEmail: settings.applicantEmail,
      productionProjectName: settings.productionProjectName,
      productionLink: settings.productionLink,
      tone: settings.tone,
      model: settings.model,
      maxProfileChunks: settings.maxProfileChunks
    }
  }).then(async (result) => {
    if (!result?.ok || !result?.payload?.draft) {
      throw new Error(result?.error || "Draft generation failed.");
    }

    const completedAt = new Date().toISOString();
    const draft = result.payload.draft;

    await setInStorage({
      [STORAGE_KEYS.lastDraft]: {
        ...draft,
        recipientEmail,
        provider: result.payload.provider
      },
      [STORAGE_KEYS.popupState]: {
        ...popupState,
        recipientEmail,
        subject: draft.subject || "",
        body: draft.body || "",
        rationale: draft.rationale || ""
      },
      [STORAGE_KEYS.draftJob]: {
        status: "completed",
        provider: result.payload.provider,
        startedAt,
        completedAt,
        error: ""
      }
    });
  }).catch(async (error) => {
    await setInStorage({
      [STORAGE_KEYS.draftJob]: {
        status: "error",
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Draft generation failed."
      }
    });
  });

  return { ok: true, started: true };
}

async function resetDraftSession() {
  await cancelDraftGenerationIfNeeded();
  await removeFromStorage([
    STORAGE_KEYS.lastCapture,
    STORAGE_KEYS.lastDraft,
    STORAGE_KEYS.draftJob,
    STORAGE_KEYS.popupState
  ]);
  return { ok: true };
}

async function resetDraftJobState() {
  await cancelDraftGenerationIfNeeded();

  const stored = await getFromStorage([STORAGE_KEYS.popupState]);
  const popupState = stored[STORAGE_KEYS.popupState] || {};

  await removeFromStorage([
    STORAGE_KEYS.lastDraft,
    STORAGE_KEYS.draftJob
  ]);

  await setInStorage({
    [STORAGE_KEYS.popupState]: {
      ...popupState,
      subject: "",
      body: "",
      rationale: ""
    }
  });

  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "capture-job") {
    (async () => {
      try {
        const tab = await getActiveTab();

        if (!tab?.id) {
          throw new Error("No active tab found.");
        }

        const extraction = await extractJobDetails(tab);

        const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: "png"
        });

        const capture = {
          ...extraction,
          screenshotDataUrl,
          capturedAt: new Date().toISOString()
        };

        await setInStorage({
          [STORAGE_KEYS.lastCapture]: capture
        });

        sendResponse({ ok: true, capture });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Capture failed."
        });
      }
    })();

    return true;
  }

  if (message?.type === "start-draft-generation") {
    (async () => {
      try {
        sendResponse(await startDraftGeneration());
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Draft generation failed."
        });
      }
    })();

    return true;
  }

  if (message?.type === "get-draft-generation-status") {
    (async () => {
      const stored = await getFromStorage([STORAGE_KEYS.draftJob]);
      sendResponse({
        ok: true,
        draftJob: stored[STORAGE_KEYS.draftJob] || null
      });
    })();

    return true;
  }

  if (message?.type === "reset-draft-session") {
    (async () => {
      try {
        sendResponse(await resetDraftSession());
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Reset failed."
        });
      }
    })();

    return true;
  }

  if (message?.type === "reset-draft-job-state") {
    (async () => {
      try {
        sendResponse(await resetDraftJobState());
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Draft reset failed."
        });
      }
    })();

    return true;
  }

  return false;
});
