# Skopos Analytics - NodeJS SDK

[![NPM Version](https://img.shields.io/npm/v/@alphasystem/skopos.svg)](https://www.npmjs.com/package/@alphasystem/skopos)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The official server-side NodeJS SDK for Skopos, the open-source, privacy-first, self-hosted website analytics platform.

This SDK works in tandem with the `skopos.js` client-side script and the Skopos Dashboard. It processes incoming tracking data, manages sessions, and provides methods for tracking backend-only events.

## Core Philosophy: A Clear Separation of Concerns

Skopos uses a hybrid tracking model with a clear purpose for each component:

1.  **Client-Side Tracking (For All User Activity)**: The lightweight `skopos.js` script is the definitive tool for capturing rich, contextual user activity. It runs in the browser, captures screen size, referrers, and more, sending this data to a dedicated API endpoint on your server. **All page views and user interactions should be tracked this way.**

2.  **Server-Side Tracking (For Backend-Only Events)**: This SDK is responsible for securely processing data from the client script via your API endpoint. It also provides a method to track events that happen exclusively on your backend, such as API calls, webhooks, or scheduled tasks.

## Features

- **Secure by Default**: Authenticates as a PocketBase admin, so your collection rules can remain locked down.
- **Focused API**: A clear distinction between handling rich client data (`trackApiEvent`) and tracking backend-only actions (`trackServerEvent`).
- **Automatic Session Management**: Manages visitor lifecycles without cookies using anonymized identifiers.
- **Dashboard-Driven Configuration**: Automatically syncs and respects settings like IP blacklists and localhost tracking configured in the UI.
- **Intelligent Bot Filtering**: Filters out known bots and crawlers to keep your data clean.
- **Performant Batching**: Optional event batching to reduce database load under high traffic.
- **TypeScript Support**: Ships with detailed type definitions for a better development experience.

## Installation

```bash
npm install @alphasystem/skopos
```

## Usage

### 1. Initialization

In your main server file (e.g., `server.js`), initialize the SDK once when your application starts. It's recommended to use environment variables for sensitive credentials.

```javascript
// server.js
import SkoposSDK from "@alphasystem/skopos";
import express from "express";

const app = express();
let skopos;

async function startServer() {
  try {
    skopos = await SkoposSDK.init({
      pocketbaseUrl: process.env.POCKETBASE_URL,
      siteId: process.env.SKOPOS_SITE_ID, // Required!
      adminEmail: process.env.POCKETBASE_ADMIN_EMAIL,
      adminPassword: process.env.POCKETBASE_ADMIN_PASSWORD,
    });
    console.log("Skopos SDK initialized successfully.");

    // Start your server after the SDK is ready
    app.listen(3000, () => console.log("Server running on port 3000"));
  } catch (error) {
    console.error("Failed to initialize Skopos SDK:", error);
    process.exit(1);
  }
}

startServer();

// ... rest of your server setup (Express, etc.)
```

### 2. Tracking Client-Side Activity (`trackApiEvent`)

This is the **designated method** for handling all user-driven activity. Create an API endpoint that receives data from the `skopos.js` client script and passes it to this method.

**Example using Express.js:**

```javascript
import express from "express";
const router = express.Router();

// Middleware to parse JSON bodies
app.use(express.json());

// The endpoint that skopos.js will send data to
router.post("/api/event", (req, res) => {
  if (skopos && req.body) {
    // This method is 'fire-and-forget'. It processes in the background.
    skopos.trackApiEvent(req, req.body);
  }
  // Respond immediately. Don't wait for the SDK to finish processing.
  res.status(204).send();
});

export default router;
```

### 3. Tracking Server-Side Events (`trackServerEvent`)

Use this method to track actions that happen exclusively on your backend (e.g., a payment processing webhook, a cron job, a file being generated).

**Example in a webhook handler:**

```javascript
app.post("/api/webhook/payment-processed", async (req, res) => {
  // Your business logic for handling the payment
  // ...

  if (skopos) {
    // The request object is used to link the event to a user session if possible
    skopos.trackServerEvent(
      req,
      "payment-webhook-received", // The name of the event
      {
        // Optional custom data
        source: "stripe",
        invoiceId: req.body.invoiceId,
        amount: req.body.amount,
      },
    );
  }

  res.status(200).send("OK");
});
```

### 4. Graceful Shutdown

To ensure no batched data is lost when your server restarts or shuts down, add a shutdown hook. This will flush any pending events in the queue.

```javascript
async function gracefulShutdown() {
  console.log("Shutting down gracefully...");
  if (skopos) {
    await skopos.shutdown();
    console.log("Skopos SDK flushed.");
  }
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
```

## API Reference

### `SkoposSDK.init(options)`

Initializes the SDK. This is a static, async method that returns a promise resolving to an SDK instance.

- `options`: `SkoposSDKOptions` object.

| Option                    | Type      | Required | Description                                                                              | Default   |
| :------------------------ | :-------- | :------- | :--------------------------------------------------------------------------------------- | :-------- |
| `siteId`                  | `string`  | **Yes**  | The tracking ID for your website, found on the "Websites" page of your Skopos dashboard. |           |
| `pocketbaseUrl`           | `string`  | **Yes**  | The full URL to your PocketBase instance (e.g., `http://127.0.0.1:8090`).                |           |
| `adminEmail`              | `string`  | **Yes**  | The email for a PocketBase admin or superuser account.                                   |           |
| `adminPassword`           | `string`  | **Yes**  | The password for the PocketBase admin account.                                           |           |
| `batch`                   | `boolean` | No       | Set to `true` to enable event batching for improved performance.                         | `false`   |
| `batchInterval`           | `number`  | No       | The interval in milliseconds to send batched events.                                     | `10000`   |
| `maxBatchSize`            | `number`  | No       | The maximum number of events to queue before flushing.                                   | `100`     |
| `sessionTimeoutMs`        | `number`  | No       | Duration in milliseconds before a visitor's session is considered expired.               | `1800000` |
| `jsErrorBatchInterval`    | `number`  | No       | Interval in milliseconds to send batched JavaScript error reports.                       | `300000`  |
| `configRefreshIntervalMs` | `number`  | No       | Interval in milliseconds to automatically refresh website settings.                      | `900000`  |

---

### `skopos.trackApiEvent(req, payload)`

Processes a rich data payload from the `skopos.js` client script. This is the main method for tracking user activity.

- `req`: The Node.js `IncomingMessage` object from your server framework.
- `payload`: An `ApiEventPayload` object, typically from `req.body`.

---

### `skopos.trackServerEvent(req, eventName, [customData], [siteId])`

Tracks a backend-only event.

- `req`: The Node.js `IncomingMessage` object.
- `eventName`: `string` - A descriptive name for the event (e.g., "user-signup-bonus-applied").
- `customData` (optional): `Record<string, any>` - A JSON-serializable object for additional event details.
- `siteId` (optional): `string` - Overrides the default `siteId` set during initialization.

---

### `skopos.shutdown()`

Flushes any batched events and clears all interval timers. Returns a `Promise` that resolves when the flush is complete.
