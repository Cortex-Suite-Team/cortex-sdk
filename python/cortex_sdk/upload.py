from __future__ import annotations

from typing import BinaryIO

import httpx

from .errors import make_error
from .files import require_session_file_ref

# Default upload endpoint — overridden via client's _upload_url for tests
_DEFAULT_UPLOAD_URL = "/upload"


async def upload_file(
    file: str | bytes | BinaryIO,
    access_token: str,
    upload_url: str = _DEFAULT_UPLOAD_URL,
) -> str:
    """Upload a file and return the canonical session file_ref.

    Args:
        file: file path string, raw bytes, or a file-like (BinaryIO) object.
        access_token: Bearer token for Authorization header.
        upload_url: full URL of the upload endpoint.
    """
    if isinstance(file, str):
        with open(file, "rb") as fh:
            data = fh.read()
    elif isinstance(file, bytes):
        data = file
    else:
        data = file.read()  # BinaryIO

    files = {"file": ("upload", data, "application/octet-stream")}

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            upload_url,
            headers={"Authorization": f"Bearer {access_token}"},
            files=files,
        )

    if not resp.is_success:
        if resp.status_code == 413:
            raise make_error("upload_too_large", "File exceeds the allowed size limit")
        if resp.status_code == 415:
            raise make_error("upload_type_rejected", "File type not accepted by the runtime")
        raise make_error("upload_failed", f"Upload failed with status {resp.status_code}")

    body = resp.json()
    try:
        return require_session_file_ref(body.get("file_ref"), "Upload response file_ref")
    except Exception as exc:
        raise make_error("upload_failed", "Upload response must include a canonical sf_ file_ref") from exc
