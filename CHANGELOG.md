# 0.13.0

#### Added

- Introduced a new `identify` method (`skopos.identify(req, userId, userData?)`) to link anonymous visitors with authenticated users. This includes a new type definitions for `IdentifyData`, and a robust implementation with extensive data validation and sanitization for user fields like name, email, phone, and metadata.
- Added a new private method `_validateAndSanitizeIdentifyData` to ensure the integrity and security of user identification data.

#### Changed

- Significantly enhanced bot detection capabilities by expanding the `calculateBotScore` function. This includes new rules for detecting longer user agents, additional known bot and automated client user agents (e.g., Playwright, social media bots), security scanning tools (e.g., sqlmap, nmap), older browser versions, and suspicious header patterns (e.g., missing `accept-language`, `x-selenium` headers, 'Headless' platform indications). The bot score is now capped at 100.
- Improved and hardened API payload validation and sanitization in `validateAndSanitizeApiPayload`. Stricter length limits were applied to `url`, event `name`, `errorMessage`, `referrer`, `language`, and `stackTrace`. URL validation now includes protocol checks, and `customData` validation includes checks for dangerous keys (e.g., `__proto__`) to prevent prototype pollution attacks.

---

# 0.12.2

#### Changed

- Integrated Prettier into the development workflow, adding it as a development dependency and introducing a 'format' script for automated code formatting.

---

# 0.12.1

#### Changed

- Optimized bot detection logic by streamlining user agent regex evaluations in `calculateBotScore`.
- Reduced verbose debug logging when event, summary, and JavaScript error queues are empty.

---

# 0.12.0

#### Added

- Added a new `debug` option to `SkoposSDKOptions` to enable verbose logging for debugging purposes.
- Introduced an internal, timestamped logging utility to provide clearer, level-based insight into SDK operations.

#### Changed

- Significantly enhanced the SDK's internal logging capabilities, replacing direct console calls with a structured, level-based system.
- Standardized error messages across the SDK for improved consistency.

---

# 0.11.2

#### Changed

- Improved the admin authentication mechanism by replacing the periodic token refresh with an on-demand re-authentication process, ensuring a valid session before all PocketBase interactions. This simplifies the SDK's internal lifecycle management.

#### Removed

- The adminAuthRefreshTimer and the associated \_refreshAdminAuth method, as periodic token refreshing is no longer required with the new on-demand authentication strategy.

---

# 0.11.1

#### Added

- Implemented automatic periodic refreshing of the admin authentication token to prevent session expiration.

---

# 0.11.0

#### Added

- Introduced new utility functions: `validateAndSanitizeApiPayload` for event data processing and `getSanitizedDomain` for domain extraction.
- Added dynamic domain tracking functionality based on the website's configuration.

#### Changed

- Enhanced the `trackApiEvent` method to include comprehensive validation, sanitization, and clamping of incoming API event payloads. This ensures data integrity and rejects invalid or untrusted data at runtime.
- Implemented domain-specific tracking for `trackApiEvent`, preventing events from being processed if their URL hostname does not match the configured website domain or its subdomains.
- The SDK now dynamically retrieves and updates the website's domain configuration.

---

# 0.10.0

#### Added

- Introduced a new score-based system for bot detection, leveraging multiple indicators from user-agent strings and request headers to identify bots more accurately.

#### Changed

- Enhanced bot detection logic to utilize full request headers in addition to the User-Agent string, allowing for more comprehensive bot identification.
- The SDK now extracts and passes all incoming request headers to internal processing for improved context and bot detection.
- Improved the robustness of visitor ID generation by providing default "unknown" values when IP address or User-Agent are unavailable, ensuring consistent ID creation.

#### Fixed

- Ensured graceful handling of undefined User-Agent strings in parsing utilities to prevent potential errors.

---

# 0.9.0

#### Added

- Implemented real-time updates for website configuration, allowing immediate synchronization of settings such as IP blacklists, localhost tracking preferences, and archival status.
- Added `eventsource` dependency to support real-time subscriptions.

#### Removed

- The `configRefreshIntervalMs` SDK option has been removed.
- The periodic website configuration refresh mechanism (polling) has been removed, as it has been replaced by a real-time subscription system.

---

# 0.8.0

#### Added

- Added a new `isArchived` property to the SDK, enabling the system to identify and respect the archival status of a website.
- Implemented logic to automatically halt the processing of all tracking events for websites that are marked as archived.

#### Changed

- Upgraded the `ua-parser-js` dependency to version 2.0.6.

---

# 0.7.0

#### Removed

- Removed all UTM parameter tracking and processing features from the SDK, including fields in the API event payload, internal data structures, and summary generation.

---

# 0.6.0

#### Added

- New `configRefreshIntervalMs` option to customize the interval for refreshing website configurations.
- Automatic synchronization of website settings (e.g., IP blacklists, localhost tracking preferences) from the Skopos Dashboard.
- IP blacklisting functionality to prevent tracking from specified IP addresses.
- Ability to disable tracking of events originating from localhost.
- Added `ipaddr.js` as a new dependency.

#### Changed

- Improved the `skopos.shutdown()` method to clear all internal timers for a more robust application shutdown.
- Modified the recommended `trackApiEvent` endpoint response to `204 No Content` for a non-blocking, immediate client acknowledgment.

#### Removed

- The standalone "Advanced Configuration (Batching)" section from the `README.md` (batching options are now integrated into the `SkoposSDK.init` options table).

---

# 0.5.0

#### Added

- Support for JavaScript error tracking.
- A new `jsError` event type, including `errorMessage` and `stackTrace` fields for detailed error reporting.
- A new configuration option, `jsErrorBatchInterval`, to control the frequency (in milliseconds) at which batched JavaScript error reports are sent.
- Dedicated collection and flushing mechanisms for processing and storing batched JavaScript errors.
- JavaScript errors count and top JavaScript errors breakdown to dashboard summaries.

#### Changed

- The `close` method now ensures all pending JavaScript error reports are flushed before shutting down.

#### Fixed

- Improved robustness of URL path extraction from event payloads, preventing issues with malformed URLs.

---

# 0.4.0

#### Added

- Introduced an in-memory queue for aggregating dashboard summary data, significantly improving performance by reducing direct database writes for daily statistics.
- Added dedicated background processes for flushing aggregated dashboard summaries and proactively cleaning up the session cache.
- Implemented functionality to track entry and exit pages for user sessions.
- Enhanced session tracking to differentiate between new and returning visitors.
- Added detection for engaged sessions based on event count or custom duration data.
- New configuration constants: `SUMMARY_FLUSH_INTERVAL_MS` for summary flushing and `SESSION_CACHE_CLEANUP_INTERVAL_MS` for session cache cleanup.

#### Changed

- Refactored the dashboard summary update mechanism from immediate database writes to an optimized, in-memory aggregation with periodic batched flushes, resulting in improved performance and reduced database load.
- Updated the SDK's shutdown process to ensure all pending events and aggregated summary data are flushed to the database.
- Renamed the `flush()` method to `flushEvents()` for clearer distinction between event and summary flushing.
- Improved internal session cache management to store `lastPath` and `eventCount`, enabling more accurate engaged session detection and exit page tracking.

---

# 0.3.0

#### Added

- Implemented IP-based country detection for visitor geographical analytics.
- Added a new "countryBreakdown" metric to dashboard summaries to track visitor origins.
- Visitor session data now includes the detected country.

---

# 0.2.0

#### Added

- Introduced a new dashboard summary collection (`dash_sum`) for daily analytics.
- Implemented a new `_updateDashboardSummary` method to calculate and persist daily aggregates (pageviews, visitors, top pages, referrers, device/browser/language/UTM breakdowns, custom events).
- Integrated `_updateDashboardSummary` to process data from both new sessions and subsequent events.
- Enhanced SDK initialization (`SkoposSDK.init`) to validate `siteId` against backend website records and store the internal `websiteRecordId`.
- Improved JSDoc comments for clarity, examples, return types, and exception handling for various methods.

#### Changed

- Refactored internal data storage for `visitors` and `sessions` to consistently use the `websiteRecordId` instead of `siteId` directly.

#### Fixed

- Addressed potential initialization issues by ensuring the provided `siteId` corresponds to a valid website in the backend, throwing an error if not found.
- Implemented robust handling for race conditions during the creation of daily summary records.

---

# 0.1.0

- Initial release of the Skopos Node.js SDK.
