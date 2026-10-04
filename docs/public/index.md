# Cortex SDK — Developer Manual

**Version:** 1.1.21

The Cortex SDK is a transport client that connects your application to the Cortex runtime over a persistent WebSocket session. It handles the entire connection lifecycle — authentication, session management, reconnection, and heartbeating — so your code only deals with sending messages and reacting to responses.

---

## What the SDK handles for you

You do not need to implement any of the following:

- API key exchange and JWT token management
- Automatic token refresh before expiration
- WebSocket connection and reconnection
- Session initialization and lifecycle tracking
- Heartbeat (ping/pong) and stale connection detection
- Message replay after reconnection (resync)

Your application provides an API key and a callback function. The SDK does everything else.

---

## What the SDK does NOT do

- It is not a UI component library.
- It is not tied to any framework (React, Vue, Angular, Django, etc.).
- It does not manage application state beyond the connection itself.
- It does not interpret message content — what the runtime sends is passed directly to your callback.

---

## Supported bindings

| Binding | Install | Import |
|---|---|---|
| JavaScript (Browser) | `npm install @cortex-suite/sdk` | `import { CortexClient } from "@cortex-suite/sdk"` |
| JavaScript (Node.js) | `npm install @cortex-suite/sdk` | `import { CortexClient } from "@cortex-suite/sdk"` |
| Python | `pip install cortex-suite-sdk` | `from cortex_sdk import CortexClient` |

All three bindings implement the same API. The only differences are naming conventions (camelCase vs snake_case) and time units (milliseconds vs seconds). See [Language Notes](language-notes.md) for the full mapping.

---

## Manual

| Page | What you will find |
|---|---|
| [Getting Started](getting-started.md) | Install, and run your first integration in under 5 minutes |
| [Core Concepts](core-concepts.md) | Mental model: sessions, channels, the callback contract |
| [Configuration](configuration.md) | All constructor options with defaults and descriptions |
| [Connecting](connecting.md) | `connect()`, `disconnect()`, and reading state properties |
| [Messaging](messaging.md) | Sending messages, receiving messages, all message types |
| [File Attachments](file-attachments.md) | Upload files and attach them to messages |
| [Session & Channel States](session-and-channel-states.md) | Complete state machine reference |
| [Error Handling](error-handling.md) | Error model, all error codes, recovery patterns |
| [Reconnection](reconnection.md) | How automatic reconnection and resync work |
| [API Reference](api-reference.md) | Single-page lookup reference for all methods and properties |
| [Language Notes](language-notes.md) | Naming conventions, time units, platform-specific notes |
