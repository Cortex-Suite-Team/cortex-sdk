# API Reference

Complete reference for all public API surface of the Cortex SDK. One class, five methods, three properties.

---

## Class: CortexClient

The only public class in the SDK. One instance manages one runtime session.

```js
// JavaScript (Browser and Node.js)
import { CortexClient } from "@cortex-suite/sdk";
const client = new CortexClient(options);
```

```python
# Python
from cortex_sdk import CortexClient
client = CortexClient(**options)
```

### Constructor options

| JS / Node.js option | Python option | Type | Required | Default | Description |
|---|---|---|---|---|---|
| `apiKey` | `api_key` | string | **yes** | — | Cortex API key |
| `onMessage` | `on_message` | function | **yes** | — | Callback for all incoming messages |
| `authUrl` | `auth_url` | string | no | `https://cortexsuite.app` | Auth service base URL (no trailing path) |
| `connectTimeout` | `connect_timeout` | integer | no | `10000` / `10` | `connect()` timeout in ms (JS) or s (Python) |
| `sendTimeout` | `send_timeout` | integer | no | `10000` / `10` | `sendMessage()` timeout in ms (JS) or s (Python) |
| `resyncTimeout` | `resync_timeout` | integer | no | `15000` / `15` | Resync timeout in ms (JS) or s (Python) |
| `pingInterval` | `ping_interval` | integer | no | `15000` / `15` | Heartbeat interval in ms (JS) or s (Python) |
| `pongTimeout` | `pong_timeout` | integer | no | `5000` / `5` | Pong wait timeout in ms (JS) or s (Python) |
| `staleThreshold` | `stale_threshold` | integer | no | `45000` / `45` | Stale channel threshold in ms (JS) or s (Python) |

---

## Methods

### `connect()`

Opens the session. Runs the full bootstrap: auth exchange → WebSocket open → session initialization → liveness start. Returns when session state is `ACTIVE`.

```js
// JavaScript (Browser and Node.js)
await client.connect();
```

```python
# Python
await client.connect()
```

**Returns:** `Promise<void>` / coroutine

**Throws:** `CortexError` with `code: "auth_invalid"` or `code: "auth_refresh_failed"` on fatal auth failure. Transient network failures are retried automatically.

---

### `disconnect()`

Closes the session cleanly. Stops liveness monitoring, cancels pending reconnect, closes the WebSocket. Session moves to `STOPPED`.

```js
// JavaScript (Browser and Node.js)
await client.disconnect();
```

```python
# Python
await client.disconnect()
```

**Returns:** `Promise<void>` / coroutine

---

### `onMessage(handler)` (JavaScript / Node.js only)

Registers an additional inbound message handler without replacing the constructor callback.

```js
const unsubscribe = client.onMessage((message) => {
  console.log(message.type, message.payload);
});
```

Behavior:

- constructor `onMessage` remains required
- constructor `onMessage` runs first
- subscribed handlers run after that in insertion order
- subscribed handler failures are isolated so later handlers still run
- the return value unsubscribes that one handler

This method is additive transport subscription plumbing. It does not replace the main callback contract.

---

### `sendMessage(options)` / `send_message(content, attachments?)`

Sends a chat message to the runtime over the WebSocket.

```js
// JavaScript (Browser and Node.js)
await client.sendMessage({ content: "Hello" });

// With attachments:
await client.sendMessage({
  content: "Analyze this document.",
  attachments: ["att_abc123"],
});
```

```python
# Python
await client.send_message(content="Hello")

# With attachments:
await client.send_message(
    content="Analyze this document.",
    attachments=["sf_abc123"],
)
```

**Parameters:**

| Parameter | JS/Node type | Python type | Required | Description |
|---|---|---|---|---|
| `content` | `string` | `str` | **yes** | Message text |
| `attachments` | `(string \| SessionFileAttachment)[]` | `list[str \| SessionFileAttachment]` | no | Canonical `sf_...` references from upload; serialized as `payload.meta.attachments[].file_ref` |

**Returns:** `Promise<void>` / coroutine

**Throws:** `CortexError` with `code: "transport_send_timeout"` if the message cannot be delivered within `sendTimeout`.

---

### `uploadAttachment(file)` / `upload_attachment(file)`

Uploads a file through SessionManager and returns a canonical `sf_...` `file_ref` for use in `sendMessage()`.

```js
// JavaScript (Browser)
const fileRef = await client.uploadAttachment(fileObject);     // File or Blob

// JavaScript (Node.js)
const fileRef = await client.uploadAttachment("./report.pdf"); // file path string
const fileRef = await client.uploadAttachment(buffer);          // Buffer or Uint8Array
```

```python
# Python
file_ref = await client.upload_attachment("./report.pdf")  # file path string
file_ref = await client.upload_attachment(file_bytes)       # bytes
```

**Accepted input types:**

| Binding | Accepted types |
|---|---|
| JavaScript (Browser) | `File`, `Blob`, `ArrayBuffer` |
| JavaScript (Node.js) | File path `string`, `Buffer`, `Uint8Array`, `ReadableStream` |
| Python | File path `str`, `bytes`, file-like object |

**Returns:** `Promise<string>` / `str` — a canonical `sf_...` `file_ref`. Missing, malformed, or identity-leaking completion payloads fail with `invalid_file_transfer`.

**Throws:** `CortexError` using the canonical `file_*` / `invalid_file_transfer` public codes documented in [Error Handling](./error-handling.md).

---

### `stop()`

Sends a stop signal to the runtime. The session transitions to `STOPPED`. Use this to interrupt an in-progress response.

```js
// JavaScript (Browser and Node.js)
await client.stop();
```

```python
# Python
await client.stop()
```

**Returns:** `Promise<void>` / coroutine

After `stop()`, the session is in a terminal state. Create a new `CortexClient` to start a new session.

---

## Properties

All properties are **read-only**.

### `sessionState` / `session_state`

Current session state string.

```js
// JavaScript (Browser and Node.js)
client.sessionState // → string
```

```python
# Python
client.session_state  # → str
```

**Possible values:** `"CREATED"` | `"INITIALIZING"` | `"ACTIVE"` | `"WAITING"` | `"COMPLETED"` | `"FAILED"` | `"STOPPED"` | `"TIMEOUT"` | `"CANCELLED"`

Terminal states: `COMPLETED`, `FAILED`, `STOPPED`, `TIMEOUT`, `CANCELLED`

---

### `channelState` / `channel_state`

Current WebSocket channel state string.

```js
// JavaScript (Browser and Node.js)
client.channelState // → string
```

```python
# Python
client.channel_state  # → str
```

**Possible values:** `"CONNECTING"` | `"OPEN"` | `"STALE"` | `"RECONNECTING"` | `"CLOSED"` | `"AUTH_FAILED"`

---

### `sessionId` / `session_id`

The session ID assigned by the runtime. `null` / `None` until `connect()` completes successfully.

```js
// JavaScript (Browser and Node.js)
client.sessionId // → string | null
```

```python
# Python
client.session_id  # → str | None
```

---

## Message envelope fields

Every message delivered to `onMessage` / `on_message` follows this structure:

| Field | Type | Description |
|---|---|---|
| `type` | string | Message type identifier (`chat::partial`, `chat::answer`, `system::warning`, `system::error`) |
| `schema` | string | Protocol schema version (currently `"1.0"`) |
| `session_id` | string | Session this message belongs to |
| `seq` | integer | Server-assigned sequence number, monotonically increasing |
| `payload` | object | Message-specific content; fields vary by `type` |
| `meta` | object | Optional metadata; may be absent |
| `ts` | string | ISO-8601 UTC timestamp |

---

## CortexError class

All SDK errors are `CortexError` instances.

| Field | Type | Description |
|---|---|---|
| `code` | string | Canonical error code (see [Error Handling](error-handling.md)) |
| `message` | string | Human-readable description |
| `retryable` | boolean | Whether the SDK retries this automatically |
| `fatal` | boolean | Whether the session is unrecoverable |

**JavaScript:** `CortexError` is thrown directly; no import needed.

**Python:** Must be imported explicitly:

```python
# Python
from cortex_sdk import CortexClient, CortexError

try:
    await client.connect()
except CortexError as e:
    print(e.code, e.message, e.retryable, e.fatal)
```

