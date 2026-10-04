# File Attachments

Attaching a file to a message is a two-step process: upload the file first to get a canonical `sf_...` `file_ref`, then include that reference in your message.

---

## Why two steps?

File uploads happen over the SessionManager HTTP boundary, while messages are sent over WebSocket. The returned `file_ref` is safe for the public SDK; internal File Layer identities are never returned.

---

## Step 1: Upload the file

Call `uploadAttachment()` / `upload_attachment()` with the file. It returns a canonical `sf_...` `file_ref` string. Legacy-only `file_id` or `attachment_id` responses are rejected.

```js
// JavaScript (Browser)
const fileRef = await client.uploadAttachment(fileObject); // File or Blob
```

```js
// JavaScript (Node.js)
const fileRef = await client.uploadAttachment("./report.pdf"); // file path string
// or
const fileRef = await client.uploadAttachment(buffer); // Buffer or Uint8Array
```

```python
# Python
file_ref = await client.upload_attachment("./report.pdf")  # file path string
# or
file_ref = await client.upload_attachment(file_bytes)  # bytes
```

### Accepted input types

| Binding | Accepted input types |
|---|---|
| JavaScript (Browser) | `File`, `Blob`, `ArrayBuffer` |
| JavaScript (Node.js) | File path `string`, `Buffer`, `Uint8Array`, `ReadableStream` |
| Python | File path `str`, `bytes`, file-like object (anything with a `.read()` method) |

---

## Step 2: Send the message with the attachment

Pass the `file_ref` in the `attachments` array of `sendMessage()` / `send_message()`. The SDK serializes it under `payload.meta.attachments` as `{ "file_ref": "sf_..." }`.

```js
// JavaScript (Browser and Node.js)
await client.sendMessage({
  content: "Please analyze this document.",
  attachments: [fileRef],
});
```

```python
# Python
await client.send_message(
    content="Please analyze this document.",
    attachments=[file_ref],
)
```

---

## Complete example

A full upload-then-send flow:

```js
// JavaScript (Browser and Node.js)
import { CortexClient } from "@cortex-suite/sdk";

const client = new CortexClient({
  apiKey: "your-api-key",
  onMessage: (msg) => {
    if (msg.type === "chat::answer") {
      console.log(msg.payload.content);
    }
  },
});

await client.connect();

// Step 1: upload
const fileRef = await client.uploadAttachment("./quarterly-report.pdf");

// Step 2: send
await client.sendMessage({
  content: "Summarize the key findings from this report.",
  attachments: [fileRef],
});
```

```python
# Python
import asyncio
from cortex_sdk import CortexClient

def on_message(msg):
    if msg["type"] == "chat::answer":
        print(msg["payload"]["content"])

async def main():
    client = CortexClient(
        api_key="your-api-key",
        on_message=on_message,
    )
    await client.connect()

    # Step 1: upload
    file_ref = await client.upload_attachment("./quarterly-report.pdf")

    # Step 2: send
    await client.send_message(
        content="Summarize the key findings from this report.",
        attachments=[file_ref],
    )

asyncio.run(main())
```

---

## Multiple attachments

Pass multiple IDs in the `attachments` array to attach several files to a single message:

```js
// JavaScript (Browser and Node.js)
const id1 = await client.uploadAttachment("./report-q1.pdf");
const id2 = await client.uploadAttachment("./report-q2.pdf");

await client.sendMessage({
  content: "Compare Q1 and Q2 performance.",
  attachments: [id1, id2],
});
```

```python
# Python
id1 = await client.upload_attachment("./report-q1.pdf")
id2 = await client.upload_attachment("./report-q2.pdf")

await client.send_message(
    content="Compare Q1 and Q2 performance.",
    attachments=[id1, id2],
)
```

---

## Upload error handling

`uploadAttachment()` throws a `CortexError` on failure. The three upload-specific error codes:

| Code | Retryable | Meaning | What to do |
|---|---|---|---|
| `upload_failed` | yes | Transient upload error | Retry the upload |
| `upload_too_large` | no | File exceeds the allowed size limit | Reduce file size or split the file |
| `upload_type_rejected` | no | File type is not accepted by the runtime | Check supported formats |

```js
// JavaScript (Browser and Node.js)
import { CortexClient } from "@cortex-suite/sdk";

try {
  const attachmentId = await client.uploadAttachment("./data.csv");
  await client.sendMessage({ content: "Analyze this data.", attachments: [attachmentId] });
} catch (err) {
  if (err.code === "upload_too_large") {
    console.error("File is too large. Split it into smaller parts.");
  } else if (err.code === "upload_type_rejected") {
    console.error("This file type is not supported.");
  } else if (err.code === "upload_failed") {
    console.error("Upload failed — you can retry.");
  }
}
```

```python
# Python
from cortex_sdk import CortexClient, CortexError

try:
    file_ref = await client.upload_attachment("./data.csv")
    await client.send_message(
        content="Analyze this data.",
        attachments=[file_ref],
    )
except CortexError as e:
    if e.code == "upload_too_large":
        print("File is too large. Split it into smaller parts.")
    elif e.code == "upload_type_rejected":
        print("This file type is not supported.")
    elif e.code == "upload_failed":
        print("Upload failed — you can retry.")
```

---

## Orphaned uploads

> **Note:** If the upload succeeds but the subsequent `sendMessage()` call fails, retry `sendMessage()` with the same `file_ref`. You do not need to upload the file again.

```js
// JavaScript (Browser and Node.js) — safe retry pattern
let fileRef;

try {
  fileRef = await client.uploadAttachment("./file.pdf");
} catch (err) {
  // Upload failed — handle the upload error first
  throw err;
}

// Retry loop for sendMessage only (upload already succeeded)
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    await client.sendMessage({
      content: "Analyze this.",
      attachments: [fileRef], // reuse the same canonical reference
    });
    break;
  } catch (err) {
    if (attempt === 2) throw err; // give up after 3 attempts
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}
```
