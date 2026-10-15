# Getting Started

This page walks you from zero to a working Cortex SDK integration. By the end you will have a client that connects, sends a message, and handles responses.

---

## Prerequisites

| Binding | Requirement |
|---|---|
| JavaScript (Browser) | Any modern browser (Chrome 90+, Firefox 90+, Safari 15+) |
| JavaScript (Node.js) | Node.js 18 or later |
| Python | Python 3.10 or later |

---

## Install

```bash
# JavaScript (Browser and Node.js)
npm install @cortex-suite/sdk
```

```bash
# Python
pip install cortex-suite-sdk
```

---

## Your first client

The minimal integration: construct a client, connect, send a message, then disconnect cleanly.

```js
// JavaScript (Browser and Node.js)
import { CortexClient } from "@cortex-suite/sdk";

const client = new CortexClient({
  apiKey: "your-api-key",
  onMessage: (msg) => {
    console.log("Received:", msg.type, msg.payload);
  },
});

await client.connect();

await client.sendMessage({ content: "Hello, Cortex!" });

// Disconnect when you are done
await client.disconnect();
```

```python
# Python
import asyncio
from cortex_sdk import CortexClient

def on_message(msg):
    print("Received:", msg["type"], msg["payload"])

async def main():
    client = CortexClient(
        api_key="your-api-key",
        on_message=on_message,
    )

    await client.connect()

    await client.send_message(content="Hello, Cortex!")

    # Disconnect when you are done
    await client.disconnect()

asyncio.run(main())
```

Replace `"your-api-key"` with your actual Cortex API key.

---

## What just happened

When you called `connect()`, the SDK performed four steps automatically:

1. **Auth exchange** — sent your API key to the auth service and received a short-lived JWT access token and a WebSocket URL.
2. **WebSocket connection** — opened a persistent WebSocket connection to that URL.
3. **Session initialization** — the runtime assigned a session ID and moved the session to the `ACTIVE` state.
4. **Liveness monitoring** — started sending periodic heartbeat pings to detect stale connections.

`connect()` returns (resolves/completes) only after all four steps succeed and the session is `ACTIVE`. If authentication fails fatally, it throws a `CortexError` — see [Error Handling](error-handling.md).

After that, `sendMessage()` / `send_message()` transmitted your message over the WebSocket. The response arrives asynchronously in the `onMessage` / `on_message` callback.

---

## Handling responses

The runtime may send multiple messages in response to a single user message. A streaming response produces several `chat::partial` chunks followed by a final `chat::answer`. A complete message handler looks like this:

```js
// JavaScript (Browser and Node.js)
import { CortexClient } from "@cortex-suite/sdk";

const client = new CortexClient({
  apiKey: "your-api-key",
  onMessage: (msg) => {
    if (msg.type === "chat::partial") {
      process.stdout.write(msg.payload.content.join("")); // stream chunk to output
    } else if (msg.type === "chat::answer") {
      console.log("\n[Done]", msg.payload.content.join(""));
    } else if (msg.type === "system::error") {
      console.error("Error:", msg.payload.code, msg.payload.message);
    }
  },
});

await client.connect();
await client.sendMessage({ content: "Explain WebSockets in one paragraph." });
```

```python
# Python
import asyncio
from cortex_sdk import CortexClient

def on_message(msg):
    if msg["type"] == "chat::partial":
        print("".join(msg["payload"]["content"]), end="", flush=True)
    elif msg["type"] == "chat::answer":
        print("\n[Done]", "".join(msg["payload"]["content"]))
    elif msg["type"] == "system::error":
        print("Error:", msg["payload"]["code"], msg["payload"]["message"])

async def main():
    client = CortexClient(
        api_key="your-api-key",
        on_message=on_message,
    )
    await client.connect()
    await client.send_message(content="Explain WebSockets in one paragraph.")
    # Keep the event loop running to receive responses
    await asyncio.sleep(30)
    await client.disconnect()

asyncio.run(main())
```

---

## Next steps

- [Core Concepts](core-concepts.md) — understand the session/channel model before building further
- [Configuration](configuration.md) — tune timeouts and set a custom auth URL
- [Error Handling](error-handling.md) — handle auth failures and runtime errors correctly
- [File Attachments](file-attachments.md) — upload files and include them in messages
- [API Reference](api-reference.md) — complete method and property reference
