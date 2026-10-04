from __future__ import annotations

import asyncio
import secrets
import time
from typing import Callable

from .constants import SCHEMA_VERSION
from .transport import Transport


class _LivenessCallbacks:
    on_stale: Callable[[], None]
    get_session_id: Callable[[], str | None]
    get_channel_id: Callable[[], str]


class LivenessMonitor:
    """Sends system::ping on a fixed interval and monitors pong responses."""

    def __init__(
        self,
        transport: Transport,
        ping_interval: float,
        pong_timeout: float,
        stale_threshold: float,
        on_stale: Callable[[], None],
        get_session_id: Callable[[], str | None],
        get_channel_id: Callable[[], str],
    ) -> None:
        self._transport = transport
        self._ping_interval = ping_interval
        self._pong_timeout = pong_timeout
        self._stale_threshold = stale_threshold
        self._on_stale = on_stale
        self._get_session_id = get_session_id
        self._get_channel_id = get_channel_id

        self._running = False
        self._last_pong_time = time.monotonic()
        self._pending_heartbeat_id: str | None = None
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        self._running = True
        self._last_pong_time = time.monotonic()
        self._task = asyncio.create_task(self._ping_loop())

    def stop(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = None
        self._pending_heartbeat_id = None

    def record_pong(self, heartbeat_id: str) -> None:
        """Called when a system::pong is received."""
        if heartbeat_id == self._pending_heartbeat_id:
            self._pending_heartbeat_id = None
            self._last_pong_time = time.monotonic()

    async def _ping_loop(self) -> None:
        try:
            while self._running:
                await asyncio.sleep(self._ping_interval)
                if not self._running:
                    break

                # Check stale threshold before sending ping
                if time.monotonic() - self._last_pong_time > self._stale_threshold:
                    self._on_stale()
                    return

                heartbeat_id = f"hb_{secrets.token_hex(4)}"
                self._pending_heartbeat_id = heartbeat_id

                envelope: dict[str, object] = {
                    "type": "system::ping",
                    "schema": SCHEMA_VERSION,
                    "payload": {
                        "heartbeat_id": heartbeat_id,
                        "channel_id": self._get_channel_id(),
                    },
                    "ts": _now_iso(),
                }
                session_id = self._get_session_id()
                if session_id:
                    envelope["session_id"] = session_id

                try:
                    await self._transport.send_json(envelope)
                except Exception:
                    pass  # send errors are handled via transport on_close

                # Schedule pong-timeout check as a separate task
                asyncio.create_task(self._check_pong_timeout(heartbeat_id))
        except asyncio.CancelledError:
            pass

    async def _check_pong_timeout(self, heartbeat_id: str) -> None:
        await asyncio.sleep(self._pong_timeout)
        if not self._running:
            return
        if self._pending_heartbeat_id == heartbeat_id:
            if time.monotonic() - self._last_pong_time > self._stale_threshold:
                self._on_stale()


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
