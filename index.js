const PocketBase = require("pocketbase/cjs");
const { detectBot, parseUserAgent, extractRequestData, generateVisitorId } = require("./modules/utils");

// Constants
const VISITORS_COLLECTION = "visitors";
const SESSIONS_COLLECTION = "sessions";
const EVENTS_COLLECTION = "events";
const SUMMARIES_COLLECTION = "dash_sum";

const DEFAULT_BATCH_INTERVAL_MS = 10000; // 10 seconds
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_SESSION_TIMEOUT_MS = 1000 * 60 * 30; // 30 minutes

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
    this.sessionTimeout = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.sessionCache = new Map();
    this.eventQueue = [];
    this.timer = null;

    // Batching configuration
    this.batchingEnabled = options.batch ?? false;
    this.batchInterval = options.batchInterval ?? DEFAULT_BATCH_INTERVAL_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;

    if (this.batchingEnabled) {
      this.timer = setInterval(() => this.flush(), this.batchInterval);
    }
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
      const websiteRecord = await sdk.pb.collection("websites").getFirstListItem(`trackingId="${options.siteId}"`, {
        fields: "id",
      });
      sdk.websiteRecordId = websiteRecord.id;
    } catch (error) {
      if (error.status === 404) {
        throw new Error(`SkoposSDK: Website with trackingId "${options.siteId}" not found.`);
      }
      console.error("SkoposSDK: Failed to fetch website by trackingId.", error);
      throw new Error("SkoposSDK: Could not initialize with provided siteId.");
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
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress)?.split(",")[0].trim();
    const userAgent = req.headers["user-agent"];

    this._processAndQueueEvent({
      siteId: this.siteId,
      ip,
      userAgent,
      path: new URL(payload.url).pathname,
      type: payload.type,
      name: payload.name,
      referrer: payload.referrer,
      screenWidth: payload.screenWidth,
      screenHeight: payload.screenHeight,
      language: payload.language,
      utm: {
        utm_source: payload.utm_source,
        utm_medium: payload.utm_medium,
        utm_campaign: payload.utm_campaign,
      },
      customData: payload.customData,
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

    const { ip, userAgent, path, referrer } = extractRequestData(req);

    this._processAndQueueEvent({
      siteId: siteToTrack,
      ip,
      userAgent,
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
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.flush();
  }

  /**
   * Immediately sends all queued events in batch.
   * @returns {Promise<void>}
   * @example
   * await sdk.flush();
   */
  async flush() {
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
  async _updateDashboardSummary(data, isNewSession) {
    const today = new Date();
    const year = today.getUTCFullYear();
    const month = String(today.getUTCMonth() + 1).padStart(2, "0");
    const day = String(today.getUTCDate()).padStart(2, "0");
    const todayDateString = `${year}-${month}-${day}`;

    const filter = `website="${this.websiteRecordId}" && date ~ "${todayDateString}%"`;

    let summaryRecord;

    try {
      summaryRecord = await this.pb.collection(SUMMARIES_COLLECTION).getFirstListItem(filter);
    } catch (error) {
      if (error.status === 404) {
        try {
          const initialSummary = {
            pageViews: 0,
            visitors: 0,
            topPages: [],
            topReferrers: [],
            deviceBreakdown: [],
            browserBreakdown: [],
            languageBreakdown: [],
            utmSourceBreakdown: [],
            utmMediumBreakdown: [],
            utmCampaignBreakdown: [],
            topCustomEvents: [],
          };
          summaryRecord = await this.pb.collection(SUMMARIES_COLLECTION).create({
            website: this.websiteRecordId,
            date: `${todayDateString} 00:00:00.000Z`,
            summary: initialSummary,
            isFinalized: false,
          });
        } catch (creationError) {
          if (creationError.status === 400 && creationError.response?.data) {
            try {
              await new Promise((resolve) => setTimeout(resolve, 100));
              summaryRecord = await this.pb.collection(SUMMARIES_COLLECTION).getFirstListItem(filter);
            } catch (refetchError) {
              console.error("SkoposSDK: Failed to refetch summary record after race condition.", refetchError);
              return;
            }
          } else {
            console.error("SkoposSDK: Unexpected error creating summary record.", creationError);
            return;
          }
        }
      } else {
        console.error("SkoposSDK: Error fetching summary record.", error);
        return;
      }
    }

    if (!summaryRecord) {
      console.error("SkoposSDK: Could not obtain a summary record to update.");
      return;
    }

    const summaryData = summaryRecord.summary;

    /**
     * Updates an array (breakdown) with the given key (e.g., browser, language).
     * @param {Array<{key: string, count: number}>} list
     * @param {string} key
     */
    const updateBreakdown = (list, key) => {
      if (!key) return;
      const item = list.find((it) => it.key === key);
      if (item) {
        item.count += 1;
      } else {
        list.push({ key, count: 1 });
      }
    };

    if (isNewSession) {
      summaryData.visitors = (summaryData.visitors || 0) + 1;
      updateBreakdown(summaryData.deviceBreakdown, data.device);
      updateBreakdown(summaryData.browserBreakdown, data.browser);
      updateBreakdown(summaryData.languageBreakdown, data.language);

      let referrerHost = "Direct";
      if (data.referrer) {
        try {
          referrerHost = new URL(data.referrer).hostname.replace("www.", "");
        } catch (e) {
          referrerHost = data.referrer;
        }
      }
      updateBreakdown(summaryData.topReferrers, referrerHost);

      updateBreakdown(summaryData.utmSourceBreakdown, data.utm?.utm_source);
      updateBreakdown(summaryData.utmMediumBreakdown, data.utm?.utm_medium);
      updateBreakdown(summaryData.utmCampaignBreakdown, data.utm?.utm_campaign);
    }

    if (data.type === "pageView") {
      summaryData.pageViews = (summaryData.pageViews || 0) + 1;
      updateBreakdown(summaryData.topPages, data.path);
    } else if (data.type === "custom" && data.name) {
      updateBreakdown(summaryData.topCustomEvents, data.name);
    }

    try {
      await this.pb.collection(SUMMARIES_COLLECTION).update(summaryRecord.id, { summary: summaryData });
    } catch (updateError) {
      console.error("SkoposSDK: Failed to update dashboard summary.", updateError);
    }
  }

  /**
   * Core private method to process data, manage sessions, and queue an event.
   * Handles bot checks, session creation & update, and batching logic.
   * @private
   * @param {object} data Consolidated event data (see code for structure).
   * @returns {Promise<void>}
   */
  async _processAndQueueEvent(data) {
    const { siteId, ip, userAgent, path, type, name, referrer, screenWidth, screenHeight, language, utm, customData } = data;

    if (detectBot(userAgent)) {
      return;
    }

    const visitorId = generateVisitorId(siteId, ip, userAgent);
    const now = Date.now();
    let sessionId;
    const cachedSession = this.sessionCache.get(visitorId);
    let isNewSession = false;

    // Check for an active session in the cache
    if (cachedSession && now - cachedSession.lastActivity < this.sessionTimeout) {
      cachedSession.lastActivity = now;
      sessionId = cachedSession.sessionId;
      this.pb
        .collection(SESSIONS_COLLECTION)
        .update(sessionId, {})
        .catch((err) => {
          if (err.status === 404) {
            this.sessionCache.delete(visitorId);
          }
          console.error(`SkoposSDK: Failed to update session TTL for ${sessionId}.`, err.message);
        });
    } else {
      // No active session, create a new one
      isNewSession = true;
      let visitor;
      try {
        visitor = await this.pb.collection(VISITORS_COLLECTION).getFirstListItem(`visitorId="${visitorId}"`);
      } catch (e) {
        if (e.status === 404) {
          // Create visitor if it doesn't exist
          visitor = await this.pb.collection(VISITORS_COLLECTION).create({ website: this.websiteRecordId, visitorId });
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
        referrer,
        screenWidth,
        screenHeight,
        language,
        utmSource: utm?.utm_source,
        utmMedium: utm?.utm_medium,
        utmCampaign: utm?.utm_campaign,
      };

      try {
        const newSession = await this.pb.collection(SESSIONS_COLLECTION).create(sessionData);
        sessionId = newSession.id;
        this.sessionCache.set(visitorId, { sessionId, lastActivity: now });

        this._updateDashboardSummary({ ...data, ...uaDetails }, isNewSession);
      } catch (e) {
        console.error("SkoposSDK: Error creating session.", e);
        return;
      }
    }

    if (!isNewSession) {
      this._updateDashboardSummary(data, isNewSession);
    }

    // Prepare and queue the event payload
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
        this.flush();
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
