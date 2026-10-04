from __future__ import annotations

import asyncio

import pytest

from cortex_sdk.transport import Transport


class _FakeConnection:
    def __init__(self, frames: list[str | bytes]) -> None:
        self._frames = frames
        self.sent: list[str | bytes] = []

    def __aiter__(self) -> _FakeConnection:
        return self

    async def __anext__(self) -> str | bytes:
        if not self._frames:
            raise StopAsyncIteration
        return self._frames.pop(0)

    async def send(self, data: str | bytes) -> None:
        await asyncio.sleep(0)
        self.sent.append(data)


@pytest.mark.asyncio
async def test_reader_keeps_text_and_binary_separate_and_binary_send_is_awaited() -> None:
    transport = Transport(1.0, 1.0)
    connection = _FakeConnection(['{"ok": true}', b"\xff\x00"])
    transport._ws = connection  # type: ignore[assignment]
    texts: list[str] = []
    binaries: list[bytes] = []
    transport.on_text = texts.append
    transport.on_binary = binaries.append
    await transport._reader_loop()
    assert texts == ['{"ok": true}']
    assert binaries == [b"\xff\x00"]

    transport._ws = connection  # type: ignore[assignment]
    await transport.send_binary(b"CFT1")
    assert connection.sent == [b"CFT1"]
