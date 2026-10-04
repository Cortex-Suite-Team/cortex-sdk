from __future__ import annotations

import asyncio
import re
import struct
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import AsyncIterator, Awaitable, Callable

from .constants import SCHEMA_VERSION
from .errors import make_error
from .files import parse_public_file_list, require_session_file_ref
from .transport import Transport
from .types import CortexMessage, FileListResult
from .upload import UploadSource

MAGIC = b"CFT1"
HEADER_BYTES = 24
TRANSFER_ID = re.compile(r"^ft_[0-9a-f]{32}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
FORBIDDEN_KEYS = {"file_id", "snapshot_id", "blob_ref", "storage_key", "ticket", "upload_ticket", "delivery_ticket", "file_link_secret", "instance_id"}
FILE_RESPONSE_TYPES = {"file::upload.ready", "file::upload.complete", "file::download.ready", "file::download.complete", "file::list.result"}


def encode_cft1(transfer_id: str, sequence: int, payload: bytes) -> bytes:
    if TRANSFER_ID.fullmatch(transfer_id) is None:
        raise make_error("invalid_file_transfer", "Invalid CFT1 transfer_id")
    if isinstance(sequence, bool) or not isinstance(sequence, int) or not 0 <= sequence <= 0xFFFFFFFF:
        raise make_error("invalid_file_transfer", "Invalid CFT1 sequence")
    return MAGIC + bytes.fromhex(transfer_id[3:]) + struct.pack(">I", sequence) + payload


def decode_cft1(frame: bytes) -> tuple[str, int, bytes]:
    if len(frame) < HEADER_BYTES:
        raise make_error("invalid_file_transfer", "CFT1 frame is shorter than its header")
    if frame[:4] != MAGIC:
        raise make_error("invalid_file_transfer", "Invalid CFT1 magic")
    return f"ft_{frame[4:20].hex()}", struct.unpack(">I", frame[20:24])[0], frame[24:]


@dataclass
class _Pending:
    expected_type: str
    future: asyncio.Future[CortexMessage]
    transfer_id: str | None = None
    on_response: Callable[[CortexMessage], None] | None = None


@dataclass
class _Download:
    size: int
    future: asyncio.Future[bytes]
    expected_sequence: int = 0
    received: int = 0
    chunks: list[bytes] = field(default_factory=list)
    complete_received: bool = False


class FileTransferManager:
    def __init__(self, transport: Transport, send_timeout: float) -> None:
        self._transport = transport
        self._send_timeout = send_timeout
        self._pending: dict[str, _Pending] = {}
        self._uploads: dict[str, Exception | None] = {}
        self._downloads: dict[str, _Download] = {}

    async def upload(self, session_id: str, source: UploadSource, sha256: str | None = None) -> str:
        if sha256 is not None and SHA256.fullmatch(sha256) is None:
            raise make_error("invalid_file_transfer", "sha256 must be 64 lowercase hex characters")
        transfer_id: str | None = None
        try:
            payload: dict[str, object] = {"filename": source.filename, "content_type": source.content_type, "size": source.size}
            if sha256 is not None:
                payload["sha256"] = sha256
            ready = await self._request(session_id, "file::upload.prepare", "file::upload.ready", payload)
            assert_safe_public_control(ready["payload"])
            transfer_id = _require_transfer_id(ready["payload"].get("transfer_id"))
            chunk_bytes = _positive_int(ready["payload"].get("chunk_bytes"), "chunk_bytes")
            max_bytes = _positive_int(ready["payload"].get("max_bytes"), "max_bytes")
            if source.size > 0 and chunk_bytes > max_bytes:
                raise make_error("invalid_file_transfer", "chunk_bytes exceeds max_bytes")
            if source.size > max_bytes:
                raise make_error("file_too_large", "File exceeds server max_bytes")
            self._uploads[transfer_id] = None
            sequence = 0
            async for chunk in source.chunks(chunk_bytes):
                self._raise_upload_error(transfer_id)
                if not chunk:
                    continue
                if sequence > 0xFFFFFFFF:
                    raise make_error("invalid_file_transfer", "CFT1 sequence overflow")
                await self._transport.send_binary(encode_cft1(transfer_id, sequence, chunk))
                self._raise_upload_error(transfer_id)
                sequence += 1
            self._raise_upload_error(transfer_id)
            complete = await self._request(session_id, "file::upload.commit", "file::upload.complete", {"transfer_id": transfer_id}, transfer_id)
            assert_safe_public_control(complete["payload"])
            if _require_transfer_id(complete["payload"].get("transfer_id")) != transfer_id:
                raise make_error("invalid_file_transfer", "Upload completion transfer_id mismatch")
            return require_session_file_ref(complete["payload"].get("file_ref"), "Upload completion file_ref")
        finally:
            if transfer_id is not None:
                self._uploads.pop(transfer_id, None)
            await source.cleanup()

    async def download(self, session_id: str, file_ref: str) -> bytes:
        future: asyncio.Future[bytes] = asyncio.get_running_loop().create_future()
        def register(ready: CortexMessage) -> None:
            assert_safe_public_control(ready["payload"])
            transfer_id = _require_transfer_id(ready["payload"].get("transfer_id"))
            size = _non_negative_int(ready["payload"].get("size"), "size")
            _positive_int(ready["payload"].get("chunk_bytes"), "chunk_bytes")
            self._downloads[transfer_id] = _Download(size=size, future=future)
        await self._request(session_id, "file::download.prepare", "file::download.ready", {"file_ref": require_session_file_ref(file_ref)}, on_response=register)
        return await future

    async def list(self, session_id: str) -> FileListResult:
        result = await self._request(session_id, "file::list", "file::list.result", {})
        assert_safe_public_control(result["payload"])
        return parse_public_file_list(result["payload"])

    def handle_message(self, message: CortexMessage) -> bool:
        message_type = message.get("type")
        if message_type in FILE_RESPONSE_TYPES:
            try:
                assert_safe_public_control(message["payload"])
                if message_type == "file::download.complete":
                    self._handle_download_complete(message["payload"])
                    return True
                meta = message.get("meta")
                client_msg_id = meta.get("client_msg_id") if isinstance(meta, dict) else None
                if not isinstance(client_msg_id, str):
                    raise make_error("invalid_file_transfer", f"{message_type} missing meta.client_msg_id")
                pending = self._pending.get(client_msg_id)
                if pending is None or pending.expected_type != message_type:
                    raise make_error("invalid_file_transfer", f"Uncorrelated {message_type}")
                if pending.on_response is not None:
                    pending.on_response(message)
                self._pending.pop(client_msg_id, None)
                if not pending.future.done():
                    pending.future.set_result(message)
            except Exception as exc:
                self._reject_relevant(message, exc)
            return True
        if message_type != "system::error":
            return False
        meta = message.get("meta")
        client_msg_id = meta.get("client_msg_id") if isinstance(meta, dict) else None
        transfer_value = message["payload"].get("transfer_id")
        pending = self._pending.get(client_msg_id) if isinstance(client_msg_id, str) else None
        has_transfer = isinstance(transfer_value, str) and (transfer_value in self._uploads or transfer_value in self._downloads)
        if pending is None and not has_transfer:
            return False
        if isinstance(client_msg_id, str) and pending is not None and pending.transfer_id is not None and transfer_value is not None and transfer_value != pending.transfer_id:
            self._reject_pending(client_msg_id, make_error("invalid_file_transfer", "Error correlation fields disagree"))
            return True
        code = message["payload"].get("code")
        text = message["payload"].get("message")
        error = make_error(code if isinstance(code, str) else "invalid_file_transfer", text if isinstance(text, str) else "File operation failed")
        if isinstance(client_msg_id, str):
            self._reject_pending(client_msg_id, error)
        if isinstance(transfer_value, str):
            self._reject_transfer(transfer_value, error)
        return True

    def handle_binary(self, frame: bytes) -> None:
        try:
            transfer_id, sequence, payload = decode_cft1(frame)
        except Exception:
            return
        state = self._downloads.get(transfer_id)
        if state is None:
            return
        if sequence != state.expected_sequence:
            self._reject_transfer(transfer_id, make_error("invalid_file_transfer", "Download sequence mismatch"))
            return
        if state.received + len(payload) > state.size:
            self._reject_transfer(transfer_id, make_error("file_download_failed", "Download exceeds declared size"))
            return
        state.chunks.append(payload)
        state.received += len(payload)
        state.expected_sequence += 1
        self._finish_download(transfer_id, state)

    def abort_all(self) -> None:
        error = make_error("file_transfer_interrupted", "File transfer interrupted by connection close")
        for client_msg_id in list(self._pending):
            self._reject_pending(client_msg_id, error)
        for transfer_id in list(self._downloads):
            self._reject_transfer(transfer_id, error)
        self._uploads.clear()

    async def _request(self, session_id: str, message_type: str, expected_type: str, payload: dict[str, object], transfer_id: str | None = None, on_response: Callable[[CortexMessage], None] | None = None) -> CortexMessage:
        client_msg_id = f"cli_file_{message_type.replace('::', '_').replace('.', '_')}_{uuid.uuid4().hex}"
        future: asyncio.Future[CortexMessage] = asyncio.get_running_loop().create_future()
        self._pending[client_msg_id] = _Pending(expected_type=expected_type, future=future, transfer_id=transfer_id, on_response=on_response)
        envelope: dict[str, object] = {
            "type": message_type,
            "schema": SCHEMA_VERSION,
            "session_id": session_id,
            "payload": payload,
            "meta": {"client_msg_id": client_msg_id},
            "ts": datetime.now(timezone.utc).isoformat(),
        }
        try:
            await self._transport.send_json(envelope)
            return await asyncio.wait_for(future, timeout=self._send_timeout)
        except asyncio.TimeoutError as exc:
            self._pending.pop(client_msg_id, None)
            raise make_error("file_transport_unavailable", f"{message_type} response timed out") from exc
        except Exception:
            self._pending.pop(client_msg_id, None)
            raise

    def _handle_download_complete(self, payload: dict[str, object]) -> None:
        transfer_id = _require_transfer_id(payload.get("transfer_id"))
        state = self._downloads.get(transfer_id)
        if state is None:
            return
        state.complete_received = True
        self._finish_download(transfer_id, state)

    def _finish_download(self, transfer_id: str, state: _Download) -> None:
        if not state.complete_received:
            return
        if state.received != state.size:
            self._reject_transfer(transfer_id, make_error("file_download_failed", "Download size mismatch"))
            return
        self._downloads.pop(transfer_id, None)
        if not state.future.done():
            state.future.set_result(b"".join(state.chunks))

    def _reject_relevant(self, message: CortexMessage, error: Exception) -> None:
        meta = message.get("meta")
        client_msg_id = meta.get("client_msg_id") if isinstance(meta, dict) else None
        if isinstance(client_msg_id, str):
            self._reject_pending(client_msg_id, error)
        transfer_id = message["payload"].get("transfer_id")
        if isinstance(transfer_id, str):
            self._reject_transfer(transfer_id, error)

    def _reject_pending(self, client_msg_id: str, error: Exception) -> None:
        pending = self._pending.pop(client_msg_id, None)
        if pending is not None and not pending.future.done():
            pending.future.set_exception(error)

    def _reject_transfer(self, transfer_id: str, error: Exception) -> None:
        state = self._downloads.pop(transfer_id, None)
        if state is not None and not state.future.done():
            state.future.set_exception(error)
        if transfer_id in self._uploads:
            self._uploads[transfer_id] = error
        for client_msg_id, pending in list(self._pending.items()):
            if pending.transfer_id == transfer_id:
                self._reject_pending(client_msg_id, error)

    def _raise_upload_error(self, transfer_id: str) -> None:
        error = self._uploads.get(transfer_id)
        if error is not None:
            raise error


def assert_safe_public_control(value: object) -> None:
    if isinstance(value, str):
        if value.startswith("fi_"):
            raise make_error("invalid_file_transfer", "Internal File Layer identity leaked")
        return
    if isinstance(value, list):
        for item in value:
            assert_safe_public_control(item)
        return
    if isinstance(value, dict):
        for key, nested in value.items():
            if key in FORBIDDEN_KEYS:
                raise make_error("invalid_file_transfer", f"Forbidden public field: {key}")
            assert_safe_public_control(nested)


def _require_transfer_id(value: object) -> str:
    if not isinstance(value, str) or TRANSFER_ID.fullmatch(value) is None:
        raise make_error("invalid_file_transfer", "Invalid transfer_id")
    return value


def _positive_int(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise make_error("invalid_file_transfer", f"{name} must be a positive integer")
    return value


def _non_negative_int(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise make_error("invalid_file_transfer", f"{name} must be a non-negative integer")
    return value
