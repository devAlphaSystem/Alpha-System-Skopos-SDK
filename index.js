const { EventSource } = require("eventsource");
global.EventSource = EventSource;

const PocketBase = require("pocketbase/cjs");
const { ChapybaraClient } = require("chapybara");
const ipaddr = require("ipaddr.js");
const { createHash } = require("node:crypto");
const { detectBot, parseUserAgent, extractRequestData, generateVisitorId, validateAndSanitizeApiPayload, getSanitizedDomain, clearBotCache } = require("./modules/utils");
const packageInfo = require("./package.json");

const VISITORS_COLLECTION = "visitors";
const SESSIONS_COLLECTION = "sessions";
const EVENTS_COLLECTION = "events";
const ERRORS_COLLECTION = "js_errors";

const WWW_PREFIX_PATTERN = /^www\./;
const CONTROL_CHARS_PATTERN = /[\x00-\x1F\x7F-\x9F]/g;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_BATCH_INTERVAL_MS = 10000;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_SESSION_TIMEOUT_MS = 1000 * 60 * 30;
const DEFAULT_ERROR_BATCH_INTERVAL_MS = 1000 * 60 * 5;
const SESSION_CACHE_CLEANUP_INTERVAL_MS = 1000 * 60 * 5;
const AUTH_CHECK_INTERVAL_MS = 1000 * 60 * 10;
const VISITOR_CACHE_TTL_MS = 1000 * 60 * 15;
const VISITOR_CACHE_MAX_SIZE = 2000;
const VISITOR_CACHE_CLEANUP_THRESHOLD = 200;
const SESSION_CACHE_MAX_SIZE = 5000;
const JS_ERROR_QUEUE_MAX_SIZE = 100;
const EVENT_QUEUE_MAX_SIZE = 500;

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
    this.startTime = Date.now();
    if (!options.pocketbaseUrl) {
      console.error("SkoposSDK: 'pocketbaseUrl' is a required option.");
      throw new Error("SkoposSDK: 'pocketbaseUrl' is required.");
    }

    this.debug = options.debug ?? false;
    this._log("info", "Instance created. Debug mode enabled.");

    this.pb = new PocketBase(options.pocketbaseUrl);
    this.siteId = options.siteId;
    this.adminEmail = options.adminEmail;
    this.adminPassword = options.adminPassword;
    this.websiteRecordId = null;
    this.domain = null;
    this.disableLocalhostTracking = false;
    this.isArchived = false;
    this.ipBlacklist = [];
    this.ipBlacklistSet = new Set();
    this.storeRawIp = false;
    this.sessionTimeout = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.sessionCache = new Map();
    this.visitorCreationLocks = new Map();
    this.visitorCache = new Map();
    this.eventQueue = [];
    this.jsErrorQueue = new Map();
    this.eventTimer = null;
    this.cacheTimer = null;
    this.visitorCacheTimer = null;
    this.jsErrorTimer = null;
    this.authCheckTimer = null;
    this.lastAuthCheck = 0;

    this.chapybara = null;
    if (options.chapybaraApiKey) {
      this.chapybara = new ChapybaraClient({
        apiKey: options.chapybaraApiKey,
        cacheOptions: {
          max: 1000,
          ttl: 1000 * 60 * 5,
        },
      });
      this._log("info", "Chapybara client initialized for IP geolocation.");
    } else {
      this._log("warn", "No Chapybara API key provided. Country and state will be 'Unknown'.");
    }

    this.batchingEnabled = options.batch ?? false;
    this.batchInterval = options.batchInterval ?? DEFAULT_BATCH_INTERVAL_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;

    const jsErrorBatchInterval = options.jsErrorBatchInterval ?? DEFAULT_ERROR_BATCH_INTERVAL_MS;

    if (this.batchingEnabled) {
      this._log("info", `Batching enabled. Interval: ${this.batchInterval}ms, Max size: ${this.maxBatchSize}.`);
      this.eventTimer = setInterval(() => this.flushEvents(), this.batchInterval);
    } else {
      this._log("info", "Batching disabled. Events will be sent immediately.");
    }
    this.cacheTimer = setInterval(() => this._cleanSessionCache(), SESSION_CACHE_CLEANUP_INTERVAL_MS);
    this.visitorCacheTimer = setInterval(() => this._cleanVisitorCache(), SESSION_CACHE_CLEANUP_INTERVAL_MS);
    this.jsErrorTimer = setInterval(() => this._flushJsErrors(), jsErrorBatchInterval);

    this.authCheckTimer = setInterval(() => this._proactiveAuthRefresh(), AUTH_CHECK_INTERVAL_MS);
  }

  /**
   * Internal logging method with timestamp.
   * @private
   * @param {'error' | 'warn' | 'info' | 'debug'} level The log level.
   * @param  {...any} args The messages to log.
   */
  _log(level, ...args) {
    const elapsedTime = ((Date.now() - this.startTime) / 1000).toFixed(3);
    const prefix = `SkoposSDK [${elapsedTime}s]:`;

    if (level === "error") {
      console.error(prefix, ...args);
      return;
    }

    if (this.debug) {
      switch (level) {
        case "warn":
          console.warn(prefix, ...args);
          break;
        case "info":
          console.info(prefix, ...args);
          break;
        case "debug":
          console.debug(prefix, ...args);
          break;
        default:
          console.log(prefix, ...args);
      }
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
      console.error("SkoposSDK: 'siteId' is a required option for init.");
      throw new Error("SkoposSDK: 'siteId' is a required option for init.");
    }

    const sdk = new SkoposSDK(options);
    sdk._log("info", "Initializing...");

    if (options.adminEmail && options.adminPassword) {
      try {
        sdk._log("debug", "Attempting admin authentication...");
        await sdk.pb.collection("_superusers").authWithPassword(options.adminEmail, options.adminPassword);
        sdk.pb.autoCancellation(false);
        sdk._log("info", "Admin authentication successful.");
      } catch (error) {
        sdk._log("error", "Admin authentication failed.", error);
        throw new Error("SkoposSDK: Could not authenticate with PocketBase.");
      }
    }

    try {
      sdk._log("debug", `Fetching website configuration for siteId: ${options.siteId}`);
      await sdk._ensureAdminAuth();
      const websiteRecord = await sdk.pb.collection("websites").getFirstListItem(`trackingId="${options.siteId}"`);
      sdk.websiteRecordId = websiteRecord.id;
      sdk.domain = getSanitizedDomain(websiteRecord.domain);
      sdk.disableLocalhostTracking = websiteRecord.disableLocalhostTracking;
      sdk.isArchived = websiteRecord.isArchived || false;
      sdk.ipBlacklist = websiteRecord.ipBlacklist || [];
      sdk.ipBlacklistSet = new Set(sdk.ipBlacklist);
      sdk.storeRawIp = websiteRecord.storeRawIp || false;
      sdk._log("info", `Successfully loaded configuration for website: ${sdk.domain || sdk.websiteRecordId}`);

      try {
        await sdk.pb.collection("websites").update(sdk.websiteRecordId, {
          sdkVersion: packageInfo.version,
        });
        sdk._log("info", `Updated SDK version to ${packageInfo.version}`);
      } catch (versionError) {
        sdk._log("warn", "Failed to update SDK version in database", versionError);
      }
    } catch (error) {
      if (error.status === 404) {
        throw new Error(`SkoposSDK: Website with trackingId "${options.siteId}" not found.`);
      }
      sdk._log("error", "Failed to fetch website by trackingId.", error);
      throw new Error("SkoposSDK: Could not initialize with provided siteId.");
    }

    try {
      sdk._log("debug", `Subscribing to configuration changes for website: ${sdk.websiteRecordId}`);
      await sdk._ensureAdminAuth();
      await sdk.pb.collection("websites").subscribe(sdk.websiteRecordId, (e) => {
        if (e.action === "update") {
          sdk._log("info", "Received real-time update for website configuration.");
          sdk.domain = getSanitizedDomain(e.record.domain);
          sdk.disableLocalhostTracking = e.record.disableLocalhostTracking;
          sdk.ipBlacklist = e.record.ipBlacklist || [];
          sdk.ipBlacklistSet = new Set(sdk.ipBlacklist);
          sdk.isArchived = e.record.isArchived || false;
          sdk.storeRawIp = e.record.storeRawIp || false;
        }
      });
      sdk._log("info", "Successfully subscribed to configuration changes.");
    } catch (err) {
      sdk._log("error", "Failed to subscribe to website configuration changes.", err);
    }

    sdk._log("info", "Initialization complete.");
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
    this._log("debug", "trackApiEvent called.");
    const sanitizedPayload = validateAndSanitizeApiPayload(payload);

    if (!sanitizedPayload) {
      this._log("warn", "trackApiEvent rejected due to invalid or unsanitized payload.", { payload });
      return;
    }

    if (this.domain) {
      try {
        const payloadHostname = new URL(sanitizedPayload.url).hostname;
        const siteDomain = this.domain.replace(WWW_PREFIX_PATTERN, "");

        if (payloadHostname !== siteDomain && !payloadHostname.endsWith(`.${siteDomain}`)) {
          this._log("warn", `trackApiEvent rejected. Payload URL hostname "${payloadHostname}" does not match site domain "${this.domain}".`);
          return;
        }
      } catch (e) {
        this._log("warn", `trackApiEvent rejected due to invalid payload URL: ${sanitizedPayload.url}`);
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

    this._log("debug", "Processing API event with data:", {
      path,
      type: sanitizedPayload.type,
      name: sanitizedPayload.name,
    });

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
   * @param {string} [siteId] Optional site ID; overrides the default if provided.
   * @param {Record<string, any>} [customData={}] Optional additional custom event data.
   * @returns {Promise<void>|void}
   */
  trackServerEvent(req, eventName, siteId, customData = {}) {
    this._log("debug", `trackServerEvent called for event: "${eventName}"`);
    const siteToTrack = siteId || this.siteId;
    if (!siteToTrack) {
      this._log("error", "Cannot track server event. No siteId provided.");
      return;
    }

    const { ip, userAgent, path, referrer, headers } = extractRequestData(req);

    this._log("debug", "Processing server event with data:", {
      eventName,
      path,
      siteToTrack,
    });

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
   * Associates an anonymous visitor with user identification data.
   * Should be called after a user logs in or registers to link their session to your internal user ID.
   * This enables tracking user journeys across multiple sessions and devices.
   * @param {import('http').IncomingMessage} req The incoming HTTP request object.
   * @param {string} userId Your internal user ID (e.g., from your database).
   * @param {import('./index').IdentifyData} [userData={}] Optional user data (name, email, phone, metadata).
   * @returns {Promise<void>}
   * @example
   * await skopos.identify(req, 'user_123', { name: 'John Doe', email: 'john@example.com' });
   */
  async identify(req, userId, userData = {}) {
    this._log("debug", `identify called for userId: ${userId}`);

    if (!userId || typeof userId !== "string") {
      this._log("error", "identify requires a valid userId string.");
      return;
    }

    const sanitizedUserId = userId.trim().substring(0, 255);
    if (sanitizedUserId.length === 0) {
      this._log("error", "identify userId cannot be empty.");
      return;
    }

    const sanitizedData = this._validateAndSanitizeIdentifyData(userData);
    if (!sanitizedData) {
      this._log("error", "identify userData validation failed.");
      return;
    }

    const { ip, userAgent } = extractRequestData(req);
    const visitorId = generateVisitorId(this.siteId, ip, userAgent);

    try {
      const { visitor } = await this._getOrCreateVisitor(visitorId);

      const updateData = {
        userId: sanitizedUserId,
      };

      if (sanitizedData.name) updateData.name = sanitizedData.name;
      if (sanitizedData.email) updateData.email = sanitizedData.email;
      if (sanitizedData.phone) updateData.phone = sanitizedData.phone;
      if (sanitizedData.metadata && Object.keys(sanitizedData.metadata).length > 0) {
        updateData.metadata = sanitizedData.metadata;
      }

      await this.pb.collection(VISITORS_COLLECTION).update(visitor.id, updateData);
      this._log("info", `Successfully identified visitor ${visitorId} as user ${sanitizedUserId}`);
    } catch (error) {
      this._log("error", "Failed to identify visitor.", error);
    }
  }

  /**
   * Validates and sanitizes user identification data.
   * @private
   * @param {import('./index').IdentifyData} data The raw user data.
   * @returns {import('./index').IdentifyData | null} The sanitized data or null if validation fails.
   */
  _validateAndSanitizeIdentifyData(data) {
    if (!data || typeof data !== "object") {
      return {};
    }

    const sanitized = {};

    if (data.name !== undefined) {
      if (typeof data.name !== "string") return null;
      sanitized.name = data.name.replace(CONTROL_CHARS_PATTERN, "").trim().substring(0, 255);
    }

    if (data.email !== undefined) {
      if (typeof data.email !== "string") return null;
      const email = data.email.trim().toLowerCase().substring(0, 255);
      if (email.length > 0 && !EMAIL_PATTERN.test(email)) {
        return null;
      }
      sanitized.email = email;
    }

    if (data.phone !== undefined) {
      if (typeof data.phone !== "string") return null;
      sanitized.phone = data.phone.replace(CONTROL_CHARS_PATTERN, "").trim().substring(0, 50);
    }

    if (data.metadata !== undefined) {
      if (typeof data.metadata !== "object" || data.metadata === null || Array.isArray(data.metadata)) {
        return null;
      }
      try {
        const metadataString = JSON.stringify(data.metadata);
        if (metadataString.length > 8192) {
          return null;
        }
        sanitized.metadata = JSON.parse(metadataString);
      } catch (e) {
        return null;
      }
    }

    return sanitized;
  }

  /**
   * Gets or creates a visitor with proper locking to prevent race conditions.
   * Uses an in-memory cache to reduce database lookups for repeat visitors.
   * @private
   * @param {string} visitorId The hashed visitor ID.
   * @returns {Promise<{visitor: object, isNewVisitor: boolean}>}
   */
  async _getOrCreateVisitor(visitorId) {
    const cached = this.visitorCache.get(visitorId);
    if (cached && Date.now() - cached.cachedAt < VISITOR_CACHE_TTL_MS) {
      this._log("debug", `Found cached visitor ${visitorId}`);
      return { visitor: { id: cached.id }, isNewVisitor: false };
    }

    if (this.visitorCreationLocks.has(visitorId)) {
      this._log("debug", `Waiting for ongoing visitor creation: ${visitorId}`);
      return await this.visitorCreationLocks.get(visitorId);
    }

    const creationPromise = (async () => {
      try {
        await this._ensureAdminAuth();

        try {
          const visitor = await this.pb.collection(VISITORS_COLLECTION).getFirstListItem(`visitorId="${visitorId}"`);
          this._log("debug", `Found existing visitor ${visitorId}`);
          this._setVisitorCache(visitorId, visitor);
          return { visitor, isNewVisitor: false };
        } catch (error) {
          if (error.status === 404) {
            this._log("info", `Creating new visitor: ${visitorId}`);
            try {
              const visitor = await this.pb.collection(VISITORS_COLLECTION).create({
                website: this.websiteRecordId,
                visitorId,
              });
              this._log("debug", `Created new visitor: ${visitor.id}`);
              this._setVisitorCache(visitorId, visitor);
              return { visitor, isNewVisitor: true };
            } catch (createError) {
              if (createError.status === 400 || createError.data?.data?.visitorId) {
                this._log("warn", "Race condition detected on visitor creation, re-fetching.");
                const visitor = await this.pb.collection(VISITORS_COLLECTION).getFirstListItem(`visitorId="${visitorId}"`);
                this._setVisitorCache(visitorId, visitor);
                return { visitor, isNewVisitor: false };
              }
              throw createError;
            }
          }
          throw error;
        }
      } finally {
        const cleanup = () => this.visitorCreationLocks.delete(visitorId);
        if (typeof setImmediate !== "undefined") {
          setImmediate(cleanup);
        } else {
          setTimeout(cleanup, 0);
        }
      }
    })();

    this.visitorCreationLocks.set(visitorId, creationPromise);

    return await creationPromise;
  }

  /**
   * Gracefully shuts down the SDK by clearing timers and flushing any remaining events.
   * Must be called before process exit to avoid data loss.
   * @returns {Promise<void>}
   * @example
   * await sdk.shutdown();
   */
  async shutdown() {
    this._log("info", "Shutdown initiated.");
    if (this.eventTimer) {
      clearInterval(this.eventTimer);
      this.eventTimer = null;
    }
    if (this.cacheTimer) {
      clearInterval(this.cacheTimer);
      this.cacheTimer = null;
    }
    if (this.visitorCacheTimer) {
      clearInterval(this.visitorCacheTimer);
      this.visitorCacheTimer = null;
    }
    if (this.jsErrorTimer) {
      clearInterval(this.jsErrorTimer);
      this.jsErrorTimer = null;
    }
    if (this.authCheckTimer) {
      clearInterval(this.authCheckTimer);
      this.authCheckTimer = null;
    }
    this._log("debug", "All timers cleared.");

    this.sessionCache.clear();
    this.visitorCache.clear();
    this.visitorCreationLocks.clear();

    await this.pb.realtime.unsubscribe();
    this._log("debug", "Unsubscribed from real-time updates.");
    await this.flushEvents();
    await this._flushJsErrors();

    this.eventQueue.length = 0;
    this.jsErrorQueue.clear();
    this.ipBlacklistSet.clear();
    clearBotCache();

    this._log("info", "All queues have been flushed.");
    this._log("info", "Shutdown complete.");
  }

  /**
   * Immediately flushes any queued events to the PocketBase events collection.
   * Uses parallel writes for better throughput.
   * @returns {Promise<void>}
   */
  async flushEvents() {
    if (this.eventQueue.length === 0) {
      return;
    }

    const eventsToSend = this.eventQueue.splice(0, this.eventQueue.length);
    this._log("info", `Flushing ${eventsToSend.length} events.`);

    await this._ensureAdminAuth();

    const BATCH_SIZE = 10;
    for (let i = 0; i < eventsToSend.length; i += BATCH_SIZE) {
      const batch = eventsToSend.slice(i, i + BATCH_SIZE);
      const promises = batch.map((event) => this._sendEvent(event));
      await Promise.allSettled(promises);
    }
  }

  /**
   * @private
   */
  async _ensureAdminAuth() {
    if (this.pb.authStore.isValid || !this.adminEmail) {
      if (!this.adminEmail) {
        this._log("debug", "_ensureAdminAuth skipped: no admin credentials provided.");
      } else {
        this._log("debug", "_ensureAdminAuth skipped: token is still valid.");
      }
      return;
    }
    try {
      this._log("info", "Admin token expired or invalid. Re-authenticating...");
      await this.pb.collection("_superusers").authWithPassword(this.adminEmail, this.adminPassword);
      this.lastAuthCheck = Date.now();
      this._log("info", "Re-authentication successful.");
    } catch (error) {
      this._log("error", "Failed to re-authenticate admin.", error);
    }
  }

  /**
   * Proactively refresh auth before it expires to avoid delays during event processing.
   * @private
   */
  async _proactiveAuthRefresh() {
    if (!this.adminEmail) return;

    if (Date.now() - this.lastAuthCheck < AUTH_CHECK_INTERVAL_MS / 2) return;

    try {
      const token = this.pb.authStore.token;
      if (token) {
        try {
          const payload = JSON.parse(atob(token.split(".")[1]));
          const expiresIn = payload.exp * 1000 - Date.now();
          if (expiresIn > 15 * 60 * 1000) {
            this._log("debug", "Token still valid for more than 15 minutes, skipping proactive refresh.");
            return;
          }
        } catch (e) {}
      }

      this._log("info", "Proactively refreshing admin token...");
      await this.pb.collection("_superusers").authWithPassword(this.adminEmail, this.adminPassword);
      this.lastAuthCheck = Date.now();
      this._log("info", "Proactive token refresh successful.");
    } catch (error) {
      this._log("warn", "Proactive auth refresh failed, will retry on next event.", error);
    }
  }

  /**
   * Gets geolocation data (country and state) for an IP address using Chapybara.
   * Falls back to "Unknown" if Chapybara is not configured or if the lookup fails.
   * @private
   * @param {string | undefined} ip The IP address to look up.
   * @returns {Promise<{country: string, state: string}>}
   */
  async _getGeoLocation(ip) {
    if (!ip || !this.chapybara) {
      return { country: "Unknown", state: "Unknown" };
    }

    try {
      let addr = ipaddr.parse(ip);
      if (addr.isIPv4MappedAddress()) {
        addr = addr.toIPv4Address();
      }
      const range = addr.range();
      if (range === "loopback" || range === "private" || range === "linkLocal") {
        this._log("debug", `Skipping geolocation for ${range} IP: ${ip}`);
        return { country: "Unknown", state: "Unknown" };
      }
    } catch (e) {
      this._log("warn", `Could not parse IP for geolocation check: ${ip}`);
      return { country: "Unknown", state: "Unknown" };
    }

    try {
      this._log("debug", `Fetching geolocation for IP: ${ip}`);
      const data = await this.chapybara.ip.getIntelligence(ip);
      const country = data.location?.country?.name || "Unknown";
      const state = data.location?.region?.name || "Unknown";
      this._log("debug", `Geolocation result: ${country}, ${state}`);
      return { country, state };
    } catch (error) {
      this._log("warn", `Failed to get geolocation for IP ${ip}:`, error.message);
      return { country: "Unknown", state: "Unknown" };
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

    this._log("info", `Flushing ${this.jsErrorQueue.size} unique JS errors.`);
    await this._ensureAdminAuth();
    const errorsToFlush = new Map(this.jsErrorQueue);
    this.jsErrorQueue.clear();

    const errorEntries = [...errorsToFlush.entries()];
    const BATCH_SIZE = 5;

    for (let i = 0; i < errorEntries.length; i += BATCH_SIZE) {
      const batch = errorEntries.slice(i, i + BATCH_SIZE);
      const promises = batch.map(async ([hash, errorData]) => {
        const filter = `errorHash="${hash}" && website="${this.websiteRecordId}"`;
        try {
          const existingError = await this.pb.collection(ERRORS_COLLECTION).getFirstListItem(filter);
          await this.pb.collection(ERRORS_COLLECTION).update(existingError.id, {
            "count+": errorData.count,
            lastSeen: new Date().toISOString(),
          });
          this._log("debug", `Updated JS error: ${hash} for website ${this.websiteRecordId}`);
        } catch (error) {
          if (error.status === 404) {
            try {
              this._log("debug", `Creating new JS error: ${hash} for website ${this.websiteRecordId}`);
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
              this._log("error", "Failed to create new JS error record.", createError);
            }
          } else {
            this._log("error", "Failed to find or update JS error record.", error);
          }
        }
      });
      await Promise.allSettled(promises);
    }
  }

  /**
   * Cleans up expired sessions from the session cache.
   * @private
   */
  _cleanSessionCache() {
    this._log("debug", "Running session cache cleanup...");
    const now = Date.now();
    let cleanedCount = 0;
    for (const [visitorId, sessionData] of this.sessionCache.entries()) {
      if (now - sessionData.lastActivity > this.sessionTimeout) {
        this._log("debug", `Expiring session for visitorId: ${visitorId}`);
        this.sessionCache.delete(visitorId);
        cleanedCount++;
      }
    }

    if (this.sessionCache.size > SESSION_CACHE_MAX_SIZE) {
      const toDelete = this.sessionCache.size - SESSION_CACHE_MAX_SIZE + 100;
      let deleted = 0;
      for (const key of this.sessionCache.keys()) {
        if (deleted >= toDelete) break;
        this.sessionCache.delete(key);
        deleted++;
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this._log("info", `Cleaned ${cleanedCount} expired sessions from cache.`);
    }
  }

  /**
   * Sets a visitor in the cache with a timestamp, enforcing max size.
   * Stores only essential data (record ID) instead of full visitor object to reduce memory.
   * @private
   * @param {string} visitorId The visitor ID.
   * @param {object} visitor The visitor record.
   */
  _setVisitorCache(visitorId, visitor) {
    if (this.visitorCache.size >= VISITOR_CACHE_MAX_SIZE + VISITOR_CACHE_CLEANUP_THRESHOLD) {
      const toDelete = this.visitorCache.size - VISITOR_CACHE_MAX_SIZE + 50;
      let deleted = 0;
      for (const key of this.visitorCache.keys()) {
        if (deleted >= toDelete) break;
        this.visitorCache.delete(key);
        deleted++;
      }
    }
    this.visitorCache.set(visitorId, { id: visitor.id, cachedAt: Date.now() });
  }

  /**
   * Cleans up expired visitors from the visitor cache.
   * @private
   */
  _cleanVisitorCache() {
    this._log("debug", "Running visitor cache cleanup...");
    const now = Date.now();
    let cleanedCount = 0;
    for (const [visitorId, cached] of this.visitorCache.entries()) {
      if (now - cached.cachedAt > VISITOR_CACHE_TTL_MS) {
        this.visitorCache.delete(visitorId);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      this._log("info", `Cleaned ${cleanedCount} expired visitors from cache.`);
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

    this._log("debug", "Processing event", {
      type: data.type,
      path: data.path,
    });

    if (this.isArchived) {
      this._log("warn", "Event ignored, website is archived.");
      return;
    }

    if (ip && this.ipBlacklistSet.has(ip)) {
      this._log("warn", `Event ignored, IP ${ip} is in blacklist.`);
      return;
    }

    if (this.disableLocalhostTracking && ip) {
      try {
        let addr = ipaddr.parse(ip);
        if (addr.isIPv4MappedAddress()) {
          addr = addr.toIPv4Address();
        }
        if (addr.range() === "loopback") {
          this._log("warn", "Event ignored, localhost tracking is disabled.");
          return;
        }
      } catch (e) {
        this._log("warn", `Could not parse IP address: ${ip}`);
      }
    }

    if (detectBot(userAgent, headers)) {
      this._log("warn", "Event ignored, bot detected.", { userAgent });
      return;
    }

    await this._ensureAdminAuth();

    const { country, state } = await this._getGeoLocation(ip);

    const visitorId = generateVisitorId(siteId, ip, userAgent);
    const now = Date.now();
    let sessionId;
    const cachedSession = this.sessionCache.get(visitorId);
    let activeSession = null;
    let isNewSession = false;
    let isNewVisitor = false;
    let isEngaged = false;

    if (cachedSession && now - cachedSession.lastActivity < this.sessionTimeout) {
      let sessionStillValid = true;

      try {
        await this.pb.collection(SESSIONS_COLLECTION).update(cachedSession.sessionId, {
          exitPath: path,
        });
      } catch (err) {
        if (err.status === 404) {
          this._log("warn", `Session ${cachedSession.sessionId} not found in DB, removing from cache and will create a new one.`);
          this.sessionCache.delete(visitorId);
          sessionStillValid = false;
        } else {
          this._log("error", `Failed to update session for ${cachedSession.sessionId}.`, err.message);
          sessionStillValid = false;
        }
      }

      if (sessionStillValid) {
        sessionId = cachedSession.sessionId;
        cachedSession.lastActivity = now;
        cachedSession.eventCount++;

        if (!cachedSession.isEngaged && (cachedSession.eventCount >= 2 || (customData?.duration && customData.duration > 10))) {
          cachedSession.isEngaged = true;
          isEngaged = true;
        }

        activeSession = cachedSession;
        this._log("debug", `Existing session found for visitor ${visitorId}: ${sessionId}`);
      }
    }

    if (!activeSession) {
      isNewSession = true;
      this._log("info", `No active session found for visitor ${visitorId}. Creating a new one.`);

      const { visitor, isNewVisitor: newVisitor } = await this._getOrCreateVisitor(visitorId);
      isNewVisitor = newVisitor;

      this._log("info", `Visitor is a ${isNewVisitor ? "new visitor" : "returning visitor"}.`);

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
        state,
        isNewVisitor,
      };

      if (this.storeRawIp && ip) {
        sessionData.ipAddress = ip;
      }

      let sessionIsEngaged = false;
      if (customData?.duration && customData.duration > 10) {
        isEngaged = true;
        sessionIsEngaged = true;
      }

      try {
        const newSession = await this.pb.collection(SESSIONS_COLLECTION).create(sessionData);
        sessionId = newSession.id;
        this._log("info", `New session created: ${sessionId} for visitor ${visitor.id}`);

        this.sessionCache.set(visitorId, {
          sessionId,
          lastActivity: now,
          eventCount: 1,
          isEngaged: sessionIsEngaged,
        });
      } catch (e) {
        this._log("error", "Error creating session.", e);
        return;
      }
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
        if (this.jsErrorQueue.size >= JS_ERROR_QUEUE_MAX_SIZE) {
          this._log("warn", "JS error queue full, flushing before adding new error.");
          await this._flushJsErrors();
        }
        this.jsErrorQueue.set(errorHash, {
          sessionId: sessionId,
          errorMessage,
          stackTrace: stackTrace ? stackTrace.substring(0, 2048) : undefined,
          url: safeUrl,
          count: 1,
        });
      }
      this._log("debug", "Queued JS error report.");
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
    if (customData) {
      for (const _ in customData) {
        eventPayload.eventData = customData;
        break;
      }
    }

    if (this.batchingEnabled) {
      this.eventQueue.push(eventPayload);
      this._log("debug", `Event pushed to queue. Queue size: ${this.eventQueue.length}`);
      if (this.eventQueue.length >= this.maxBatchSize) {
        this._log("info", "Max batch size reached, flushing events.");
        this.flushEvents();
      } else if (this.eventQueue.length >= EVENT_QUEUE_MAX_SIZE) {
        this._log("warn", "Event queue at max capacity, forcing flush to prevent memory leak.");
        this.flushEvents();
      }
    } else {
      this._log("debug", "Sending event immediately (batching disabled).");
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
      this._log("debug", "Sending event to PocketBase:", eventPayload);
      await this._ensureAdminAuth();
      await this.pb.collection(EVENTS_COLLECTION).create(eventPayload);
    } catch (error) {
      this._log("error", "Failed to send event.", error.originalError?.data || error.message);
    }
  }
}

module.exports = SkoposSDK;
