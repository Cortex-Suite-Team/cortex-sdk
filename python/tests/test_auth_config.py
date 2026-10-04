from __future__ import annotations

import base64
import json
import time
from collections.abc import Callable

import pytest

from cortex_sdk import CortexClient
from cortex_sdk import auth as auth_module
from cortex_sdk.constants import AUTH_REFRESH_PATH, AUTH_TOKEN_PATH, DEFAULT_AUTH_URL

from .helpers import wait_for
from .mock_server import start_mock_server


class _FakeResponse:
    def __init__(self, body: dict[str, object], *, status_code: int = 200) -> None:
        self._body = body
        self.status_code = status_code

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300

    def json(self) -> dict[str, object]:
        return self._body


class _CapturingAsyncClient:
    def __init__(
        self,
        requests: list[tuple[str, dict[str, str], dict[str, object] | None]],
        responder: Callable[[str], _FakeResponse],
    ) -> None:
        self._requests = requests
        self._responder = responder

    async def __aenter__(self) -> _CapturingAsyncClient:
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None

    async def post(
        self,
        url: str,
        headers: dict[str, str],
        json: dict[str, object] | None = None,
    ) -> _FakeResponse:
        self._requests.append((url, headers, json))
        return self._responder(url)


def _make_jwt(exp_seconds_from_now: int) -> str:
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "typ": "JWT"}).encode()
    ).rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(
        json.dumps({"exp": int(time.time()) + exp_seconds_from_now}).encode()
    ).rstrip(b"=").decode()
    return f"{header}.{payload}.fakesig"


@pytest.mark.asyncio
async def test_exchange_api_key_uses_default_auth_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[tuple[str, dict[str, str], dict[str, object] | None]] = []
    monkeypatch.setattr(
        auth_module.httpx,
        "AsyncClient",
        lambda: _CapturingAsyncClient(
            requests,
            lambda _url: _FakeResponse({
                "ws_url": "ws://runtime.test/ws",
                "access_token": _make_jwt(3600),
                "refresh_token": "refresh_token_v1",
                "runtime_bootstrap": {
                    "execution_mode": "production",
                    "bundle_url": "/bundle",
                    "checksum": "sha256:test",
                },
            }),
        ),
    )

    await auth_module.exchange_api_key("test-key")

    assert requests == [
        (
            f"{DEFAULT_AUTH_URL}{AUTH_TOKEN_PATH}",
            {
                "Content-Type": "application/json",
                "Authorization": "ApiKey test-key",
            },
            None,
        )
    ]


@pytest.mark.asyncio
async def test_exchange_and_refresh_use_custom_auth_base(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[tuple[str, dict[str, str], dict[str, object] | None]] = []
    monkeypatch.setattr(
        auth_module.httpx,
        "AsyncClient",
        lambda: _CapturingAsyncClient(
            requests,
            lambda url: _FakeResponse(
                {
                    "access_token": _make_jwt(3600)
                }
                if url.endswith(AUTH_REFRESH_PATH)
                else {
                    "ws_url": "ws://runtime.test/ws",
                    "access_token": _make_jwt(30),
                    "refresh_token": "refresh_token_v1",
                    "runtime_bootstrap": {
                        "execution_mode": "production",
                        "bundle_url": "/bundle",
                        "checksum": "sha256:test",
                    },
                }
            ),
        ),
    )

    await auth_module.exchange_api_key("test-key", auth_base_url="https://auth.example.test/")
    await auth_module.refresh_access_token(
        "refresh_token_v1",
        auth_base_url="https://auth.example.test/",
    )

    assert requests == [
        (
            "https://auth.example.test/auth/token",
            {
                "Content-Type": "application/json",
                "Authorization": "ApiKey test-key",
            },
            None,
        ),
        (
            "https://auth.example.test/auth/refresh",
            {
                "Content-Type": "application/json",
                "Authorization": "Bearer refresh_token_v1",
            },
            None,
        ),
    ]


@pytest.mark.asyncio
async def test_exchange_api_key_sends_worker_ref_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[tuple[str, dict[str, str], dict[str, object] | None]] = []
    monkeypatch.setattr(
        auth_module.httpx,
        "AsyncClient",
        lambda: _CapturingAsyncClient(
            requests,
            lambda _url: _FakeResponse({
                "ws_url": "ws://runtime.test/ws",
                "access_token": _make_jwt(3600),
                "refresh_token": "refresh_token_v1",
                "runtime_bootstrap": {
                    "execution_mode": "production",
                    "bundle_url": "/bundle",
                    "checksum": "sha256:test",
                },
            }),
        ),
    )

    await auth_module.exchange_api_key("test-key", worker_ref="live-worker")

    assert requests[0][2] == {"worker_ref": "live-worker"}


@pytest.mark.asyncio
async def test_client_auth_url_is_public_and_refresh_uses_same_base() -> None:
    server = await start_mock_server(auto_chat_answer=True, auto_init_echo=True)
    received: list[dict[str, object]] = []
    client = CortexClient(
        api_key="test-key",
        auth_url=f"{server.http_url}/",
        on_message=lambda msg: received.append(msg),
        ping_interval=60.0,
        stale_threshold=60.0,
    )

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)

        assert client._auth_url == server.http_url

        client._access_token = _make_jwt(30)
        await client._maybe_refresh_token()

        assert server.refresh_call_count == 1
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_normalize_full_endpoint_url_to_base(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[tuple[str, dict[str, str]]] = []
    monkeypatch.setattr(
        auth_module.httpx,
        "AsyncClient",
        lambda: _CapturingAsyncClient(
            requests,
            lambda _url: _FakeResponse({
                "ws_url": "ws://runtime.test/ws",
                "access_token": _make_jwt(3600),
                "refresh_token": "refresh_token_v1",
                "runtime_bootstrap": {
                    "execution_mode": "production",
                    "bundle_url": "/bundle",
                    "checksum": "sha256:test",
                },
            }),
        ),
    )

    # Consumer passes a full endpoint URL instead of base URL — must not double-path
    await auth_module.exchange_api_key(
        "test-key",
        auth_base_url="https://auth.example.test/auth/token",  # wrong: full endpoint
    )

    url_called = requests[0][0]
    assert url_called == "https://auth.example.test/auth/token"
    assert "/auth/token/auth/token" not in url_called
