function textFromSelectors(selectors) {
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const text = node?.textContent?.trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function metaContent(names) {
  for (const name of names) {
    const node =
      document.querySelector(`meta[name="${name}"]`) ||
      document.querySelector(`meta[property="${name}"]`);
    const content = node?.getAttribute("content")?.trim();
    if (content) {
      return content;
    }
  }
  return "";
}

function collectBodyText() {
  const source =
    document.querySelector("main") ||
    document.querySelector("article") ||
    document.querySelector('[role="main"]') ||
    document.body;

  const clone = source.cloneNode(true);
  clone.querySelectorAll("script, style, noscript, svg, img, video, canvas").forEach((node) => {
    node.remove();
  });

  const raw = clone.textContent || "";
  return raw.replace(/\s+/g, " ").trim();
}

function collectKeyDetails() {
  const candidates = Array.from(
    document.querySelectorAll("h1, h2, h3, p, li, dt, dd, span")
  )
    .map((node) => node.textContent?.trim() || "")
    .filter((text) => text.length > 20 && text.length < 220);

  const seen = new Set();
  const details = [];

  for (const text of candidates) {
    const normalized = text.replace(/\s+/g, " ");
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    details.push(normalized);
    if (details.length >= 18) {
      break;
    }
  }

  return details;
}

function inferCompany() {
  return (
    textFromSelectors([
      '[data-testid*="company"]',
      '[class*="company"]',
      '[id*="company"]'
    ]) ||
    metaContent(["og:site_name", "application-name"]) ||
    ""
  );
}

function inferLocation() {
  return (
    textFromSelectors([
      '[data-testid*="location"]',
      '[class*="location"]',
      '[id*="location"]'
    ]) || ""
  );
}

function inferRecruiterEmail(bodyText) {
  const match = bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : "";
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "extract-job-details") {
    return false;
  }

  const bodyText = collectBodyText();
  const keyDetails = collectKeyDetails();

  const pageTitle = document.title || "";
  const jobTitle =
    textFromSelectors([
      "h1",
      '[data-testid*="job-title"]',
      '[class*="job-title"]',
      '[class*="title"]'
    ]) || pageTitle;

  const summary = bodyText.slice(0, 2400);

  sendResponse({
    url: window.location.href,
    pageTitle,
    jobTitle,
    company: inferCompany(),
    location: inferLocation(),
    recruiterEmail: inferRecruiterEmail(bodyText),
    summary,
    keyDetails,
    extractedText: bodyText.slice(0, 12000)
  });

  return true;
});
