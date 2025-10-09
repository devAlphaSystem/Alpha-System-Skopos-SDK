import type { IncomingMessage } from "node:http";

/**
 * Configuration options for initializing the Skopos SDK.
 */
export interface SkoposSDKOptions {
  /**
   * The full URL to your PocketBase instance.
   * @example "https://pocketbase.example.com"
   */
  pocketbaseUrl: string;

  /**
   * The ID of the website you are tracking, as defined in your Skopos dashboard.
   */
  siteId: string;

  /**
   * The email address for a PocketBase admin or superuser account.
   * Required for the SDK to write data, bypassing collection rules.
   */
  adminEmail?: string;

  /**
   * The password for the PocketBase admin or superuser account.
   */
  adminPassword?: string;

  /**
   * Set to `true` to enable event batching for better performance.
   * @default false
   */
  batch?: boolean;

  /**
   * The interval in milliseconds at which to send batched events.
   * @default 10000 (10 seconds)
   */
  batchInterval?: number;

  /**
   * The maximum number of events to hold in the queue before flushing.
   * @default 100
   */
  maxBatchSize?: number;

  /**
   * The duration in milliseconds before a visitor's session is considered expired.
   * @default 1800000 (30 minutes)
   */
  sessionTimeoutMs?: number;

  /**
   * The interval in milliseconds at which to send batched JavaScript error reports.
   * @default 300000 (5 minutes)
   */
  jsErrorBatchInterval?: number;
}

/**
 * Defines the structure of the data payload sent from the client-side
 * tracking script to your API endpoint.
 */
export interface ApiEventPayload {
  /**
   * The type of event. 'pageView', 'custom', or 'jsError'.
   */
  type: "pageView" | "custom" | "jsError";

  /**
   * The name of the event. Required for 'custom' events.
   * @example "add-to-cart"
   */
  name: string;

  /**
   * The full URL of the page where the event occurred.
   */
  url: string;

  /**
   * The referrer URL, if available.
   */
  referrer?: string;

  /**
   * The width of the user's screen in pixels.
   */
  screenWidth?: number;

  /**
   * The height of the user's screen in pixels.
   */
  screenHeight?: number;

  /**
   * The user's browser language.
   * @example "en-US"
   */
  language?: string;

  /**
   * The UTM source parameter from the URL.
   */
  utm_source?: string;

  /**
   * The UTM medium parameter from the URL.
   */
  utm_medium?: string;

  /**
   * The UTM campaign parameter from the URL.
   */
  utm_campaign?: string;

  /**
   * The UTM term parameter from the URL.
   */
  utm_term?: string;

  /**
   * The UTM content parameter from the URL.
   */
  utm_content?: string;

  /**
   * An object for any custom data you want to associate with the event.
   */
  customData?: Record<string, any>;

  /**
   * The error message, for 'jsError' events.
   */
  errorMessage?: string;

  /**
   * The error stack trace, for 'jsError' events.
   */
  stackTrace?: string;
}

/**
 * The main Skopos SDK class for server-side event tracking.
 * Do not instantiate directly; use the static `init` method instead.
 */
declare class SkoposSDK {
  /**
   * The constructor is private to enforce the use of the async `init` method.
   * @private
   */
  private constructor(options: SkoposSDKOptions);

  /**
   * Initializes and authenticates the Skopos SDK. This is the entry point.
   * @param {SkoposSDKOptions} options - The configuration for the SDK.
   * @returns {Promise<SkoposSDK>} A promise that resolves to an initialized SDK instance.
   */
  static init(options: SkoposSDKOptions): Promise<SkoposSDK>;

  /**
   * Tracks an event using the rich data payload from the client-side script.
   * This is the primary method for tracking user activity like page views and interactions.
   * @param {IncomingMessage} req - The incoming HTTP request object from your server.
   * @param {ApiEventPayload} payload - The event data, typically from `req.body`.
   */
  trackApiEvent(req: IncomingMessage, payload: ApiEventPayload): void;

  /**
   * Tracks an event that occurs exclusively on the server (e.g., webhook, cron job).
   * It uses the request object to create a session for the user if one doesn't exist.
   * @param {IncomingMessage} req - The incoming HTTP request object.
   * @param {string} eventName - A descriptive name for the server-side event.
   * @param {Record<string, any>} [customData] - Optional custom data for the event.
   * @param {string} [siteId] - Optional site ID to override the one set during initialization.
   */
  trackServerEvent(req: IncomingMessage, eventName: string, customData?: Record<string, any>, siteId?: string): void;

  /**
   * Manually sends all events currently in the queue.
   * This is called automatically by the batch interval and max batch size.
   * @returns {Promise<void>}
   */
  flush(): Promise<void>;

  /**
   * Gracefully shuts down the SDK by clearing the batching timer and flushing any remaining events.
   * Call this before your application exits.
   * @returns {Promise<void>}
   */
  shutdown(): Promise<void>;
}

export default SkoposSDK;