"""Shared test helpers."""
from __future__ import annotations

import asyncio
from typing import Any

from cortex_sdk import CortexClient
from cortex_sdk.types import CortexMessage

from .mock_server import MockServer


def make_client(
    server: MockServer,
    received: list[CortexMessage],
    **overrides: Any,
) -> CortexClient:
    defaults: dict[str, Any] = {
        "connect_timeout": 2.0,
        "ping_interval": 60.0,  # don't auto-ping in most tests
        "pong_timeout": 1.0,
        "stale_threshold": 60.0,
        "resync_timeout": 2.0,
    }
    # overrides win over defaults
    defaults.update(overrides)
    return CortexClient(
        api_key="test-key",
        auth_url=server.http_url,
        on_message=lambda msg: received.append(msg),
        **defaults,
    )


async def wait_for(
    condition: Any,
    timeout: float = 3.0,
    interval: float = 0.02,
) -> None:
    """Poll condition() until True or timeout."""
    deadline = asyncio.get_event_loop().time() + timeout
    while not condition():
        if asyncio.get_event_loop().time() > deadline:
            raise TimeoutError("wait_for timed out")
        await asyncio.sleep(interval)
