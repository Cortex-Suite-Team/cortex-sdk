# Language Notes

Reference for the differences between SDK bindings. Most developers only need this page when something works in one binding but not another.

---

## Parity rule

All three bindings implement the same API contract. Every method, every constructor option, every state value, and every error code is available in all three bindings. No feature exists in one binding and not in another.

The only permitted differences are:
- **Naming convention:** `camelCase` in JavaScript/Node.js vs `snake_case` in Python
- **Time units:** milliseconds in JavaScript/Node.js vs seconds in Python
- **File input types:** platform-native types per binding

---

## Naming convention mapping

| Concept | JS / Node.js | Python |
|---|---|---|
| Constructor option: API key | `apiKey` | `api_key` |
| Constructor option: auth base URL | `authUrl` | `auth_url` |
| Constructor option: message callback | `onMessage` | `on_message` |
| Constructor option: connect timeout | `connectTimeout` | `connect_timeout` |
| Constructor option: send timeout | `sendTimeout` | `send_timeout` |
| Constructor option: resync timeout | `resyncTimeout` | `resync_timeout` |
| Constructor option: ping interval | `pingInterval` | `ping_interval` |
| Constructor option: pong timeout | `pongTimeout` | `pong_timeout` |
| Constructor option: stale threshold | `staleThreshold` | `stale_threshold` |
| Method: send a message | `sendMessage()` | `send_message()` |
| Method: upload a file | `uploadAttachment()` | `upload_attachment()` |
| Method: connect | `connect()` | `connect()` |
| Method: disconnect | `disconnect()` | `disconnect()` |
| Method: stop | `stop()` | `stop()` |
| Property: session state | `sessionState` | `session_state` |
| Property: channel state | `channelState` | `channel_state` |
| Property: session ID | `sessionId` | `session_id` |

---

## Time units

JavaScript and Node.js use **milliseconds** for all timeout and interval options.  
Python uses **seconds** (integers or floats).

| Option | JS / Node.js (ms) | Python (s) |
|---|---|---|
| `connectTimeout` / `connect_timeout` | `10000` | `10` |
| `sendTimeout` / `send_timeout` | `10000` | `10` |
| `resyncTimeout` / `resync_timeout` | `15000` | `15` |
| `pingInterval` / `ping_interval` | `15000` | `15` |
| `pongTimeout` / `pong_timeout` | `5000` | `5` |
| `staleThreshold` / `stale_threshold` | `45000` | `45` |

The same 30-second connect timeout in both languages:

```js
// JavaScript (Browser and Node.js)
const client = new CortexClient({
  apiKey: "your-api-key",
  onMessage: handleMessage,
  connectTimeout: 30000, // 30 seconds in milliseconds
});
```

```python
# Python
client = CortexClient(
    api_key="your-api-key",
    on_message=handle_message,
    connect_timeout=30,  # 30 seconds
)
```

---

## JavaScript (Browser)

### Install

```bash
npm install @cortex-suite/sdk
```

### Import

```js
import { CortexClient } from "@cortex-suite/sdk";
// or pin the browser entrypoint explicitly:
import { CortexClient } from "@cortex-suite/sdk/browser";
```

### Platform notes

- Uses the browser's native `WebSocket` API
- Uses Fetch for authentication and WebSocket binary frames for session files
- No Node.js-specific APIs; safe to use in any modern browser
- Ships as ESM only
- Compatible with Chrome 90+, Firefox 90+, Safari 15+, and equivalents

### File upload input types

| Type | Description |
|---|---|
| `File` | Standard browser File object (e.g., from `<input type="file">`) |
| `Blob` | Binary large object |
| `ArrayBuffer` | Raw binary data buffer |

---

## JavaScript (Node.js)

### Install

```bash
npm install @cortex-suite/sdk
```

### Import

```js
import { CortexClient } from "@cortex-suite/sdk";
// or pin the Node.js entrypoint explicitly:
import { CortexClient } from "@cortex-suite/sdk/node";
```

### Platform notes

- Uses the `ws` package for WebSocket (bundled — no peer dependency needed)
- Uses native `fetch` for authentication and Control Plane calls (Node.js 18+ required)
- Ships as ESM only
- **Requires Node.js 18 or later**

### File upload input types

| Type | Description |
|---|---|
| `string` | File path (e.g., `"./report.pdf"`) |
| `Buffer` | Node.js Buffer |
| `Uint8Array` | Typed array of bytes |
| `ReadableStream` | Node.js readable stream |

---

## Python

### Install

```bash
pip install cortex-suite-sdk
```

### Import

```python
from cortex_sdk import CortexClient
from cortex_sdk import CortexClient, CortexError  # include CortexError for error handling
```

### Platform notes

- Requires Python 3.10 or later
- Uses `websockets` for WebSocket (installed as a dependency)
- Uses `httpx` for authentication and Control Plane calls (installed as a dependency)
- All public methods are `async` — must be `await`ed
- No synchronous interface is provided
- Payload types are annotated with `TypedDict` for static analysis with mypy/pyright

### File upload input types

| Type | Description |
|---|---|
| `str` | File path (e.g., `"./report.pdf"`) |
| `bytes` | Raw bytes |
| File-like object | Any object with a `.read()` method |

---

## Async model in Python

All SDK methods are coroutines. They must be called from within an `async` function running under an event loop.

The standard pattern for a standalone script:

```python
# Python
import asyncio
from cortex_sdk import CortexClient

def on_message(msg):
    print(msg["type"], msg["payload"])

async def main():
    client = CortexClient(api_key="your-api-key", on_message=on_message)
    await client.connect()
    await client.send_message(content="Hello")
    await asyncio.sleep(5)  # wait for response
    await client.disconnect()

asyncio.run(main())
```

If you are working inside an async framework (FastAPI, aiohttp, Django async views, etc.), call the SDK methods directly from your existing async context — no additional wrapper needed:

```python
# Python — inside an existing async context (e.g., FastAPI route)
from cortex_sdk import CortexClient

async def handle_request(api_key: str, user_message: str):
    responses = []
    client = CortexClient(
        api_key=api_key,
        on_message=lambda msg: responses.append(msg),
    )
    await client.connect()
    await client.send_message(content=user_message)
    await asyncio.sleep(10)  # wait for response
    await client.disconnect()
    return responses
```
