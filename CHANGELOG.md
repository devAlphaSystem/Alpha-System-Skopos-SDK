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
