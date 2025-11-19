The **Skopos Node SDK** is the server-side ingestion layer for Alpha System's privacy-first analytics stack. It authenticates against PocketBase, de-duplicates visitors, manages sessions, batches high-volume traffic, stores JavaScript errors, and exposes a minimal API that you can call from both browser-run endpoints and server processes.

### Capabilities
- 🔐 PocketBase admin authentication with automatic token refresh.
- 🧠 Smart visitor/session handling with geo-IP enrichment, bot detection, JS error hashing, and IP blacklist support.
- ⚙️ Configurable batching, session timeout, short-session discarding, and localhost filtering.
- 🔄 Real-time configuration refresh by subscribing to the `websites` collection.
- 📦 First-class TypeScript declarations (`index.d.ts`).

---

### Requirements
- Node.js 18+ (for global `fetch`, `URL`, and native timers).
- PocketBase v0.26.x with the Skopos schema deployed.
- A `websites` record whose `trackingId` matches the `siteId` you pass to the SDK.
- (Recommended) PocketBase admin/superuser credentials so the SDK can bypass collection rules.

---

### Installation

```bash
npm install @alphasystem/skopos
```

---

### Quick Start

```ts
import express from "express";
import SkoposSDK from "@alphasystem/skopos";

const app = express();
app.use(express.json());

const skopos = await SkoposSDK.init({
	pocketbaseUrl: process.env.POCKETBASE_URL!,
	siteId: process.env.SKOPOS_SITE_ID!,
	adminEmail: process.env.PB_ADMIN_EMAIL,
	adminPassword: process.env.PB_ADMIN_PASSWORD,
	batch: true,
	batchInterval: 5000,
	debug: process.env.NODE_ENV !== "production",
});

app.post("/api/event", (req, res) => {
	skopos.trackApiEvent(req, req.body);
	res.status(204).end();
});

app.post("/internal/signup", (req, res) => {
	skopos.trackServerEvent(req, "user_signup", undefined, { userId: req.body.id });
	res.json({ ok: true });
});

process.on("SIGTERM", async () => {
	await skopos.shutdown();
	process.exit(0);
});

app.listen(3000);
```

> 💡 When running behind a proxy, forward the original `IP` and `User-Agent` headers so the SDK can build accurate sessions.

<details>
<summary>CommonJS snippet</summary>

```js
const express = require("express");
const SkoposSDK = require("@alphasystem/skopos");

(async () => {
	const app = express();
	app.use(express.json());

	const skopos = await SkoposSDK.init({
		pocketbaseUrl: process.env.POCKETBASE_URL,
		siteId: process.env.SKOPOS_SITE_ID,
	});

	app.post("/api/event", (req, res) => {
		skopos.trackApiEvent(req, req.body);
		res.sendStatus(204);
	});

	app.listen(3000);
})();
```

</details>

---

### Configuration Reference

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `pocketbaseUrl` | `string` | — | Base URL of your PocketBase instance (must be reachable from the server). |
| `siteId` | `string` | — | Website tracking ID. Must match `websites.trackingId`. |
| `adminEmail` / `adminPassword` | `string` | `undefined` | Admin credentials that let the SDK create visitors, sessions, events, and errors even if collection rules are restrictive. |
| `batch` | `boolean` | `false` | Enables in-memory event batching. |
| `batchInterval` | `number` | `10000` | Flush interval in ms when batching. |
| `maxBatchSize` | `number` | `100` | Flush immediately once the queue hits this size. |
| `sessionTimeoutMs` | `number` | `30 * 60 * 1000` | Inactivity window before a session expires. |
| `jsErrorBatchInterval` | `number` | `5 * 60 * 1000` | Flush cadence for deduplicated JS errors. |
| `debug` | `boolean` | `false` | Enables verbose internal logging (errors are always logged). |

The SDK also honors real-time flags stored on the `websites` record (e.g., `disableLocalhostTracking`, `ipBlacklist`, `discardShortSessions`, `storeRawIp`). Updates propagate automatically through the PocketBase subscription.

---

### Core APIs

#### `SkoposSDK.init(options)`
Creates a fully-initialized instance. This call authenticates, loads website configuration, subscribes to real-time changes, and sets up timers for batching and cache cleanup.

#### `trackApiEvent(req, payload)`
Consumes browser payloads produced by the Skopos client script (or any conforming source). The helper:
- validates and sanitizes the payload,
- confirms the URL matches the configured domain,
- enriches with IP/user-agent headers,
- attaches the event to the visitor/session, and
- queues (or immediately sends) it to PocketBase.

Use this inside the route that receives events from your public site.

#### `trackServerEvent(req, eventName, siteId?, customData?)`
Emits backend-only events (webhook callbacks, cron executions, purchases, etc.). `siteId` lets you override the default tracker for multi-tenant services.

#### `identify(req, userId, userData?)`
Links the hashed visitor with a known account. Call it after your authentication flow resolves so the dashboard can show user journeys and metadata. `userData` lets you persist `name`, `email`, `phone`, and arbitrary JSON metadata (up to 8 KB).

#### `flushEvents()`
Immediately send whatever is sitting in the batch queue. Useful before short-lived serverless functions exit.

#### `shutdown()`
Clears timers, unsubscribes from PocketBase, flushes events and JS errors, and resolves once data is safe. Always await this during process shutdown so you do not lose telemetry.

---

### Browser Payload Contract

```jsonc
{
	"type": "pageView" | "custom" | "jsError",
	"name": "checkout",
	"url": "https://app.example.com/checkout",
	"referrer": "https://google.com",
	"screenWidth": 1920,
	"screenHeight": 1080,
	"language": "en-US",
	"customData": { "plan": "pro" },
	"errorMessage": "TypeError: ...",
	"stackTrace": "Error..."
}
```

The SDK automatically rejects malformed data, non-HTTP(S) URLs, oversized payloads, or custom objects containing prototype-polluting keys.

---

### Sessions, Visitors, and Engagement
- Visitors are anonymized via SHA-256 of `siteId + ip + user-agent`.
- Sessions expire after `sessionTimeoutMs` of inactivity. A cached session will renew as long as the SDK can still write to PocketBase.
- Engagement is tracked when either multiple events exist or a `duration` custom field exceeds 10 seconds. This drives the engagement rate surfaced in the dashboard.
- If `discardShortSessions` is true, sub-second sessions are removed automatically by both the SDK cache and scheduled cleanup jobs.

### Error Tracking
`trackApiEvent` accepts a `type: "jsError"` payload. The SDK hashes `errorMessage + stack trace` so repeated crashes are merged. Batched errors persist to the `js_errors` collection during `_flushJsErrors()`.

### Graceful Operation Checklist
1. **Always await `SkoposSDK.init` before sending events.**
2. **Process signals** (`SIGINT`, `SIGTERM`) and call `sdk.shutdown()`.
3. **Leave the process running** long enough for timers to flush (if you cannot, call `flushEvents()` / `_flushJsErrors()` manually).
4. **Monitor logs** with `debug: true` in staging to verify PocketBase auth, website subscriptions, and queue flushes.

---

### Advanced Usage

| Scenario | Pattern |
| --- | --- |
| **Serverless or short-lived jobs** | Call `await sdk.flushEvents()` (and optionally the internal `_flushJsErrors()` promise) right before returning a response. Consider reducing `batchInterval` so queues stay small. |
| **Multi-tenant apps** | Either instantiate one SDK per tenant or shard requests through a pool keyed by `siteId`. Because session caches are isolated per instance, avoid sharing one SDK if tenants receive very high traffic. |
| **Background workers** | Import the SDK in the worker, reuse `trackServerEvent` for cron results, and reuse `.identify` when a job associates events with known accounts. |
| **Custom ingestion endpoints** | If you proxy from other languages, ensure their payload matches the [contract](#browser-payload-contract) and reuse `trackApiEvent` by mimicking an `IncomingMessage` for headers/IP. |
| **Advanced batching** | Combine `batch: true`, `maxBatchSize`, and the optional `batchInterval` override to fine-tune throughput. Monitor logs for "Flushing X events" to verify the configuration. |

---

### Testing & Observability

- **Unit tests**: Stub the PocketBase client and assert `_sendEvent` receives sanitized payloads. Since the SDK validates data, feed representative `ApiEventPayload` fixtures into `trackApiEvent`.
- **Integration tests**: Start a disposable PocketBase instance (or use the real API in a sandbox), run `SkoposSDK.init`, invoke your ingestion route, and confirm records exist in `visitors`, `sessions`, and `events`.
- **Logging**: The SDK emits human-friendly logs via `_log`. Keep `debug: true` in staging to watch session cache churn, batch flushes, and admin re-auth events.
- **Metrics**: Wrap `flushEvents` / `_sendEvent` calls with your own timers to export queue sizes, flush durations, and error counts to Prometheus or another APM.

---

### TypeScript Support
Importing the package automatically picks up `index.d.ts`. If you prefer named imports:

```ts
import type { ApiEventPayload, SkoposSDKOptions } from "@alphasystem/skopos";
```

---

### FAQ

**How do I rotate PocketBase admin credentials without downtime?**  Update the environment variables, restart your process, and the SDK will authenticate with the new credentials during `init`. If you rotate while the process runs, trigger `ensureAdminAuth` by revoking the old token so the SDK re-authenticates.

**Can I disable geo lookups?**  Not currently, but you can fork `modules/utils.js` and stub `geoip-lite.lookup` to return `null` if you need to avoid country/state enrichment.

**Is batching ordered?**  Yes. Events are flushed FIFO. If ordering matters across multiple server instances, send routing keys through your load balancer so related traffic lands in the same process.

---

### Troubleshooting

| Symptom | How to fix |
| --- | --- |
| `SkoposSDK: Website ... not found` | Ensure the `trackingId` exists in PocketBase and matches the `siteId` parameter. |
| `Admin authentication failed` | Double-check `POCKETBASE_URL`, `adminEmail`, and `adminPassword`. Admin auth is mandatory for mutating collections. |
| Events rejected due to hostname mismatch | The browser payload `url` must share the same base domain as the `websites.domain` field (subdomains are allowed). |
| No data arrives when running locally | Disable localhost filtering in the website record or set `disableLocalhostTracking = false`. |
| Duplicate visitors from reverse proxies | Forward the original IP in `x-forwarded-for` and ensure your proxy is trusted. |
