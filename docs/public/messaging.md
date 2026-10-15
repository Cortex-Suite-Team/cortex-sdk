# Messaging

---

## Sending a message

Use `sendMessage()` / `send_message()` to send a chat message to the runtime. Call it after `connect()` returns.

```js
// JavaScript (Browser and Node.js)
await client.sendMessage({ content: "What is the capital of France?" });
```

```python
# Python
await client.send_message(content="What is the capital of France?")
```

The SDK adds all required envelope fields automatically (`session_id`, `seq`, `ts`, etc.). You only need to provide `content`.

To include file attachments, pass their IDs in the `attachments` array. See [File Attachments](file-attachments.md) for the upload workflow.

```js
// JavaScript (Browser and Node.js)
await client.sendMessage({
  content: "Summarize the attached document.",
  attachments: ["sf_abc123", "sf_def456"],
});
```

```python
# Python
await client.send_message(
    content="Summarize the attached document.",
    attachments=["sf_abc123", "sf_def456"],
)
```

`sendMessage()` throws `transport_send_timeout` if the message cannot be delivered within `sendTimeout`. See [Error Handling](error-handling.md).

---

## Receiving messages

All messages from the runtime are delivered to the `onMessage` / `on_message` callback you provide at construction time.
For JavaScript and Node.js, that constructor callback runs first, and you may attach additional listeners later with `client.onMessage(handler)`.

```js
// JavaScript (Browser and Node.js)
const client = new CortexClient({
  apiKey: "your-api-key",
  onMessage: (msg) => {
    // msg is the full message envelope
    console.log(msg.type, msg.payload);
  },
});
```

```python
# Python
def on_message(msg):
    # msg is the full message envelope as a dict
    print(msg["type"], msg["payload"])

client = CortexClient(
    api_key="your-api-key",
    on_message=on_message,
)
```

The callback is called **synchronously** by the SDK's receive loop. Do not perform blocking I/O or long computations inside it. If you need async processing, see [Async message processing](#async-message-processing) below.

### Additional JavaScript / Node.js subscriptions

JavaScript and Node.js clients also support additive message subscriptions:

```js
const unsubscribe = client.onMessage((msg) => {
  console.log("secondary listener", msg.type);
});
```

Rules:

- the constructor `onMessage` callback is still required
- the constructor callback runs first
- subscribed handlers run after that in insertion order
- if one subscribed handler throws, later handlers still receive the message
- `unsubscribe()` removes only that subscribed handler

---

## Message envelope

Every message has the same outer structure:

```json
{
  "type": "chat::answer",
  "schema": "1.0",
  "session_id": "sess_abc123",
  "seq": 42,
  "payload": { ... },
  "meta": { ... },
  "ts": "2026-04-03T12:00:00Z"
}
```

| Field | Type | Description |
|---|---|---|
| `type` | string | Message type identifier. Use this to route messages in your callback. |
| `schema` | string | Protocol schema version (currently `"1.0"`). |
| `session_id` | string | The session this message belongs to. |
| `seq` | integer | Server-assigned sequence number. Monotonically increasing per session. |
| `payload` | object | Message-specific content. Fields vary by `type`. |
| `meta` | object | Optional metadata. May be absent. |
| `ts` | string | ISO-8601 UTC timestamp when the message was created. |

---

## Message types

### `chat::partial`

A streaming chunk of an answer that is still being generated. Multiple `chat::partial` messages may arrive before the final `chat::answer`. They share the same `turn_id` in the payload.

Relevant payload fields:

| Field | Type | Description |
|---|---|---|
| `content` | string | The text chunk. Append these to build the full answer incrementally. |
| `turn_id` | string | Groups all chunks and the final answer belonging to the same turn. |

```js
// JavaScript (Browser and Node.js)
if (msg.type === "chat::partial") {
  process.stdout.write(msg.payload.content); // append chunk to output
}
```

```python
# Python
if msg["type"] == "chat::partial":
    print(msg["payload"]["content"], end="", flush=True)
```

### `chat::answer`

The final answer for a turn. Arrives after all `chat::partial` chunks (if any). `answer_kind` is `"final"` for the conclusive response.

Relevant payload fields:

| Field | Type | Description |
|---|---|---|
| `content` | string | The complete answer text. |
| `answer_kind` | string | `"final"` for the conclusive answer. |
| `role` | string | Always `"assistant"` for runtime answers. |
| `turn_id` | string | Matches the `turn_id` from the preceding `chat::partial` chunks. |
| `meta.attachments` | array | Optional. Files generated for this answer, as public session-file descriptors in publication order. See [Receiving generated files](file-attachments.md#receiving-generated-files). |

```js
// JavaScript (Browser and Node.js)
if (msg.type === "chat::answer" && msg.payload.answer_kind === "final") {
  console.log("Answer:", msg.payload.content);
}
```

```python
# Python
if msg["type"] == "chat::answer" and msg["payload"].get("answer_kind") == "final":
    print("Answer:", msg["payload"]["content"])
```

### `system::warning`

A non-fatal warning from the runtime. The session continues normally. Log it or surface it to the user, but do not stop the session.

```js
// JavaScript (Browser and Node.js)
if (msg.type === "system::warning") {
  console.warn("Runtime warning:", msg.payload);
}
```

```python
# Python
if msg["type"] == "system::warning":
    print("Runtime warning:", msg["payload"])
```

### `system::error`

An error from the runtime. Check the `fatal` field in the payload to determine whether the session can continue.

Relevant payload fields:

| Field | Type | Description |
|---|---|---|
| `code` | string | Canonical error code. See [Error Handling](error-handling.md) for the full list. |
| `message` | string | Human-readable description. |
| `fatal` | boolean | If `true`, the session is unrecoverable. Create a new `CortexClient`. |

```js
// JavaScript (Browser and Node.js)
if (msg.type === "system::error") {
  console.error("Runtime error:", msg.payload.code, msg.payload.message);
  if (msg.payload.fatal) {
    // Session is unrecoverable. Create a new CortexClient and reconnect.
  }
}
```

```python
# Python
if msg["type"] == "system::error":
    print("Runtime error:", msg["payload"]["code"], msg["payload"]["message"])
    if msg["payload"].get("fatal"):
        # Session is unrecoverable. Create a new CortexClient and reconnect.
        pass
```

---

## Full type-switch callback

A complete, production-ready callback implementation that routes all message types:

```js
// JavaScript (Browser and Node.js)
import { CortexClient } from "@cortex-suite/sdk";

let streamBuffer = "";

const client = new CortexClient({
  apiKey: "your-api-key",
  onMessage: (msg) => {
    switch (msg.type) {
      case "chat::partial":
        streamBuffer += msg.payload.content;
        renderStreamingAnswer(streamBuffer);
        break;

      case "chat::answer":
        if (msg.payload.answer_kind === "final") {
          streamBuffer = "";
          renderFinalAnswer(msg.payload.content);
        }
        break;

      case "system::warning":
        console.warn("[warning]", msg.payload);
        break;

      case "system::error":
        console.error("[error]", msg.payload.code, msg.payload.message);
        if (msg.payload.fatal) {
          handleFatalError(msg.payload.code);
        }
        break;

      default:
        // Ignore unknown message types for forward compatibility
        break;
    }
  },
});
```

```python
# Python
import asyncio
from cortex_sdk import CortexClient

stream_buffer = []

def on_message(msg):
    msg_type = msg["type"]
    payload = msg["payload"]

    if msg_type == "chat::partial":
        stream_buffer.append(payload["content"])
        render_streaming_answer("".join(stream_buffer))

    elif msg_type == "chat::answer":
        if payload.get("answer_kind") == "final":
            stream_buffer.clear()
            render_final_answer(payload["content"])

    elif msg_type == "system::warning":
        print("[warning]", payload)

    elif msg_type == "system::error":
        print("[error]", payload["code"], payload["message"])
        if payload.get("fatal"):
            handle_fatal_error(payload["code"])

    # Ignore unknown message types for forward compatibility

async def main():
    client = CortexClient(api_key="your-api-key", on_message=on_message)
    await client.connect()
    await client.send_message(content="Hello")

asyncio.run(main())
```

---

## Async message processing

The `onMessage` callback is synchronous. If you need to do async work when a message arrives (e.g., write to a database, call another API), queue the message and process it from a separate task.

```js
// JavaScript (Browser and Node.js)
import { CortexClient } from "@cortex-suite/sdk";

const queue = [];

const client = new CortexClient({
  apiKey: "your-api-key",
  onMessage: (msg) => {
    queue.push(msg); // synchronous — always safe
  },
});

// Separate consumer loop
async function processQueue() {
  while (true) {
    if (queue.length > 0) {
      const msg = queue.shift();
      await saveToDatabase(msg); // async work outside the callback
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

await client.connect();
processQueue(); // start consumer (not awaited — runs concurrently)
await client.sendMessage({ content: "Hello" });
```

```python
# Python
import asyncio
from cortex_sdk import CortexClient

async def main():
    queue = asyncio.Queue()

    def on_message(msg):
        queue.put_nowait(msg)  # synchronous — always safe

    async def process_queue():
        while True:
            msg = await queue.get()
            await save_to_database(msg)  # async work outside the callback

    client = CortexClient(api_key="your-api-key", on_message=on_message)
    await client.connect()

    asyncio.create_task(process_queue())  # run consumer concurrently
    await client.send_message(content="Hello")

asyncio.run(main())
```

---

## Stopping execution

`stop()` sends a stop signal to the runtime. The session transitions to `STOPPED`. Use this to interrupt a running response mid-generation.

```js
// JavaScript (Browser and Node.js)
await client.stop();
```

```python
# Python
await client.stop()
```

`stop()` is different from `disconnect()`:

- `stop()` tells the runtime to halt execution. The session ends on the runtime's side.
- `disconnect()` closes your connection locally. Use it when you are done with the session entirely.

After `stop()`, the session is in a terminal state. Create a new `CortexClient` instance if you want to start another session.
