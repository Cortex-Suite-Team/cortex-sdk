from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest

from cortex_sdk.file_transfer import encode_cft1
from cortex_sdk.upload import UploadSource

from .helpers import make_client, wait_for
from .mock_server import start_mock_server


def controlled_source() -> tuple[UploadSource, asyncio.Event]:
    release = asyncio.Event()

    async def chunks(_chunk_bytes: int) -> AsyncIterator[bytes]:
        yield b"ab"
        await release.wait()
        yield b"cd"

    async def cleanup() -> None:
        return None

    return UploadSource("slow.bin", "application/octet-stream", 4, chunks, cleanup), release


@pytest.mark.asyncio
async def test_old_upload_never_resumes_on_reconnected_socket() -> None:
    server = await start_mock_server(auto_init_echo=True)
    client = make_client(server, [])
    source, release = controlled_source()
    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        upload = asyncio.create_task(client._file_transfers.upload(client.session_id or "", source))
        await wait_for(lambda: len(server.binary_frames) == 1)
        await server.drop_connections()
        await wait_for(lambda: server.ws_connection_count >= 2 and client.channel_state == "OPEN", timeout=5.0)
        binary_count = len(server.binary_frames)
        release.set()
        with pytest.raises(Exception) as exc_info:
            await upload
        assert getattr(exc_info.value, "code", None) == "file_transfer_interrupted"
        await asyncio.sleep(0.025)
        assert len(server.binary_frames) == binary_count
    finally:
        release.set()
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "frame",
    [
        b"CF",
        encode_cft1("ft_ffffffffffffffffffffffffffffffff", 0, b"x"),
    ],
    ids=["malformed", "unknown-transfer"],
)
async def test_invalid_inbound_binary_aborts_files_not_session(frame: bytes) -> None:
    server = await start_mock_server(auto_init_echo=True)
    client = make_client(server, [])
    source, release = controlled_source()
    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        upload = asyncio.create_task(client._file_transfers.upload(client.session_id or "", source))
        await wait_for(lambda: len(server.binary_frames) >= 1)
        client._file_transfers.handle_binary(frame)
        release.set()
        with pytest.raises(Exception) as exc_info:
            await upload
        assert getattr(exc_info.value, "code", None) == "invalid_file_transfer"
        assert client.channel_state == "OPEN"
    finally:
        release.set()
        await client.disconnect()
        await server.close()
