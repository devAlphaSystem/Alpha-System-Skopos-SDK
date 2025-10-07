# Skopos Analytics - NodeJS SDK

[![NPM Version](https://img.shields.io/npm/v/@alphasystem/skopos.svg)](https://www.npmjs.com/package/@alphasystem/skopos)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The official server-side NodeJS SDK for Skopos, the open-source, privacy-first, self-hosted website analytics platform.

This SDK is designed to work in tandem with the `skopos.js` client-side script. It processes incoming tracking data, manages sessions, and provides methods for tracking backend-only events.

## Core Philosophy: A Clear Separation of Concerns

Skopos uses a hybrid tracking model with a clear purpose for each component:

1.  **Client-Side Tracking (For All User Activity)**: The lightweight `skopos.js` script is the definitive tool for tracking user behavior. It runs in the browser, captures rich context (screen size, UTMs, etc.), and sends this data to a dedicated API endpoint on your server. **All page views and user interactions should be tracked this way.**

2.  **Server-Side Tracking (For Backend-Only Events)**: This SDK is responsible for processing data from the client script via your API endpoint. It also provides a method to track events that happen exclusively on your backend, such as API calls, webhooks, or scheduled tasks.

## Features

- **Secure by Default**: Authenticates as a PocketBase admin, so your collection rules can remain locked down.
- **Focused API**: A clear distinction between handling rich client data (`trackApiEvent`) and tracking backend-only actions (`trackServerEvent`).
- **Automatic Session Management**: Manages visitor lifecycles without cookies using anonymized identifiers.
- **SPA Ready**: The client-server architecture works perfectly with Single-Page Applications.
- **Intelligent Bot Filtering**: Filters out known bots and crawlers to keep your data clean.
- **Performant Batching**: Optional event batching to reduce database load under high traffic.
- **TypeScript Support**: Ships with detailed type definitions for a better development experience.

## Installation

```bash
npm install @alphasystem/skopos
```

## Usage

### 1. Initialization

In your main server file (e.g., `server.js` or `app.js`), initialize the SDK once when your application starts. It's recommended to use environment variables for sensitive credentials.

```javascript
// server.js
const SkoposSDK = require("@alphasystem/skopos");

let skopos;

async function initializeSkopos() {
  try {
    skopos = await SkoposSDK.init({
      pocketbaseUrl: process.env.POCKETBASE_URL,
      siteId: process.env.SKOPOS_SITE_ID, // Required!
      adminEmail: process.env.POCKETBASE_ADMIN_EMAIL,
      adminPassword: process.env.POCKETBASE_ADMIN_PASSWORD,
    });
    console.log("Skopos SDK initialized successfully.");
  } catch (error) {
    console.error("Failed to initialize Skopos SDK:", error);
    // Exit if analytics are critical to your application
    process.exit(1);
  }
}

// Call initialization
initializeSkopos();

// ... rest of your server setup (Express, etc.)
```

### 2. Tracking Client-Side Activity (`trackApiEvent`)

This is the **primary method** for all analytics related to user activity. Create an API endpoint that receives data from the `skopos.js` client script and passes it to this method.

**Example using Express.js:**

```javascript
const express = require("express");
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// The endpoint that skopos.js will send data to
app.post("/api/event", (req, res) => {
  // Check if SDK is initialized and body is present
  if (skopos && req.body) {
    // Pass the request and the payload to the SDK
    skopos.trackApiEvent(req, req.body);
  }
  // Respond immediately with 202 Accepted. Don't wait for the SDK.
  res.status(202).send("Accepted");
});

// ... your other routes
```

### 3. Tracking Server-Side Events (`trackServerEvent`)

Use this method to track actions that happen exclusively on your backend and are not directly initiated by a user in a browser session (e.g., a payment processing webhook, a cron job, a file being generated).

**Example in a webhook handler:**

```javascript
app.post("/api/webhook/payment-processed", async (req, res) => {
  // Your business logic for handling the payment
  // ...

  // Track the server-side event
  if (skopos) {
    skopos.trackServerEvent(
      req, // The request object is still needed to identify the user session
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

## Advanced Configuration (Batching)

For high-traffic sites, you can enable event batching to reduce the number of writes to your PocketBase instance. Events are collected in a queue and sent in a single batch.

```javascript
skopos = await SkoposSDK.init({
  pocketbaseUrl: process.env.POCKETBASE_URL,
  siteId: process.env.SKOPOS_SITE_ID,
  adminEmail: process.env.POCKETBASE_ADMIN_EMAIL,
  adminPassword: process.env.POCKETBASE_ADMIN_PASSWORD,

  // Batching options
  batch: true, // Enable batching
  batchInterval: 15000, // Send events every 15 seconds
  maxBatchSize: 200, // ...or when 200 events are in the queue
});
```

## API Reference

#### `SkoposSDK.init(options)`

Initializes the SDK. This is a static, async method that returns a promise resolving to an SDK instance.

- `options`: `SkoposSDKOptions` object. `siteId` is required.

#### `skopos.trackApiEvent(req, payload)`

Processes a rich data payload from the `skopos.js` client script. This should be your main method for tracking user activity.

- `req`: The Node.js `IncomingMessage` object from your server framework.
- `payload`: An `ApiEventPayload` object, typically from `req.body`.

#### `skopos.trackServerEvent(req, eventName, [customData], [siteId])`

Tracks a backend-only event.

- `req`: The Node.js `IncomingMessage` object.
- `eventName`: `string` - A descriptive name for the event (e.g., "user-signup-bonus-applied").
- `customData` (optional): `Record<string, any>` - A JSON-serializable object for additional event details.
- `siteId` (optional): `string` - Overrides the default `siteId` set during initialization.

#### `skopos.shutdown()`

Flushes any batched events and clears the batching interval timer. Returns a `Promise` that resolves when the flush is complete.
