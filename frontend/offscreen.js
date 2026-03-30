import { DRAFT_REQUEST_TIMEOUT_MS } from "./shared.js";

let activeDraftController = null;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  activeDraftController = controller;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Draft generation timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    activeDraftController = null;
    clearTimeout(timer);
  }
}

async function runDraftGeneration(message) {
  const response = await fetchWithTimeout(
    `${message.backendUrl}/draft-email`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        provider: message.provider,
        capture: message.capture,
        profileText: message.profileText,
        settings: message.settings
      })
    },
    DRAFT_REQUEST_TIMEOUT_MS
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Backend request failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  if (!payload?.ok || !payload?.draft) {
    throw new Error(payload?.error || "Backend did not return a draft.");
  }

  return payload;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "run-draft-generation") {
    (async () => {
      try {
        const payload = await runDraftGeneration(message);
        sendResponse({ ok: true, payload });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Draft generation failed."
        });
      }
    })();

    return true;
  }

  if (message?.type === "cancel-draft-generation") {
    if (activeDraftController) {
      activeDraftController.abort();
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
