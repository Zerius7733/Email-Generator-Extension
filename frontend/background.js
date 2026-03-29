import {
  STORAGE_KEYS,
  ensureDefaults,
  setInStorage
} from "./shared.js";

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "capture-job") {
    return false;
  }

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
});
