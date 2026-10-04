from __future__ import annotations

import asyncio
import json
from typing import Callable

import websockets
import websockets.asyncio.client
import websockets.exceptions

from .constants import WS_SUBPROTOCOL, WS_SUBPROTOCOL_JWT_PREFIX
from .errors import make_error


class Transport:
    """Thin WebSocket abstraction. Platform-agnostic — no business logic."""

    def __init__(self, connect_timeout: float, send_timeout: float) -> None:
        self._connect_timeout = connect_timeout
        self._send_timeout = send_timeout
        self._ws: websockets.asyncio.client.ClientConnection | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._connection_generation = 0

        # Callbacks set by the consumer (client.py)
        self.on_text: Callable[[str], None] | None = None
        self.on_binary: Callable[[bytes], None] | None = None
        self.on_close: Callable[[int, str], None] | None = None
        self.on_error: Callable[[Exception], None] | None = None

    async def open(self, ws_url: str, access_token: str) -> None:
        """Open the WebSocket connection and start the reader loop."""
        subprotocols: list[str] = [
            WS_SUBPROTOCOL,
            f"{WS_SUBPROTOCOL_JWT_PREFIX}{access_token}",
        ]
        try:
            from websockets.typing import Subprotocol
            typed_protocols = [Subprotocol(p) for p in subprotocols]
            ws = await asyncio.wait_for(
                websockets.connect(
                    ws_url,
                    subprotocols=typed_protocols,
                    ping_interval=None,  # SDK manages its own liveness
                ),
                timeout=self._connect_timeout,
            )
        except asyncio.TimeoutError as exc:
            raise make_error(
                "transport_connect_timeout", "WebSocket connect timed out"
            ) from exc
        except Exception as exc:
            raise make_error(
                "transport_connect_timeout", f"WebSocket connect failed: {exc}"
            ) from exc

        self._ws = ws
        self._connection_generation += 1
        self._reader_task = asyncio.create_task(self._reader_loop())

    async def send_json(self, message: dict[str, object]) -> None:
        """Serialize and send a message. Raises transport_send_timeout on timeout."""
        ws = self._ws
        if ws is None:
            raise make_error("transport_send_timeout", "No open connection")
        data = json.dumps(message)
        try:
            await asyncio.wait_for(ws.send(data), timeout=self._send_timeout)
        except asyncio.TimeoutError as exc:
            raise make_error("transport_send_timeout", "Send timed out") from exc
        except Exception as exc:
            raise make_error("transport_send_timeout", str(exc)) from exc

    async def send_binary(self, data: bytes) -> None:
        ws = self._ws
        if ws is None:
            raise make_error("file_transfer_interrupted", "No open connection")
        generation = self._connection_generation
        try:
            await asyncio.wait_for(ws.send(data), timeout=self._send_timeout)
        except asyncio.TimeoutError as exc:
            raise make_error("transport_send_timeout", "Binary send timed out") from exc
        except Exception as exc:
            raise make_error("file_transfer_interrupted", str(exc)) from exc
        if self._ws is not ws or self._connection_generation != generation:
            raise make_error("file_transfer_interrupted", "Connection changed during binary send")

    def close(self, code: int = 1000, reason: str = "disconnect") -> None:
        """Synchronous close — cancels reader task and schedules WS close."""
        task = self._reader_task
        ws = self._ws
        self._reader_task = None
        self._ws = None
        if ws is not None:
            self._connection_generation += 1

        if task and not task.done():
            task.cancel()
        if ws is not None:
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(ws.close(code, reason))
            except RuntimeError:
                pass  # no running loop — connection already gone

    async def aclose(self, code: int = 1000, reason: str = "disconnect") -> None:
        """Async close — waits for reader task to finish."""
        task = self._reader_task
        ws = self._ws
        self._reader_task = None
        self._ws = None
        if ws is not None:
            self._connection_generation += 1

        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        if ws is not None:
            try:
                await ws.close(code, reason)
            except Exception:
                pass

    async def _reader_loop(self) -> None:
        ws = self._ws
        if ws is None:
            return
        try:
            async for raw in ws:
                if isinstance(raw, str):
                    if self.on_text:
                        self.on_text(raw)
                elif self.on_binary:
                    self.on_binary(bytes(raw))
        except websockets.exceptions.ConnectionClosed as exc:
            # Only fire on_close if we weren't already cleaned up
            if self._ws is None:
                return  # transport.close() was called — suppress callback
            if self._ws is ws:
                self._ws = None
                self._connection_generation += 1
            # .rcvd is the received close frame (None if connection was aborted)
            rcvd = exc.rcvd
            code = rcvd.code if rcvd is not None else 1006
            reason = rcvd.reason if rcvd is not None else ""
            if self.on_close:
                self.on_close(code, reason)
        except asyncio.CancelledError:
            pass  # clean shutdown from close() / aclose()
        except Exception as exc:
            if self.on_error:
                self.on_error(exc)
