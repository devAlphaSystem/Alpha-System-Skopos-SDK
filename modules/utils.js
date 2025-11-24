const { isbot } = require("isbot");
const UAParser = require("ua-parser-js");
const { createHash } = require("node:crypto");

const BOT_CACHE_MAX_SIZE = 1000;
const botDetectionCache = new Map();

/**
 * Simple cache cleanup - removes oldest entries when cache is full
 */
function cleanBotCache() {
  if (botDetectionCache.size > BOT_CACHE_MAX_SIZE) {
    let count = 0;
    for (const key of botDetectionCache.keys()) {
      botDetectionCache.delete(key);
      count++;
      if (count >= 100) break;
    }
  }
}

/**
 * Assigns a score based on various indicators to determine if a request
 * is likely from a bot. A higher score means a higher probability of being a bot.
 *
 * @param {string | undefined} userAgent The user agent string from the request headers.
 * @param {object | undefined} headers All request headers as an object.
 * @returns {number} The bot score.
 */
function calculateBotScore(userAgent, headers) {
  let score = 0;

  if (userAgent && isbot(userAgent)) {
    return 100;
  }

  if (!userAgent || userAgent.length < 10) {
    return 80;
  }

  if (userAgent.length > 512) {
    score += 40;
  }

  const botPatterns = /HeadlessChrome|Puppeteer|PhantomJS|Selenium|Playwright|Crawl(er|bot)|Spider|Scraper|Monitor(ing)?|Archiver|Screenshot|Validator|Lighthouse|AhrefsBot|SemrushBot|MJ12bot|PetalBot|YandexBot|Bingbot|Googlebot|Baiduspider|DotBot|Applebot|facebookexternalhit|Slackbot|Discordbot|Twitterbot|LinkedInBot|WhatsApp|TelegramBot|^curl\/|^wget\/|^python-requests\/|^Go-http-client\/|^Java\/|^okhttp\/|^Apache-HttpClient\/|^Axios\/|^node-fetch\/|^got\/|^Postman|sqlmap|nikto|nmap|masscan|nessus|burpsuite|metasploit|nuclei|acunetix|w3af|zaproxy/i;

  if (botPatterns.test(userAgent)) {
    return 90;
  }

  const parser = new UAParser(userAgent);
  const uaInfo = parser.getResult();

  if (!uaInfo.browser.name && !uaInfo.os.name && userAgent.length > 20) {
    score += 40;
  }

  if (uaInfo.device.type && (uaInfo.device.type === "spider" || uaInfo.device.type === "bot")) {
    score += 50;
  }

  if (uaInfo.browser.name === "Other" && !uaInfo.os.name && !uaInfo.device.type) {
    score += 30;
  }

  if (uaInfo.browser.name && uaInfo.browser.version) {
    const majorVersion = Number.parseInt(uaInfo.browser.version.split(".")[0], 10);
    if ((uaInfo.browser.name === "Chrome" && majorVersion < 80) || (uaInfo.browser.name === "Firefox" && majorVersion < 70) || (uaInfo.browser.name === "Safari" && majorVersion < 12) || (uaInfo.browser.name === "Edge" && majorVersion < 80)) {
      score += 25;
    }
  }

  if (headers) {
    const requiredHeaders = ["accept", "accept-language", "accept-encoding"];
    let missingHeadersCount = 0;
    for (const headerName of requiredHeaders) {
      if (!headers[headerName]) {
        missingHeadersCount++;
      }
    }
    score += missingHeadersCount * 15;

    if (!headers["accept-language"]) {
      score += 20;
    }

    const acceptHeader = headers.accept;
    if (acceptHeader && acceptHeader !== "*/*" && !/html|xml|xhtml|json|\*\//i.test(acceptHeader)) {
      score += 10;
    }

    if (acceptHeader === "*/*" && !headers["accept-language"]) {
      score += 25;
    }

    const suspiciousHeaders = ["x-selenium", "x-puppeteer", "x-playwright", "x-automated", "x-webdriver"];
    for (const header of suspiciousHeaders) {
      if (headers[header]) {
        return 100;
      }
    }

    if (headers["sec-ch-ua-platform"]?.includes("Headless")) {
      return 100;
    }

    if (userAgent && /Chrome|Edge/i.test(userAgent) && !headers["sec-fetch-site"]) {
      score += 15;
    }

    const connection = headers.connection;
    if (connection && connection.toLowerCase() === "close" && headers["accept-encoding"]) {
      score += 10;
    }

    const referer = headers.referer || headers.referrer;
    if (referer && (/bot|crawl|spider|scrape/i.test(referer) || referer.length > 512)) {
      score += 30;
    }
  }

  return Math.min(score, 100);
}

/**
 * Detects if a user agent string belongs to a known bot, crawler, or headless browser
 * based on a scoring system. Results are cached for performance.
 * @param {string | undefined} userAgent The user agent string from the request headers.
 * @param {object | undefined} headers All request headers as an object.
 * @returns {boolean} True if the request is likely a bot.
 */
function detectBot(userAgent, headers) {
  const BOT_SCORE_THRESHOLD = 70;

  if (userAgent) {
    const cached = botDetectionCache.get(userAgent);
    if (cached !== undefined) {
      return cached;
    }
  }

  const score = calculateBotScore(userAgent, headers);
  const isBot = score >= BOT_SCORE_THRESHOLD;

  if (userAgent) {
    cleanBotCache();
    botDetectionCache.set(userAgent, isBot);
  }

  return isBot;
}

/**
 * Parses a user agent string to extract browser, OS, and device information.
 * @param {string | undefined} userAgent The user agent string from the request headers.
 * @returns {{ browser: string | undefined, os: string | undefined, device: string }}
 * An object containing browser, OS, and device type.
 */
function parseUserAgent(userAgent) {
  const parser = new UAParser(userAgent || "");
  const uaInfo = parser.getResult();

  return {
    browser: uaInfo.browser.name,
    os: uaInfo.os.name,
    device: uaInfo.device.type || "desktop",
  };
}

/**
 * Extracts essential data points from an incoming HTTP request.
 * @param {import('http').IncomingMessage} req The Node.js HTTP request object.
 * @returns {{
 *   path: string | undefined,
 *   userAgent: string | undefined,
 *   ip: string | undefined,
 *   referrer: string | undefined,
 *   headers: object
 * }} An object containing request details.
 */
function extractRequestData(req) {
  const userAgent = req.headers["user-agent"];
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress)?.split(",")[0].trim();
  const referrer = req.headers.referer || req.headers.referrer;

  return { path: req.url, userAgent, ip, referrer, headers: req.headers };
}

/**
 * Generates a consistent, anonymized visitor ID using a SHA256 hash.
 * @param {string} siteId The website ID.
 * @param {string | undefined} ip The visitor's IP address.
 * @param {string | undefined} userAgent The visitor's user agent.
 * @returns {string} The hashed visitor ID.
 */
function generateVisitorId(siteId, ip, userAgent) {
  const data = `${siteId}-${ip || "unknown"}-${userAgent || "unknown"}`;
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Validates, sanitizes, and clamps an incoming API event payload.
 * @param {import('../index').ApiEventPayload} payload The raw event payload from the client.
 * @returns {import('../index').ApiEventPayload | null} The sanitized payload or null if validation fails.
 */
function validateAndSanitizeApiPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const { type, name, url, referrer, screenWidth, screenHeight, language, customData, errorMessage, stackTrace } = payload;

  if (typeof type !== "string" || !["pageView", "custom", "jsError"].includes(type)) {
    return null;
  }

  if (typeof url !== "string" || url.length === 0 || url.length > 4096) {
    return null;
  }

  let urlObject;
  try {
    urlObject = new URL(url);
    if (!["http:", "https:"].includes(urlObject.protocol)) {
      return null;
    }
    const hostname = urlObject.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname.startsWith("192.168.") || hostname.startsWith("10.") || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) || hostname === "::1" || hostname === "[::1]") {
    }
  } catch (e) {
    return null;
  }

  if (type === "custom") {
    if (typeof name !== "string" || name.length === 0 || name.length > 255) {
      return null;
    }
  }

  if (type === "jsError") {
    if (typeof errorMessage !== "string" || errorMessage.length === 0 || errorMessage.length > 1024) {
      return null;
    }
  }

  const sanitized = { type };

  sanitized.url = urlObject.href.substring(0, 2048);

  if (type === "custom") {
    sanitized.name = name
      .replace(/[\x00-\x1F\x7F-\x9F]/g, "")
      .trim()
      .substring(0, 100);
    if (sanitized.name.length === 0) {
      return null;
    }
  } else if (type === "jsError") {
    sanitized.name = "jsError";
  } else {
    sanitized.name = name;
  }

  if (referrer !== undefined) {
    if (typeof referrer !== "string" || referrer.length > 4096) {
      return null;
    }
    if (referrer.length > 0) {
      try {
        const refUrl = new URL(referrer);
        if (!["http:", "https:"].includes(refUrl.protocol)) {
          return null;
        }
        sanitized.referrer = refUrl.href.substring(0, 2048);
      } catch (e) {
        sanitized.referrer = referrer.substring(0, 2048);
      }
    } else {
      sanitized.referrer = "";
    }
  }

  if (screenWidth !== undefined) {
    if (typeof screenWidth !== "number" || !Number.isFinite(screenWidth)) {
      return null;
    }
    sanitized.screenWidth = Math.max(0, Math.min(Math.floor(screenWidth), 10000));
  }

  if (screenHeight !== undefined) {
    if (typeof screenHeight !== "number" || !Number.isFinite(screenHeight)) {
      return null;
    }
    sanitized.screenHeight = Math.max(0, Math.min(Math.floor(screenHeight), 10000));
  }

  if (language !== undefined) {
    if (typeof language !== "string" || language.length > 100) {
      return null;
    }
    sanitized.language = language
      .replace(/[\x00-\x1F\x7F-\x9F]/g, "")
      .trim()
      .substring(0, 35);
  }

  if (customData !== undefined) {
    if (typeof customData !== "object" || customData === null || Array.isArray(customData)) {
      return null;
    }

    try {
      const customDataString = JSON.stringify(customData);
      if (customDataString.length > 8192) {
        return null;
      }

      const parsed = JSON.parse(customDataString);

      const dangerousKeys = ["__proto__", "constructor", "prototype"];
      const hasDangerousKeys = (obj) => {
        if (typeof obj !== "object" || obj === null) return false;
        for (const key of Object.keys(obj)) {
          if (dangerousKeys.includes(key.toLowerCase())) return true;
          if (typeof obj[key] === "object" && obj[key] !== null) {
            if (hasDangerousKeys(obj[key])) return true;
          }
        }
        return false;
      };

      if (hasDangerousKeys(parsed)) {
        return null;
      }

      sanitized.customData = parsed;
    } catch (e) {
      return null;
    }
  }

  if (errorMessage !== undefined) {
    if (typeof errorMessage !== "string" || errorMessage.length > 2048) {
      return null;
    }
    sanitized.errorMessage = errorMessage.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "").substring(0, 512);
  }

  if (stackTrace !== undefined) {
    if (typeof stackTrace !== "string" || stackTrace.length > 16384) {
      return null;
    }
    sanitized.stackTrace = stackTrace.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "").substring(0, 4096);
  }

  return sanitized;
}

/**
 * Extracts a clean hostname from a string that might be a full URL.
 * @param {string | null | undefined} domainStr The domain string to process.
 * @returns {string | null} The sanitized hostname or null.
 */
function getSanitizedDomain(domainStr) {
  if (!domainStr) return null;
  const hostname = domainStr.trim();
  try {
    return new URL(hostname).hostname;
  } catch (e) {
    try {
      return new URL(`https://${hostname}`).hostname;
    } catch (e2) {
      return hostname;
    }
  }
}

module.exports = {
  detectBot,
  parseUserAgent,
  extractRequestData,
  generateVisitorId,
  validateAndSanitizeApiPayload,
  getSanitizedDomain,
};
