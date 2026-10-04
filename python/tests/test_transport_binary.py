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


class _GatedConnection(_FakeConnection):
    def __init__(self) -> None:
        super().__init__([])
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def send(self, data: str | bytes) -> None:
        self.started.set()
        await self.release.wait()
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


@pytest.mark.asyncio
async def test_binary_send_rejects_if_connection_generation_changes() -> None:
    transport = Transport(1.0, 1.0)
    old_connection = _GatedConnection()
    new_connection = _FakeConnection([])
    transport._ws = old_connection  # type: ignore[assignment]
    transport._connection_generation = 1

    send = asyncio.create_task(transport.send_binary(b"CFT1"))
    await old_connection.started.wait()
    transport._ws = new_connection  # type: ignore[assignment]
    transport._connection_generation = 2
    old_connection.release.set()

    with pytest.raises(Exception) as exc_info:
        await send
    assert getattr(exc_info.value, "code", None) == "file_transfer_interrupted"
    assert new_connection.sent == []
