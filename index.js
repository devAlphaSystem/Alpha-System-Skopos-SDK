const { EventSource } = require("eventsource");
global.EventSource = EventSource;

const PocketBase = require("pocketbase/cjs");
const geoip = require("geoip-lite");
const ipaddr = require("ipaddr.js");
const { createHash } = require("node:crypto");
const { detectBot, parseUserAgent, extractRequestData, generateVisitorId, validateAndSanitizeApiPayload, getSanitizedDomain } = require("./modules/utils");

const VISITORS_COLLECTION = "visitors";
const SESSIONS_COLLECTION = "sessions";
const EVENTS_COLLECTION = "events";
const SUMMARIES_COLLECTION = "dash_sum";
const ERRORS_COLLECTION = "js_errors";

const DEFAULT_BATCH_INTERVAL_MS = 10000;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_SESSION_TIMEOUT_MS = 1000 * 60 * 30;
const DEFAULT_ERROR_BATCH_INTERVAL_MS = 1000 * 60 * 5;
const SUMMARY_FLUSH_INTERVAL_MS = 5000;
const SESSION_CACHE_CLEANUP_INTERVAL_MS = 1000 * 60 * 5;

/**
 * The main Skopos SDK class for server-side event tracking.
 * @hideconstructor
 */
class SkoposSDK {
  /**
   * Do not instantiate directly. Use the static `SkoposSDK.init()` method.
   * @private
   * @param {import('./index').SkoposSDKOptions} options SDK configuration options.
   */
  constructor(options) {
    if (!options.pocketbaseUrl) {
      throw new Error("SkoposSDK: 'pocketbaseUrl' is required.");
    }

    this.pb = new PocketBase(options.pocketbaseUrl);
    this.siteId = options.siteId;
    this.websiteRecordId = null;
    this.domain = null;
    this.disableLocalhostTracking = false;
    this.isArchived = false;
    this.ipBlacklist = [];
    this.sessionTimeout = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.sessionCache = new Map();
    this.eventQueue = [];
    this.summaryQueue = new Map();
    this.jsErrorQueue = new Map();
    this.eventTimer = null;
    this.summaryTimer = null;
    this.cacheTimer = null;
    this.jsErrorTimer = null;

    this.batchingEnabled = options.batch ?? false;
    this.batchInterval = options.batchInterval ?? DEFAULT_BATCH_INTERVAL_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;

    const jsErrorBatchInterval = options.jsErrorBatchInterval ?? DEFAULT_ERROR_BATCH_INTERVAL_MS;

    if (this.batchingEnabled) {
      this.eventTimer = setInterval(() => this.flushEvents(), this.batchInterval);
    }
    this.summaryTimer = setInterval(() => this._flushSummaries(), SUMMARY_FLUSH_INTERVAL_MS);
    this.cacheTimer = setInterval(() => this._cleanSessionCache(), SESSION_CACHE_CLEANUP_INTERVAL_MS);
    this.jsErrorTimer = setInterval(() => this._flushJsErrors(), jsErrorBatchInterval);
  }

  /**
   * Initializes and authenticates the Skopos SDK. This is the entry point.
   * @param {import('./index').SkoposSDKOptions} options The configuration for the SDK.
   * @returns {Promise<SkoposSDK>} A promise that resolves to an initialized SDK instance.
   * @throws {Error} If authentication or initialization fails.
   * @example
   * const sdk = await SkoposSDK.init({ siteId: "abc", pocketbaseUrl: "http://localhost:8090" });
   */
  static async init(options) {
    if (!options.siteId) {
      throw new Error("SkoposSDK: 'siteId' is a required option for init.");
    }

    const sdk = new SkoposSDK(options);

    if (options.adminEmail && options.adminPassword) {
      try {
        await sdk.pb.collection("_superusers").authWithPassword(options.adminEmail, options.adminPassword);
        sdk.pb.autoCancellation(false);
      } catch (error) {
        console.error("SkoposSDK: Admin authentication failed.", error);
        throw new Error("SkoposSDK: Could not authenticate with PocketBase.");
      }
    }

    try {
      const websiteRecord = await sdk.pb.collection("websites").getFirstListItem(`trackingId="${options.siteId}"`);
      sdk.websiteRecordId = websiteRecord.id;
      sdk.domain = getSanitizedDomain(websiteRecord.domain);
      sdk.disableLocalhostTracking = websiteRecord.disableLocalhostTracking;
      sdk.isArchived = websiteRecord.isArchived || false;
      sdk.ipBlacklist = websiteRecord.ipBlacklist || [];
    } catch (error) {
      if (error.status === 404) {
        throw new Error(`SkoposSDK: Website with trackingId "${options.siteId}" not found.`);
      }
      console.error("SkoposSDK: Failed to fetch website by trackingId.", error);
      throw new Error("SkoposSDK: Could not initialize with provided siteId.");
    }

    try {
      await sdk.pb.collection("websites").subscribe(sdk.websiteRecordId, (e) => {
        if (e.action === "update") {
          sdk.domain = getSanitizedDomain(e.record.domain);
          sdk.disableLocalhostTracking = e.record.disableLocalhostTracking;
          sdk.ipBlacklist = e.record.ipBlacklist || [];
          sdk.isArchived = e.record.isArchived || false;
        }
      });
    } catch (err) {
      console.error("SkoposSDK: Failed to subscribe to website configuration changes.", err);
    }

    return sdk;
  }

  /**
   * Tracks an event using the rich data payload from the client-side script.
   * Intended for API routes that collect browser event data.
   * @param {import('http').IncomingMessage} req The incoming HTTP request object.
   * @param {import('./index').ApiEventPayload} payload The event data, e.g. URL, type, etc.
   * @returns {Promise<void>|void}
   */
  trackApiEvent(req, payload) {
    const sanitizedPayload = validateAndSanitizeApiPayload(payload);

    if (!sanitizedPayload) {
      return;
    }

    if (this.domain) {
      try {
        const payloadHostname = new URL(sanitizedPayload.url).hostname;
        const siteDomain = this.domain.replace(/^www\./, "");

        if (payloadHostname !== siteDomain && !payloadHostname.endsWith(`.${siteDomain}`)) {
          return;
        }
      } catch (e) {
        return;
      }
    }

    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress)?.split(",")[0].trim();
    const userAgent = req.headers["user-agent"];

    let path = "";
    if (typeof sanitizedPayload.url === "string" && sanitizedPayload.url) {
      try {
        path = new URL(sanitizedPayload.url).pathname;
      } catch {
        path = sanitizedPayload.url;
      }
    }

    this._processAndQueueEvent({
      siteId: this.siteId,
      ip,
      userAgent,
      headers: req.headers,
      path,
      type: sanitizedPayload.type,
      name: sanitizedPayload.name,
      referrer: sanitizedPayload.referrer,
      screenWidth: sanitizedPayload.screenWidth,
      screenHeight: sanitizedPayload.screenHeight,
      language: sanitizedPayload.language,
      customData: sanitizedPayload.customData,
      errorMessage: sanitizedPayload.errorMessage,
      stackTrace: sanitizedPayload.stackTrace,
    });
  }

  /**
   * Tracks a server-side event (for example, an API or backend event).
   * @param {import('http').IncomingMessage} req The incoming HTTP request object.
   * @param {string} eventName A descriptive name for the server-side event (e.g., "user_signup").
   * @param {Record<string, any>} [customData={}] Optional additional custom event data.
   * @param {string} [siteId] Optional site ID; overrides the default if provided.
   * @returns {Promise<void>|void}
   */
  trackServerEvent(req, eventName, customData = {}, siteId) {
    const siteToTrack = siteId || this.siteId;
    if (!siteToTrack) {
      console.error("SkoposSDK: Cannot track server event. No siteId provided.");
      return;
    }

    const { ip, userAgent, path, referrer, headers } = extractRequestData(req);

    this._processAndQueueEvent({
      siteId: siteToTrack,
      ip,
      userAgent,
      headers,
      path,
      type: "custom",
      name: eventName,
      referrer,
      customData,
    });
  }

  /**
   * Gracefully shuts down the SDK by clearing timers and flushing any remaining events.
   * Must be called before process exit to avoid data loss.
   * @returns {Promise<void>}
   * @example
   * await sdk.shutdown();
   */
  async shutdown() {
    if (this.eventTimer) clearInterval(this.eventTimer);
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    if (this.cacheTimer) clearInterval(this.cacheTimer);
    if (this.jsErrorTimer) clearInterval(this.jsErrorTimer);
    this._cleanSessionCache();
    await this.pb.realtime.unsubscribe();
    await this.flushEvents();
    await this._flushJsErrors();
    await this._flushSummaries();
  }

  /**
   * Immediately flushes any queued events to the PocketBase events collection.
   * @returns {Promise<void>}
   */
  async flushEvents() {
    if (this.eventQueue.length === 0) {
      return;
    }

    const eventsToSend = [...this.eventQueue];
    this.eventQueue = [];

    const promises = eventsToSend.map((event) => this._sendEvent(event));
    await Promise.allSettled(promises);
  }

  /**
   * Updates the dashboard summary for today with pageviews, visitors, breakdowns, etc.
   * Creates the record for today if it doesn't exist (handles race conditions).
   * @private
   * @param {object} data Data including at minimum siteId, type, path, referrer etc.
   * @param {boolean} isNewSession Whether this is a new session.
   * @returns {Promise<void>}
   */
  _updateDashboardSummary(data, eventDate) {
    const dateForSummary = eventDate || new Date();
    const year = dateForSummary.getUTCFullYear();
    const month = String(dateForSummary.getUTCMonth() + 1).padStart(2, "0");
    const day = String(dateForSummary.getUTCDate()).padStart(2, "0");
    const summaryDateString = `${year}-${month}-${day}`;

    let summary = this.summaryQueue.get(summaryDateString);
    if (!summary) {
      summary = {
        pageViews: 0,
        visitors: 0,
        newVisitors: 0,
        returningVisitors: 0,
        engagedSessions: 0,
        jsErrors: 0,
        topPages: new Map(),
        entryPages: new Map(),
        exitPages: new Map(),
        topReferrers: new Map(),
        deviceBreakdown: new Map(),
        browserBreakdown: new Map(),
        languageBreakdown: new Map(),
        countryBreakdown: new Map(),
        topCustomEvents: new Map(),
        topJsErrors: new Map(),
      };
      this.summaryQueue.set(summaryDateString, summary);
    }

    const updateMap = (map, key) => {
      if (!key) return;
      map.set(key, (map.get(key) || 0) + 1);
    };

    if (data.isNewSession) {
      summary.visitors++;
      if (data.isNewVisitor) {
        summary.newVisitors++;
      } else {
        summary.returningVisitors++;
      }
      updateMap(summary.deviceBreakdown, data.device);
      updateMap(summary.browserBreakdown, data.browser);
      updateMap(summary.languageBreakdown, data.language);
      updateMap(summary.countryBreakdown, data.country);

      let referrerHost = "Direct";
      if (data.referrer) {
        try {
          referrerHost = new URL(data.referrer).hostname.replace("www.", "");
        } catch (e) {
          referrerHost = data.referrer;
        }
      }
      updateMap(summary.topReferrers, referrerHost);
      updateMap(summary.entryPages, data.path);
    }

    if (data.isEngaged) {
      summary.engagedSessions++;
    }

    if (data.expiredSessionPath) {
      updateMap(summary.exitPages, data.expiredSessionPath);
    }

    if (data.type === "pageView") {
      summary.pageViews++;
      updateMap(summary.topPages, data.path);
    } else if (data.type === "custom" && data.name) {
      updateMap(summary.topCustomEvents, data.name);
    } else if (data.type === "jsError" && data.errorMessage) {
      summary.jsErrors++;
      updateMap(summary.topJsErrors, data.errorMessage);
    }
  }

  /**
   * Flushes the in-memory summary queue to the PocketBase summaries collection.
   * Merges with existing records or creates new ones as needed.
   * @private
   * @returns {Promise<void>}
   */
  async _flushSummaries() {
    if (this.summaryQueue.size === 0) {
      return;
    }

    const summariesToFlush = new Map(this.summaryQueue);
    this.summaryQueue.clear();

    for (const [dateString, summaryData] of summariesToFlush.entries()) {
      const filter = `website="${this.websiteRecordId}" && date ~ "${dateString}%"`;
      let summaryRecord;

      try {
        summaryRecord = await this.pb.collection(SUMMARIES_COLLECTION).getFirstListItem(filter);
      } catch (error) {
        if (error.status === 404) {
          try {
            const initialSummary = {
              pageViews: 0,
              visitors: 0,
              newVisitors: 0,
              returningVisitors: 0,
              engagedSessions: 0,
              jsErrors: 0,
              topPages: [],
              entryPages: [],
              exitPages: [],
              topReferrers: [],
              deviceBreakdown: [],
              browserBreakdown: [],
              languageBreakdown: [],
              countryBreakdown: [],
              topCustomEvents: [],
              topJsErrors: [],
            };
            summaryRecord = await this.pb.collection(SUMMARIES_COLLECTION).create({
              website: this.websiteRecordId,
              date: `${dateString} 00:00:00.000Z`,
              summary: initialSummary,
              isFinalized: false,
            });
          } catch (creationError) {
            if (creationError.status === 400) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              summaryRecord = await this.pb.collection(SUMMARIES_COLLECTION).getFirstListItem(filter);
            } else {
              console.error("SkoposSDK: Error creating summary record.", creationError);
              continue;
            }
          }
        } else {
          console.error("SkoposSDK: Error fetching summary record.", error);
          continue;
        }
      }

      /**
       * Updates an array (breakdown) with the given key (e.g., browser, language).
       * @param {Array<{key: string, count: number}>} list
       * @param {string} key
       */
      const updateBreakdown = (list, map) => {
        for (const [key, count] of map.entries()) {
          const item = list.find((it) => it.key === key);
          if (item) {
            item.count += count;
          } else {
            list.push({ key, count });
          }
        }
      };

      const currentSummary = summaryRecord.summary;
      currentSummary.pageViews += summaryData.pageViews;
      currentSummary.visitors += summaryData.visitors;
      currentSummary.newVisitors += summaryData.newVisitors;
      currentSummary.returningVisitors += summaryData.returningVisitors;
      currentSummary.engagedSessions += summaryData.engagedSessions;
      currentSummary.jsErrors += summaryData.jsErrors;

      updateBreakdown(currentSummary.topPages, summaryData.topPages);
      updateBreakdown(currentSummary.entryPages, summaryData.entryPages);
      updateBreakdown(currentSummary.exitPages, summaryData.exitPages);
      updateBreakdown(currentSummary.topReferrers, summaryData.topReferrers);
      updateBreakdown(currentSummary.deviceBreakdown, summaryData.deviceBreakdown);
      updateBreakdown(currentSummary.browserBreakdown, summaryData.browserBreakdown);
      updateBreakdown(currentSummary.languageBreakdown, summaryData.languageBreakdown);
      updateBreakdown(currentSummary.countryBreakdown, summaryData.countryBreakdown);
      updateBreakdown(currentSummary.topCustomEvents, summaryData.topCustomEvents);
      updateBreakdown(currentSummary.topJsErrors, summaryData.topJsErrors);

      try {
        await this.pb.collection(SUMMARIES_COLLECTION).update(summaryRecord.id, { summary: currentSummary });
      } catch (updateError) {
        console.error("SkoposSDK: Failed to flush dashboard summary.", updateError);
      }
    }
  }

  /**
   * Flushes the in-memory JS error queue to the PocketBase js_errors collection.
   * Merges with existing records or creates new ones as needed.
   * @private
   * @returns {Promise<void>}
   */
  async _flushJsErrors() {
    if (this.jsErrorQueue.size === 0) {
      return;
    }

    const errorsToFlush = new Map(this.jsErrorQueue);
    this.jsErrorQueue.clear();

    for (const [hash, errorData] of errorsToFlush.entries()) {
      try {
        const existingError = await this.pb.collection(ERRORS_COLLECTION).getFirstListItem(`errorHash="${hash}"`);
        await this.pb.collection(ERRORS_COLLECTION).update(existingError.id, {
          "count+": errorData.count,
          lastSeen: new Date().toISOString(),
        });
      } catch (error) {
        if (error.status === 404) {
          try {
            await this.pb.collection(ERRORS_COLLECTION).create({
              website: this.websiteRecordId,
              session: errorData.sessionId,
              errorHash: hash,
              errorMessage: errorData.errorMessage,
              stackTrace: errorData.stackTrace,
              url: errorData.url,
              count: errorData.count,
              lastSeen: new Date().toISOString(),
            });
          } catch (createError) {
            console.error("SkoposSDK: Failed to create new JS error record.", createError);
          }
        } else {
          console.error("SkoposSDK: Failed to find or update JS error record.", error);
        }
      }
    }
  }

  /**
   * Cleans up expired sessions from the session cache.
   * @private
   */
  _cleanSessionCache() {
    const now = Date.now();
    for (const [visitorId, sessionData] of this.sessionCache.entries()) {
      if (now - sessionData.lastActivity > this.sessionTimeout) {
        const lastActivityDate = new Date(sessionData.lastActivity);
        this._updateDashboardSummary({ expiredSessionPath: sessionData.lastPath }, lastActivityDate);
        this.sessionCache.delete(visitorId);
      }
    }
  }

  /**
   * Core private method to process data, manage sessions, and queue an event.
   * Handles bot checks, session creation & update, and batching logic.
   * @private
   * @param {object} data Consolidated event data (see code for structure).
   * @param {string | undefined} data.siteId The site's tracking ID.
   * @param {string | undefined} data.ip The IP address of the request.
   * @param {string | undefined} data.userAgent The User-Agent string.
   * @param {object | undefined} data.headers All request headers.
   * @param {string | undefined} data.path The URL path.
   * @param {'pageView' | 'custom' | 'jsError'} data.type The event type.
   * @param {string | undefined} data.name The event name (for custom events).
   * @param {string | undefined} data.referrer The referrer URL.
   * @param {number | undefined} data.screenWidth The screen width.
   * @param {number | undefined} data.screenHeight The screen height.
   * @param {string | undefined} data.language The browser language.
   * @param {Record<string, any> | undefined} data.customData Custom event data.
   * @param {string | undefined} data.errorMessage Error message for JS errors.
   * @param {string | undefined} data.stackTrace Stack trace for JS errors.
   * @returns {Promise<void>}
   */
  async _processAndQueueEvent(data) {
    const { siteId, ip, userAgent, headers, path, type, name, referrer, screenWidth, screenHeight, language, customData, errorMessage, stackTrace } = data;

    if (this.isArchived) {
      return;
    }

    if (this.ipBlacklist.includes(ip)) {
      return;
    }

    if (this.disableLocalhostTracking && ip) {
      try {
        let addr = ipaddr.parse(ip);
        if (addr.isIPv4MappedAddress()) {
          addr = addr.toIPv4Address();
        }
        if (addr.range() === "loopback") {
          return;
        }
      } catch (e) {
        // Ignore invalid IPs
      }
    }

    if (detectBot(userAgent, headers)) {
      return;
    }

    let country = "Unknown";
    if (ip) {
      const geo = geoip.lookup(ip);
      if (geo?.country) {
        country = geo.country;
      }
    }

    const visitorId = generateVisitorId(siteId, ip, userAgent);
    const now = Date.now();
    let sessionId;
    const cachedSession = this.sessionCache.get(visitorId);
    let isNewSession = false;
    let isNewVisitor = false;
    let isEngaged = false;

    if (cachedSession && now - cachedSession.lastActivity < this.sessionTimeout) {
      cachedSession.lastActivity = now;
      cachedSession.lastPath = path;
      sessionId = cachedSession.sessionId;
      cachedSession.eventCount++;

      if (!cachedSession.isEngaged && (cachedSession.eventCount >= 2 || (customData?.duration && customData.duration > 10))) {
        cachedSession.isEngaged = true;
        isEngaged = true;
      }

      this.pb
        .collection(SESSIONS_COLLECTION)
        .update(sessionId, {})
        .catch((err) => {
          if (err.status === 404) {
            this.sessionCache.delete(visitorId);
          }
          console.error(`SkoposSDK: Failed to update session for ${sessionId}.`, err.message);
        });
    } else {
      isNewSession = true;
      if (cachedSession) {
        const lastActivityDate = new Date(cachedSession.lastActivity);
        this._updateDashboardSummary({ expiredSessionPath: cachedSession.lastPath }, lastActivityDate);
      }

      let visitor;
      try {
        visitor = await this.pb.collection(VISITORS_COLLECTION).getFirstListItem(`visitorId="${visitorId}"`);
        isNewVisitor = false;
      } catch (e) {
        if (e.status === 404) {
          visitor = await this.pb.collection(VISITORS_COLLECTION).create({ website: this.websiteRecordId, visitorId });
          isNewVisitor = true;
        } else {
          console.error("SkoposSDK: Error finding or creating visitor.", e);
          return;
        }
      }

      const uaDetails = parseUserAgent(userAgent);
      const sessionData = {
        website: this.websiteRecordId,
        visitor: visitor.id,
        browser: uaDetails.browser,
        os: uaDetails.os,
        device: uaDetails.device,
        entryPath: path,
        exitPath: path,
        referrer,
        screenWidth,
        screenHeight,
        language,
        country,
        isNewVisitor,
      };

      try {
        const newSession = await this.pb.collection(SESSIONS_COLLECTION).create(sessionData);
        sessionId = newSession.id;

        let sessionIsEngaged = false;
        if (customData?.duration && customData.duration > 10) {
          isEngaged = true;
          sessionIsEngaged = true;
        }

        this.sessionCache.set(visitorId, { sessionId, lastActivity: now, eventCount: 1, lastPath: path, isEngaged: sessionIsEngaged });

        this._updateDashboardSummary({ ...data, ...uaDetails, country, isNewSession, isNewVisitor, isEngaged });
      } catch (e) {
        console.error("SkoposSDK: Error creating session.", e);
        return;
      }
    }

    if (!isNewSession) {
      this._updateDashboardSummary({ ...data, country, isNewSession, isNewVisitor, isEngaged });
    }

    if (type === "jsError") {
      let safeUrl = "";
      if (typeof data.url === "string" && data.url) {
        try {
          safeUrl = new URL(data.url).href;
        } catch {
          safeUrl = data.url;
        }
      }
      const errorIdentifier = `${errorMessage}\n${(stackTrace || "").split("\n")[1]}`;
      const errorHash = createHash("sha256").update(errorIdentifier).digest("hex");
      const existingError = this.jsErrorQueue.get(errorHash);

      if (existingError) {
        existingError.count++;
      } else {
        this.jsErrorQueue.set(errorHash, {
          sessionId,
          errorMessage,
          stackTrace,
          url: safeUrl,
          count: 1,
        });
      }
      return;
    }

    const eventPayload = {
      session: sessionId,
      type: type,
      path: path,
    };
    if (type !== "pageView" && name) {
      eventPayload.eventName = name;
    }
    if (customData && Object.keys(customData).length > 0) {
      eventPayload.eventData = customData;
    }

    if (this.batchingEnabled) {
      this.eventQueue.push(eventPayload);
      if (this.eventQueue.length >= this.maxBatchSize) {
        this.flushEvents();
      }
    } else {
      this._sendEvent(eventPayload);
    }
  }

  /**
   * Sends a single event payload to the PocketBase events collection.
   * Handles PocketBase API errors.
   * @private
   * @param {object} eventPayload The event data to send; at minimum must include session, type, path.
   * @returns {Promise<void>}
   */
  async _sendEvent(eventPayload) {
    try {
      await this.pb.collection(EVENTS_COLLECTION).create(eventPayload);
    } catch (error) {
      console.error("SkoposSDK: Failed to send event.", error);
    }
  }
}

module.exports = SkoposSDK;
