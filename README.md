# Skopos Analytics - NodeJS SDK

[![NPM Version](https://img.shields.io/npm/v/@alphasystem/skopos.svg)](https://www.npmjs.com/package/@alphasystem/skopos)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

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

### 4. Identifying Users (`identify`)

Use the `identify` method to associate an anonymous visitor with your internal user ID after they log in or register. This enables tracking user journeys across multiple sessions and devices.

**Note:** If a visitor record doesn't exist yet, the SDK will automatically create one. This means you can call `identify()` at any time, even before the user has triggered any tracking events.

**Example in a login handler:**

```javascript
app.post("/auth/login", async (req, res) => {
  // Your authentication logic
  const user = await authenticateUser(req.body.email, req.body.password);

  if (user) {
    // Link the anonymous visitor to this authenticated user
    if (skopos) {
      await skopos.identify(
        req,
        user.id, // Your internal user ID
        {
          name: user.name,
          email: user.email,
          phone: user.phone,
          metadata: {
            accountTier: user.tier,
            signupDate: user.createdAt,
          },
        },
      );
    }

    res.json({ success: true, user });
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
});
```

**Example in a registration handler:**

```javascript
app.post("/auth/register", async (req, res) => {
  // Create the new user
  const newUser = await createUser(req.body);

  if (skopos) {
    // Identify the visitor as this new user
    await skopos.identify(req, newUser.id, {
      name: newUser.name,
      email: newUser.email,
    });
  }

  res.json({ success: true, user: newUser });
});
```

### 5. Graceful Shutdown

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

## Configuration Options

| Option                    | Type      | Required | Description                                                                              | Default   |
| :------------------------ | :-------- | :------- | :--------------------------------------------------------------------------------------- | :-------- |
| `siteId`                  | `string`  | **Yes**  | The tracking ID for your website, found on the "Websites" page of your Skopos dashboard. |           |
| `pocketbaseUrl`           | `string`  | **Yes**  | The full URL to your PocketBase instance (e.g., `http://127.0.0.1:8090`).                |           |
| `adminEmail`              | `string`  | **Yes**  | The email for a PocketBase admin or superuser account.                                   |           |
| `adminPassword`           | `string`  | **Yes**  | The password for the PocketBase admin account.                                           |           |
| `batch`                   | `boolean` | No       | Set to `true` to enable event batching for improved performance. Recommended for production. | `false`   |
| `batchInterval`           | `number`  | No       | The interval in milliseconds to send batched events.                                     | `10000`   |
| `maxBatchSize`            | `number`  | No       | The maximum number of events to queue before flushing.                                   | `100`     |
| `sessionTimeoutMs`        | `number`  | No       | Duration in milliseconds before a visitor's session is considered expired.               | `1800000` |
| `jsErrorBatchInterval`    | `number`  | No       | Interval in milliseconds to send batched JavaScript error reports.                       | `300000`  |
| `debug`                   | `boolean` | No       | Set to `true` to enable verbose debug logging. Useful for troubleshooting.              | `false`   |

## API Reference

### `SkoposSDK.init(options)`

Initializes the SDK. This is a static, async method that returns a promise resolving to an SDK instance.

**Parameters:**
- `options`: `SkoposSDKOptions` object (see Configuration Options above).

**Returns:** `Promise<SkoposSDK>`

**Throws:** Error if authentication fails or website not found.

---

### `skopos.trackApiEvent(req, payload)`

Processes a rich data payload from the `skopos.js` client script. This is the main method for tracking user activity.

**Parameters:**
- `req`: The Node.js `IncomingMessage` object from your server framework.
- `payload`: An `ApiEventPayload` object, typically from `req.body`.

**Returns:** `void` (fire-and-forget, processes in background)

**Note:** This method validates domain, filters bots, checks IP blacklist, and enforces localhost tracking settings automatically.

---

### `skopos.trackServerEvent(req, eventName, [customData], [siteId])`

Tracks a backend-only event (e.g., webhooks, cron jobs, API calls).

**Parameters:**
- `req`: The Node.js `IncomingMessage` object.
- `eventName`: `string` - A descriptive name for the event (e.g., "payment_completed").
- `customData` (optional): `Record<string, any>` - A JSON-serializable object for additional event details.
- `siteId` (optional): `string` - Overrides the default `siteId` set during initialization.

**Returns:** `void` (fire-and-forget, processes in background)

---

### `skopos.identify(req, userId, [userData])`

Associates an anonymous visitor with user identification data. Should be called after a user logs in or registers to enable cross-session and cross-device tracking.

**Parameters:**
- `req`: The Node.js `IncomingMessage` object.
- `userId`: `string` - Your internal user ID (required).
- `userData` (optional): `IdentifyData` object with the following optional fields:
  - `name`: `string` - The user's full name (max 255 characters).
  - `email`: `string` - The user's email address (max 255 characters, validated format).
  - `phone`: `string` - The user's phone number (max 50 characters).
  - `metadata`: `Record<string, any>` - Custom JSON-serializable data (max 8KB).

**Returns:** `Promise<void>` - Resolves when the visitor has been identified.

**Note:** If the visitor doesn't exist yet, a new visitor record will be automatically created.

---

### `skopos.flushEvents()`

Manually flushes any queued events to the database. Normally called automatically by the batch interval, but can be called manually if needed.

**Returns:** `Promise<void>`

---

### `skopos.shutdown()`

Gracefully shuts down the SDK by clearing all timers and flushing any remaining events. **Must be called before process exit** to prevent data loss.

**Returns:** `Promise<void>`

## Best Practices

### 1. Use Environment Variables

Never hardcode credentials in your source code:

```javascript
// .env file
POCKETBASE_URL=https://pb.example.com
SKOPOS_SITE_ID=abc123xyz
POCKETBASE_ADMIN_EMAIL=admin@example.com
POCKETBASE_ADMIN_PASSWORD=your-secure-password

// In your code
import dotenv from "dotenv";
dotenv.config();

const skopos = await SkoposSDK.init({
  siteId: process.env.SKOPOS_SITE_ID,
  pocketbaseUrl: process.env.POCKETBASE_URL,
  adminEmail: process.env.POCKETBASE_ADMIN_EMAIL,
  adminPassword: process.env.POCKETBASE_ADMIN_PASSWORD,
});
```

### 2. Enable Batching in Production

Batching significantly reduces database load and improves performance:

```javascript
const skopos = await SkoposSDK.init({
  // ... other options
  batch: true,
  batchInterval: 10000, // 10 seconds
  maxBatchSize: 100,
});
```

### 3. Don't Block Responses

Never await `trackApiEvent` or `trackServerEvent` (they're fire-and-forget). Only await `identify()`:

```javascript
// ❌ Bad: Blocks the response
app.post("/api/event", async (req, res) => {
  await skopos.trackApiEvent(req, req.body); // Don't do this!
  res.status(204).send();
});

// ✅ Good: Fire and forget
app.post("/api/event", (req, res) => {
  skopos.trackApiEvent(req, req.body);
  res.status(204).send();
});

// ✅ Also good: identify() should be awaited
app.post("/auth/login", async (req, res) => {
  const user = await authenticateUser(req.body);
  await skopos.identify(req, user.id, { name: user.name });
  res.json({ success: true });
});
```

### 4. Implement Graceful Shutdown

Always flush events before your process exits:

```javascript
async function gracefulShutdown() {
  console.log("Shutting down gracefully...");
  if (skopos) {
    await skopos.shutdown();
  }
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
```

## Troubleshooting

### Events Not Appearing

1. ✅ Verify the SDK is initialized with the correct `siteId`
2. ✅ Check that your website domain matches the origin of incoming requests
3. ✅ Ensure the client-side script has the correct `data-endpoint`
4. ✅ Look for validation errors in your server logs (enable `debug: true`)
5. ✅ Check if the IP is in the blacklist or localhost tracking is disabled

### High Memory Usage

- Reduce `maxBatchSize` (e.g., to 50)
- Decrease `batchInterval` to flush more frequently
- Reduce `sessionTimeoutMs` if you have high traffic

### Authentication Errors

- Verify admin credentials are still valid
- Check PocketBase is accessible from your server
- Ensure admin account hasn't been disabled

## Documentation

For complete documentation, see:
- [SDK Documentation](https://docs.alphasystem.dev/view/xfdb25r821hx04d)
- [Client-Side Script Guide](https://docs.alphasystem.dev/view/cfbuhl4n4j4h0xj)
- [Dashboard Guide](https://docs.alphasystem.dev/view/kgq24zxepony7w2)

## Requirements

- **Node.js**: 18.x or higher
- **PocketBase**: 0.20.0 or higher

## License

MIT