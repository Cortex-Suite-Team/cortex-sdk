# Cortex SDK for JavaScript and Node.js

## Install

`npm install @cortex-suite/sdk`

## Quick start

### Browser

```js
import { CortexClient } from "@cortex-suite/sdk";

const client = new CortexClient({
  apiKey: "your-api-key",
  // authUrl: "https://cortexsuite.app", // optional override
  onMessage: (msg) => console.log(msg.type, msg.payload),
});

await client.connect();
await client.sendMessage({ content: "Hello" });
```

### Node.js

```js
import { CortexClient } from "@cortex-suite/sdk";

async function main() {
  const client = new CortexClient({
    apiKey: "your-api-key",
    // authUrl: "https://cortexsuite.app", // optional override
    onMessage: (msg) => console.log(msg.type, msg.payload),
  });

  await client.connect();
  await client.sendMessage({ content: "Hello" });
}

main().catch(console.error);
```

## API

See the [full API reference](https://github.com/Cortex-Suite-Team/cortex-sdk/blob/main/docs/public/api-reference.md).
`authUrl` is optional; if omitted, the SDK uses its default auth base URL.

## Error handling

```js
import { CortexClient } from "@cortex-suite/sdk";

const client = new CortexClient({
  apiKey: "your-api-key",
  onMessage: (msg) => {
    if (msg.type === "system::error") {
      console.error("Runtime error:", msg.payload.code, msg.payload.message);
      if (msg.payload.fatal) {
        // handle unrecoverable session
      }
    }
  },
});

try {
  await client.connect();
} catch (err) {
  if (err.code === "auth_invalid" || err.code === "auth_refresh_failed") {
    // prompt user to re-authenticate
  }
}
```

