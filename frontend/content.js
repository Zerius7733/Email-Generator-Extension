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

function extractEmailFromMailtoHref(href) {
  if (!href || !href.toLowerCase().startsWith("mailto:")) {
    return "";
  }

  const emailPart = href.slice("mailto:".length).split("?")[0].trim();
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(emailPart) ? emailPart : "";
}

function inferEmailFromMailtoLinks() {
  const links = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
  for (const link of links) {
    const href = link.getAttribute("href") || "";
    const email = extractEmailFromMailtoHref(href);
    if (email) {
      return email;
    }

    const textEmail = (link.textContent || "").trim();
    if (/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(textEmail)) {
      return textEmail;
    }
  }
  return "";
}

function inferObfuscatedEmail(bodyText) {
  const match = bodyText.match(/([A-Z0-9._%+-]+)\s*(?:\[at\]|\(at\)| at )\s*([A-Z0-9.-]+\.[A-Z]{2,})/i);
  if (!match) {
    return "";
  }
  return `${match[1]}@${match[2]}`;
}

function inferRecruiterEmail(bodyText) {
  const mailtoEmail = inferEmailFromMailtoLinks();
  if (mailtoEmail) {
    return mailtoEmail;
  }

  const directMatch = bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (directMatch) {
    return directMatch[0];
  }

  return inferObfuscatedEmail(bodyText);
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
