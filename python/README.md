# Cortex SDK for Python

## Install

`pip install cortex-suite-sdk`

## Quick start

```python
import asyncio

from cortex_sdk import CortexClient


def on_message(msg):
    print(msg["type"], msg["payload"])


async def main():
    client = CortexClient(
        api_key="your-api-key",
        # auth_url="https://cortexsuite.app",  # optional override
        on_message=on_message,
    )
    await client.connect()
    await client.send_message(content="Hello")


asyncio.run(main())
```

## API

See the [full API reference](https://github.com/Cortex-Suite-Team/cortex-sdk/blob/main/docs/public/api-reference.md).
`auth_url` is optional; if omitted, the SDK uses its default auth base URL.

## Error handling

```python
from cortex_sdk import CortexClient, CortexError


def on_message(msg):
    if msg["type"] == "system::error":
        print("Runtime error:", msg["payload"]["code"])
        if msg["payload"].get("fatal"):
            pass  # handle unrecoverable session


client = CortexClient(
    api_key="your-api-key",
    on_message=on_message,
)

try:
    await client.connect()
except CortexError as err:
    if err.code in ("auth_invalid", "auth_refresh_failed"):
        pass  # prompt re-authentication
```

