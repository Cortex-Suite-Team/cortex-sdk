from __future__ import annotations

import asyncio
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator, BinaryIO, Callable, Awaitable


@dataclass
class UploadSource:
    filename: str
    content_type: str
    size: int
    chunks: Callable[[int], AsyncIterator[bytes]]
    cleanup: Callable[[], Awaitable[None]]


async def create_upload_source(
    file: str | bytes | BinaryIO,
    *,
    filename: str | None = None,
    content_type: str | None = None,
) -> UploadSource:
    mime = content_type or "application/octet-stream"
    if isinstance(file, str):
        path = Path(file)
        size = os.stat(path).st_size
        async def path_chunks(chunk_bytes: int) -> AsyncIterator[bytes]:
            with path.open("rb") as stream:
                while chunk := stream.read(chunk_bytes):
                    yield chunk
        return UploadSource(filename or path.name, mime, size, path_chunks, _noop)

    if isinstance(file, bytes):
        async def bytes_chunks(chunk_bytes: int) -> AsyncIterator[bytes]:
            for offset in range(0, len(file), chunk_bytes):
                yield file[offset:offset + chunk_bytes]
        return UploadSource(filename or "upload", mime, len(file), bytes_chunks, _noop)

    if file.seekable():
        initial = file.tell()
        file.seek(0, os.SEEK_END)
        end = file.tell()
        file.seek(initial)
        async def seekable_chunks(chunk_bytes: int) -> AsyncIterator[bytes]:
            file.seek(initial)
            while chunk := file.read(chunk_bytes):
                yield bytes(chunk)
        async def restore() -> None:
            file.seek(initial)
        return UploadSource(filename or "upload", mime, end - initial, seekable_chunks, restore)

    descriptor, temp_path = tempfile.mkstemp(prefix="cortex-sdk-upload-")
    os.close(descriptor)
    try:
        with open(temp_path, "wb") as target:
            while chunk := file.read(64 * 1024):
                target.write(chunk)
        size = os.stat(temp_path).st_size
    except Exception:
        os.unlink(temp_path)
        raise

    async def temp_chunks(chunk_bytes: int) -> AsyncIterator[bytes]:
        with open(temp_path, "rb") as stream:
            while chunk := stream.read(chunk_bytes):
                yield chunk
    async def remove_temp() -> None:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
    return UploadSource(filename or "upload", mime, size, temp_chunks, remove_temp)


async def _noop() -> None:
    return None
