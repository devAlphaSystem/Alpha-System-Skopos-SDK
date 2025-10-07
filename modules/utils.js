const { isbot } = require("isbot");
const UAParser = require("ua-parser-js");
const { createHash } = require("node:crypto");

/**
 * Detects if a user agent string belongs to a known bot, crawler, or headless browser.
 * @param {string} userAgent The user agent string from the request headers.
 * @returns {boolean} True if the user agent is likely a bot.
 */
function detectBot(userAgent) {
  if (!userAgent) {
    return true;
  }
  if (isbot(userAgent)) {
    return true;
  }
  if (/HeadlessChrome/.test(userAgent)) {
    return true;
  }
  return false;
}

/**
 * Parses a user agent string to extract browser, OS, and device information.
 * @param {string} userAgent The user agent string from the request headers.
 * @returns {{ browser: string | undefined, os: string | undefined, device: string }}
 * An object containing browser, OS, and device type.
 */
function parseUserAgent(userAgent) {
  const parser = new UAParser(userAgent);
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
 *   referrer: string | undefined
 * }} An object containing request details.
 */
function extractRequestData(req) {
  const userAgent = req.headers["user-agent"];
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress)?.split(",")[0].trim();
  const referrer = req.headers.referer || req.headers.referrer;

  return { path: req.url, userAgent, ip, referrer };
}

/**
 * Generates a consistent, anonymized visitor ID using a SHA256 hash.
 * @param {string} siteId The website ID.
 * @param {string} ip The visitor's IP address.
 * @param {string} userAgent The visitor's user agent.
 * @returns {string} The hashed visitor ID.
 */
function generateVisitorId(siteId, ip, userAgent) {
  const data = `${siteId}-${ip}-${userAgent}`;
  return createHash("sha256").update(data).digest("hex");
}

module.exports = {
  detectBot,
  parseUserAgent,
  extractRequestData,
  generateVisitorId,
};
