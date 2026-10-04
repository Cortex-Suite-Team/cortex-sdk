# Error Handling

---

## Two error delivery paths

Errors arrive through two separate channels:

**Path 1 — Thrown from method calls.** `connect()`, `sendMessage()`, and `uploadAttachment()` throw (raise) a `CortexError` when a fatal or unrecoverable condition occurs. Handle these with `try/catch` / `try/except`.

**Path 2 — `system::error` messages in the callback.** The runtime sends `system::error` messages over the WebSocket for errors that occur during session execution. These arrive in your `onMessage` / `on_message` callback.

Missing either path is a common source of unhandled errors. Both need to be handled.

---

## The CortexError object

All SDK errors are instances of `CortexError`. It carries four fields:

| Field | Type | Description |
|---|---|---|
| `code` | string | Canonical error code. Use this for programmatic handling. |
| `message` | string | Human-readable description. Use this for logging. |
| `retryable` | boolean | Whether the SDK will retry this automatically. |
| `fatal` | boolean | Whether the session is unrecoverable and a new client is required. |

```js
// JavaScript (Browser and Node.js)
// CortexError shape:
// {
//   code: "auth_invalid",
//   message: "API key was rejected",
//   retryable: false,
//   fatal: true
// }
```

```python
# Python
from cortex_sdk import CortexError

# CortexError fields:
# e.code      → "auth_invalid"
# e.message   → "API key was rejected"
# e.retryable → False
# e.fatal     → True
```

In Python, `CortexError` must be imported explicitly:

```python
# Python
from cortex_sdk import CortexClient, CortexError
```

---

## Fatal vs non-fatal errors

**Non-fatal errors** (`fatal: false`) are handled by the SDK automatically. The SDK retries the operation according to its internal backoff schedule. You may observe these as `system::error` messages in the callback, but no action is required from your code.

**Fatal errors** (`fatal: true`) mean the session is unrecoverable. The SDK stops reconnecting. **Your code must create a new `CortexClient` instance and call `connect()` again.**

---

## Error codes reference

### Auth errors

| Code | Retryable | Fatal | Meaning |
|---|---|---|---|
| `auth_invalid` | no | **yes** | API key was rejected by the auth service |
| `auth_expired` | yes | no | Access token expired; SDK refreshes automatically |
| `auth_refresh_failed` | no | **yes** | Refresh token expired or invalid; re-initialize the client |

`auth_expired` is handled internally — you will not normally see it unless you are inspecting `system::error` messages for diagnostic purposes.

### Transport errors

| Code | Retryable | Fatal | Meaning |
|---|---|---|---|
| `transport_connect_timeout` | yes | no | WebSocket connection attempt timed out |
| `transport_send_timeout` | yes | no | `sendMessage()` could not deliver within `sendTimeout` |
| `transport_protocol_violation` | no | **yes** | Malformed transport-level behavior detected |

### Session errors

| Code | Retryable | Fatal | Meaning |
|---|---|---|---|
| `unknown_session` | no | **yes** | Session ID not recognized by the runtime |
| `session_terminal` | no | **yes** | Message sent to a session that has already ended |

### Resync errors

| Code | Retryable | Fatal | Meaning |
|---|---|---|---|
| `resync_timeout` | yes | no | Resync attempt after reconnect timed out; SDK will retry |
| `replay_unavailable` | yes | no | Runtime replay artifacts temporarily unavailable |

### Session file errors

| Code | Retryable | Fatal | Meaning |
|---|---|---|---|
| `file_transport_unavailable` | yes | no | Session file transport is temporarily unavailable |
| `file_too_large` | no | no | File exceeds the allowed size limit |
| `file_type_rejected` | no | no | File type is not accepted by the runtime |
| `invalid_file_transfer` | no | no | File transfer protocol validation failed |
| `file_transfer_interrupted` | yes | no | WebSocket closed during a transfer; start the operation again |
| `file_upload_failed` | yes | no | Transient upload failure |
| `file_download_failed` | yes | no | Transient download failure |
| `file_unavailable` | yes | no | Requested session file is unavailable |

---

## Pattern: handling connect() errors

```js
// JavaScript (Browser and Node.js)
import { CortexClient } from "@cortex-suite/sdk";

const client = new CortexClient({
  apiKey: "your-api-key",
  onMessage: handleMessage,
});

try {
  await client.connect();
  // Session is ACTIVE here
} catch (err) {
  if (err.code === "auth_invalid") {
    showError("Invalid API key. Please check your credentials.");
  } else if (err.code === "auth_refresh_failed") {
    showError("Authentication expired. Please re-authenticate.");
  } else {
    // Unexpected error
    console.error("Connection failed:", err.code, err.message);
  }
}
```

```python
# Python
import asyncio
from cortex_sdk import CortexClient, CortexError

async def main():
    client = CortexClient(
        api_key="your-api-key",
        on_message=handle_message,
    )

    try:
        await client.connect()
        # Session is ACTIVE here
    except CortexError as e:
        if e.code == "auth_invalid":
            show_error("Invalid API key. Please check your credentials.")
        elif e.code == "auth_refresh_failed":
            show_error("Authentication expired. Please re-authenticate.")
        else:
            print("Connection failed:", e.code, e.message)

asyncio.run(main())
```

---

## Pattern: handling system::error in the callback

```js
// JavaScript (Browser and Node.js)
import { CortexClient } from "@cortex-suite/sdk";

let client = new CortexClient({
  apiKey: "your-api-key",
  onMessage: async (msg) => {
    if (msg.type === "system::error") {
      console.error("Runtime error:", msg.payload.code, msg.payload.message);

      if (msg.payload.fatal) {
        // Session is unrecoverable — create a new client
        client = new CortexClient({
          apiKey: "your-api-key",
          onMessage: handleMessage,
        });
        await client.connect();
      }
    }
    // handle other message types...
  },
});

await client.connect();
```

```python
# Python
import asyncio
from cortex_sdk import CortexClient

client = None

def on_message(msg):
    if msg["type"] == "system::error":
        print("Runtime error:", msg["payload"]["code"], msg["payload"]["message"])

        if msg["payload"].get("fatal"):
            # Session is unrecoverable — schedule reconnect from outside the callback
            asyncio.get_event_loop().create_task(reconnect())

async def reconnect():
    global client
    client = CortexClient(api_key="your-api-key", on_message=on_message)
    await client.connect()

async def main():
    global client
    client = CortexClient(api_key="your-api-key", on_message=on_message)
    await client.connect()

asyncio.run(main())
```

> **Note:** In Python, never `await` inside `on_message` directly — the callback is synchronous. Schedule async work with `asyncio.create_task()` or `asyncio.get_event_loop().create_task()`.

---

## Pattern: upload error handling

```js
// JavaScript (Browser and Node.js)
try {
  const attachmentId = await client.uploadAttachment("./document.pdf");
  await client.sendMessage({
    content: "Analyze this.",
    attachments: [attachmentId],
  });
} catch (err) {
  switch (err.code) {
    case "file_upload_failed":
      console.error("Upload failed — retry later.");
      break;
    case "file_too_large":
      console.error("File too large. Maximum size exceeded.");
      break;
    case "file_type_rejected":
      console.error("File type not supported.");
      break;
    default:
      console.error("Unexpected error:", err.code, err.message);
  }
}
```

```python
# Python
from cortex_sdk import CortexError

try:
    file_ref = await client.upload_attachment("./document.pdf")
    await client.send_message(
        content="Analyze this.",
        attachments=[file_ref],
    )
except CortexError as e:
    if e.code == "file_upload_failed":
        print("Upload failed — retry later.")
    elif e.code == "file_too_large":
        print("File too large. Maximum size exceeded.")
    elif e.code == "file_type_rejected":
        print("File type not supported.")
    else:
        print("Unexpected error:", e.code, e.message)
```
