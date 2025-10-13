const { isbot } = require("isbot");
const UAParser = require("ua-parser-js");
const { createHash } = require("node:crypto");

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
    score += 80;
  }

  if (userAgent && (/HeadlessChrome/i.test(userAgent) || /Puppeteer/i.test(userAgent) || /PhantomJS/i.test(userAgent) || /Selenium/i.test(userAgent) || /Crawl(er|bot)|Spider|Scraper|Monitor(ing)?|Archiver|Screenshot|Validator|Lighthouse|AhrefsBot|SemrushBot|MJ12bot|PetalBot|YandexBot|Bingbot|Googlebot|Baiduspider/i.test(userAgent))) {
    score += 70;
  }

  if (userAgent && (/^curl\//i.test(userAgent) || /^wget\//i.test(userAgent) || /^python-requests\//i.test(userAgent) || /^Go-http-client\//i.test(userAgent) || /^Java\//i.test(userAgent) || /^okhttp\//i.test(userAgent) || /^Apache-HttpClient\//i.test(userAgent))) {
    score += 60;
  }

  if (userAgent && userAgent.length > 10) {
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
  }

  const acceptHeader = headers?.accept;
  if (acceptHeader && acceptHeader !== "*/*" && !/html|xml|xhtml|json|\*\/ /i.test(acceptHeader)) {
    score += 10;
  }

  return score;
}

/**
 * Detects if a user agent string belongs to a known bot, crawler, or headless browser
 * based on a scoring system.
 * @param {string | undefined} userAgent The user agent string from the request headers.
 * @param {object | undefined} headers All request headers as an object.
 * @returns {boolean} True if the request is likely a bot.
 */
function detectBot(userAgent, headers) {
  const BOT_SCORE_THRESHOLD = 70;

  const score = calculateBotScore(userAgent, headers);
  return score >= BOT_SCORE_THRESHOLD;
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

module.exports = {
  detectBot,
  parseUserAgent,
  extractRequestData,
  generateVisitorId,
};
