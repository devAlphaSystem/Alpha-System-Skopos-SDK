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
   * API key for Chapybara IP geolocation service.
   * When provided, the SDK will use Chapybara to determine visitor country and state.
   * Get your API key from the Chapybara dashboard.
   * Note: The key must be set manually here since dashboard keys are encrypted.
   * @example "ck_your_api_key_here"
   */
  chapybaraApiKey?: string;

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

  /**
   * Set to `true` to enable verbose logging for debugging.
   * Error logs are always enabled.
   * @default false
   */
  debug?: boolean;
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
 * User identification data that can be associated with a visitor.
 * Used with the identify method to link anonymous visitors to known users.
 */
export interface IdentifyData {
  /**
   * The user's full name.
   * @example "John Doe"
   */
  name?: string;

  /**
   * The user's email address.
   * @example "john@example.com"
   */
  email?: string;

  /**
   * The user's phone number.
   * @example "+1234567890"
   */
  phone?: string;

  /**
   * Additional custom metadata about the user.
   * This can include any JSON-serializable data like account tier, preferences, etc.
   * @example { accountTier: "premium", signupSource: "google" }
   */
  metadata?: Record<string, any>;
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
   * The payload will be validated and sanitized; invalid or untrusted data will be rejected at runtime.
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
   * Associates an anonymous visitor with user identification data.
   * Should be called after a user logs in or registers to link their session to your internal user ID.
   * This enables tracking user journeys across multiple sessions and devices.
   * @param {IncomingMessage} req - The incoming HTTP request object.
   * @param {string} userId - Your internal user ID (e.g., from your database).
   * @param {IdentifyData} [userData] - Optional user data (name, email, phone, metadata).
   * @returns {Promise<void>}
   * @example
   * await skopos.identify(req, 'user_123', { name: 'John Doe', email: 'john@example.com' });
   */
  identify(req: IncomingMessage, userId: string, userData?: IdentifyData): Promise<void>;

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
