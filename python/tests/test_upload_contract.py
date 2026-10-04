from __future__ import annotations

import pytest

from cortex_sdk.errors import CortexError
from cortex_sdk.upload import upload_file


class _Response:
    is_success = True
    status_code = 200

    def __init__(self, body: dict[str, object]) -> None:
        self._body = body

    def json(self) -> dict[str, object]:
        return self._body


class _Client:
    def __init__(self, response: _Response) -> None:
        self._response = response

    async def __aenter__(self) -> _Client:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def post(self, *_args: object, **_kwargs: object) -> _Response:
        return self._response


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {"file_id": "fi_test"},
        {"attachment_id": "fa_test"},
        {"file_ref": "fi_test"},
        {},
    ],
)
async def test_upload_rejects_noncanonical_response(
    monkeypatch: pytest.MonkeyPatch,
    body: dict[str, object],
) -> None:
    monkeypatch.setattr(
        "cortex_sdk.upload.httpx.AsyncClient",
        lambda: _Client(_Response(body)),
    )

    with pytest.raises(CortexError) as exc_info:
        await upload_file(b"data", "token", "https://example.test/upload")

    assert exc_info.value.code == "upload_failed"


@pytest.mark.asyncio
async def test_upload_accepts_canonical_file_ref(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "cortex_sdk.upload.httpx.AsyncClient",
        lambda: _Client(_Response({"file_ref": "sf_test"})),
    )

    assert await upload_file(b"data", "token", "https://example.test/upload") == "sf_test"
