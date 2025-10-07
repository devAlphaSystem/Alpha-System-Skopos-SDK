const PocketBase = require("pocketbase/cjs");
const { detectBot, parseUserAgent, extractRequestData, generateVisitorId } = require("./modules/utils");

// Constants
const VISITORS_COLLECTION = "visitors";
const SESSIONS_COLLECTION = "sessions";
const EVENTS_COLLECTION = "events";
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

    return sdk;
  }

  /**
   * Tracks an event using the rich data payload from the client-side script.
   * @param {import('http').IncomingMessage} req The incoming HTTP request object.
   * @param {import('./index').ApiEventPayload} payload The event data from `req.body`.
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
   * Tracks an event that occurs exclusively on the server.
   * @param {import('http').IncomingMessage} req The incoming HTTP request object.
   * @param {string} eventName A descriptive name for the server-side event.
   * @param {Record<string, any>} [customData={}] Optional custom data for the event.
   * @param {string} [siteId] Optional site ID to override the default.
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
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.flush();
  }

  /**
   * Manually sends all events currently in the queue.
   * @returns {Promise<void>}
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
   * Core private method to process data, manage sessions, and queue an event.
   * @private
   * @param {object} data The consolidated event data.
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
      let visitor;
      try {
        visitor = await this.pb.collection(VISITORS_COLLECTION).getFirstListItem(`visitorId="${visitorId}"`);
      } catch (e) {
        if (e.status === 404) {
          // Create visitor if it doesn't exist
          visitor = await this.pb.collection(VISITORS_COLLECTION).create({ website: siteId, visitorId });
        } else {
          console.error("SkoposSDK: Error finding or creating visitor.", e);
          return;
        }
      }

      const uaDetails = parseUserAgent(userAgent);
      const sessionData = {
        website: siteId,
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
      } catch (e) {
        console.error("SkoposSDK: Error creating session.", e);
        return;
      }
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
   * @private
   * @param {object} eventPayload The event data to send.
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
