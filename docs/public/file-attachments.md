# File Attachments

Attaching a file to a message is a two-step process: upload the file first to get a canonical `sf_...` `file_ref`, then include that reference in your message.

---

## Why two steps?

Session uploads, downloads, and listing use the same SessionManager WebSocket as chat. Control messages are JSON text and file bytes use CFT1 binary frames. Project/workspace file operations remain on Control Plane HTTP. The returned `file_ref` is safe for the public SDK; internal File Layer identities are never returned.

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

Upload each file independently, then pass every `file_ref` in one `attachments` array. Order is preserved end to end: the SDK sends the references in the order you give, SessionManager binds them in that order, and every later projection (echo, history, `file::list`) keeps it. There is no bulk-upload API or separate multi-file format.

```js
// JavaScript (Browser and Node.js)
const refs = [];
for (const file of [revenueCsv, briefMd, appendixPdf]) {
  refs.push(await client.uploadAttachment(file));
}

await client.sendMessage({
  content: "Compare the attached revenue files.",
  attachments: refs, // ["sf_...", "sf_...", "sf_..."]
  meta: { client_msg_id: "msg_7f3c" }, // optional, see "Stable message identity"
});
```

```python
# Python
refs = [await client.upload_attachment(path) for path in ("revenue.csv", "brief.md", "appendix.pdf")]

await client.send_message(
    "Compare the attached revenue files.",
    refs,
    meta={"client_msg_id": "msg_7f3c"},
)
```

Rules checked before anything is sent (the SDK throws and sends nothing):

| Condition | Error code |
|---|---|
| More than 8 attachments (`MAX_ATTACHMENTS_PER_MESSAGE`) | `too_many_attachments` |
| The same `file_ref` twice | `invalid_attachment` |
| Anything other than a canonical `sf_...` reference (for example `fi_...`, legacy `fa_...`, an empty string) | `invalid_attachment` |
| An attachment object with fields other than `file_ref`, `filename`, `content_type`, `size` | `invalid_attachment` |

SessionManager validates the whole list again (existence, session, expiry, an existing binding to another message) and binds all files or none. A server-side rejection arrives as a non-fatal `system::error` with the same codes and `meta.client_msg_id` of the rejected message; the session stays usable. Deployments may configure a server limit lower than 8.

Zero attachments sends no `meta.attachments` at all, and one attachment is simply a one-element array.

---

## Stable message identity and retries

`payload.meta.client_msg_id` identifies a message. SessionManager binds the attached files to that identity, so a resend with the **same** `client_msg_id` and the same references is accepted again without re-uploading anything. A resend with a different (or no) `client_msg_id` after the first attempt was actually delivered is rejected with `invalid_attachment` (`message binding conflict`), because those files already belong to the first message.

If you may retry a send whose outcome you did not observe (for example the connection dropped), pass your own `client_msg_id` and reuse it on every retry. The SDK never rewrites it.

---

## Receiving generated files

Files produced for the user arrive on the final answer, in `chat::answer` `payload.meta.attachments`, in the order the runtime published them. Each entry is a public session-file descriptor:

```json
{
  "type": "chat::answer",
  "payload": {
    "content": "Here are the regional deltas and a summary.",
    "role": "assistant",
    "answer_kind": "final",
    "turn_id": "turn_ea_0007",
    "meta": {
      "attachments": [
        { "file_ref": "sf_out_01HZZ1", "filename": "delta.csv", "content_type": "text/csv", "size": 38,
          "owner_role": "assistant", "direction": "outbound", "state": "available",
          "message_ref": "turn_ea_0007", "message_ref_kind": "turn" },
        { "file_ref": "sf_out_01HZZ2", "filename": "summary.md", "content_type": "text/markdown", "size": 49,
          "owner_role": "assistant", "direction": "outbound", "state": "available",
          "message_ref": "turn_ea_0007", "message_ref_kind": "turn" }
      ]
    }
  }
}
```

| Field | Meaning |
|---|---|
| `file_ref` | Public `sf_...` handle; the only thing you pass to `downloadFile()` |
| `filename`, `content_type`, `size` | Display metadata (size in bytes) |
| `owner_role` | `user` for uploads, `assistant` for generated files |
| `direction` | `inbound` for uploads, `outbound` for generated files |
| `state` | `available`, `expired`, `deleted` or `quarantined` |
| `message_ref`, `message_ref_kind` | The message the file belongs to: the user message's `client_msg_id` (`client_msg_id`) or the answer's turn (`turn`) |

The user's own attachments are echoed the same way in `chat::echo` `payload.meta.attachments` (`owner_role: "user"`, `direction: "inbound"`, `message_ref` = the message's `client_msg_id`).

Before a message reaches your handler, the SDK replaces `payload.meta.attachments` with a strict public projection:

- only the nine fields above survive; internal identities (`file_id`, `snapshot_id`, `fi_...`, `sn_...`), scope, storage keys, tickets and any URL such as `download_mint_url` are removed;
- a descriptor with a missing or invalid public field is dropped;
- an answer keeps only `assistant`/`outbound` files bound to its own turn, and an echo only `user`/`inbound` files bound to its own `client_msg_id`; a user upload repeated inside an answer is not an answer attachment;
- a repeated `file_ref` is kept once, in its first position.

Other `meta` keys of the answer pass through unchanged.

---

## Downloading each file

Download every file separately by its `file_ref`. Downloads use the same session WebSocket (CFT1 frames) as uploads; several downloads may run concurrently.

```js
// JavaScript (Browser and Node.js)
for (const file of answer.payload.meta?.attachments ?? []) {
  const blob = await client.downloadFile(file.file_ref); // Blob with the file's content_type
  save(file.filename, blob);
}
```

```python
# Python
for file in (answer["payload"].get("meta") or {}).get("attachments", []):
    data = await client.download_file(file["file_ref"])  # bytes
    Path(file["filename"]).write_bytes(data)
```

`downloadFile()` / `download_file()` only accept a canonical `sf_...` reference. The SDK never follows a URL found in message metadata. An expired, deleted or unknown file fails with `file_unavailable`; a dropped connection fails an in-flight download with `file_transfer_interrupted`: reconnect, then download again.

---

## Listing session files after reconnect

`listFiles()` / `list_files()` returns every session file you can see (uploads and generated files, oldest first) with the same public descriptor fields, so files can be re-associated with their messages through `message_ref` after a reconnect or page reload.

```js
// JavaScript (Browser and Node.js)
const { files, total } = await client.listFiles();
const generated = files.filter((f) => f.owner_role === "assistant" && f.direction === "outbound");
```

```python
# Python
listing = await client.list_files()
generated = [f for f in listing["files"] if f.get("owner_role") == "assistant"]
```

---

## Upload error handling

`uploadAttachment()` and `sendMessage()` throw a `CortexError` on failure. The upload- and attachment-specific error codes:

| Code | Retryable | Meaning | What to do |
|---|---|---|---|
| `file_upload_failed` | yes | Transient upload error | Retry the upload |
| `file_too_large` | no | File exceeds the allowed size limit | Reduce file size or split the file |
| `file_type_rejected` | no | File type is not accepted by the runtime | Check supported formats |
| `too_many_attachments` | no | More attachments than the per-message limit | Send fewer files per message |
| `invalid_attachment` | no | Not a canonical `sf_` reference, a duplicate, or already bound to another message | Fix the list; reuse the original `client_msg_id` when retrying |

```js
// JavaScript (Browser and Node.js)
import { CortexClient } from "@cortex-suite/sdk";

try {
  const attachmentId = await client.uploadAttachment("./data.csv");
  await client.sendMessage({ content: "Analyze this data.", attachments: [attachmentId] });
} catch (err) {
  if (err.code === "file_too_large") {
    console.error("File is too large. Split it into smaller parts.");
  } else if (err.code === "file_type_rejected") {
    console.error("This file type is not supported.");
  } else if (err.code === "file_upload_failed") {
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
    if e.code == "file_too_large":
        print("File is too large. Split it into smaller parts.")
    elif e.code == "file_type_rejected":
        print("This file type is not supported.")
    elif e.code == "file_upload_failed":
        print("Upload failed — you can retry.")
```

---

## Orphaned uploads

> **Note:** If the upload succeeds but the subsequent `sendMessage()` call fails, retry `sendMessage()` with the same `file_ref` and the same `meta.client_msg_id`. You do not need to upload the file again.

```js
// JavaScript (Browser and Node.js) — safe retry pattern
let fileRef;

try {
  fileRef = await client.uploadAttachment("./file.pdf");
} catch (err) {
  // Upload failed — handle the upload error first
  throw err;
}

// Retry loop for sendMessage only (upload already succeeded).
// One client_msg_id for every attempt keeps the message identity stable.
const clientMsgId = crypto.randomUUID();
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    await client.sendMessage({
      content: "Analyze this.",
      attachments: [fileRef], // reuse the same canonical reference
      meta: { client_msg_id: clientMsgId },
    });
    break;
  } catch (err) {
    if (attempt === 2) throw err; // give up after 3 attempts
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}
```
