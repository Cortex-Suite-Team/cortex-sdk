"""EA multi-file contract (SDK #2): 3 user files -> one chat::message -> 2 generated files.

Driven by contracts/session_file_attachments_v1.json. The WebSocket peer is a
strict SessionManager-like fake built from the Edge #6 source contract; this is
source-level qualification, NOT physical SessionManager/File Link evidence.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft7Validator

from cortex_sdk.constants import MAX_ATTACHMENTS_PER_MESSAGE
from cortex_sdk.errors import CortexError, lookup_error
from cortex_sdk.files import (
    normalize_session_file_attachments,
    parse_message_attachments,
    parse_public_attachment,
    parse_session_file_list,
)

from .helpers import make_client, wait_for
from .mock_server import FIXED_SESSION_ID, MockServer, start_mock_server

ROOT = Path(__file__).resolve().parents[2]
FIXTURE: dict[str, Any] = json.loads((ROOT / "contracts" / "session_file_attachments_v1.json").read_text(encoding="utf-8"))
FORBIDDEN_JSON = re.compile(
    r'"(fi_|sn_)|file_id|snapshot_id|scope_type|scope_id|storage_key|ticket|download_mint_url|download_url|upload_path|"url"'
)
INPUTS = FIXTURE["inputs"]
OUTPUTS = FIXTURE["outputs"]
MESSAGES = FIXTURE["messages"]


def _validator(name: str) -> Draft7Validator:
    return Draft7Validator(json.loads((ROOT / "shared" / "schema" / name).read_text(encoding="utf-8")))


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _answer_with(attachments: object) -> dict[str, Any]:
    return {"type": "chat::answer", "schema": "1.0", "session_id": FIXED_SESSION_ID, "ts": "",
            "payload": {**MESSAGES["chat_answer"], "meta": {"attachments": attachments}}}


def _echo_with(attachments: object) -> dict[str, Any]:
    return {"type": "chat::echo", "schema": "1.0", "session_id": FIXED_SESSION_ID, "ts": "",
            "payload": {**MESSAGES["chat_echo"], "meta": {"client_msg_id": FIXTURE["client_msg_id"], "attachments": attachments}}}


def _is_fixture_echo(message: Any) -> bool:
    meta = message["payload"].get("meta") or {}
    return message["type"] == "chat::echo" and meta.get("client_msg_id") == FIXTURE["client_msg_id"]


# ── fixture-driven unit vectors ────────────────────────────────────────────

def test_fixture_pins_limit_fields_and_bytes() -> None:
    assert FIXTURE["limits"]["max_attachments_per_message"] == MAX_ATTACHMENTS_PER_MESSAGE
    for file in INPUTS + OUTPUTS:
        assert sorted(file["descriptor"]) == sorted(FIXTURE["public_descriptor_fields"])
        data = bytes.fromhex(file["bytes_hex"])
        assert file["descriptor"]["size"] == len(data)
        assert _sha256(data) == file["sha256"]


@pytest.mark.parametrize("schema_name,key", [
    ("chat.message.json", "chat_message"),
    ("chat.echo.json", "chat_echo"),
    ("chat.answer.json", "chat_answer"),
    ("file.list.result.json", "file_list_result"),
])
def test_fixture_messages_conform_to_shared_schemas(schema_name: str, key: str) -> None:
    assert [e.message for e in _validator(schema_name).iter_errors(MESSAGES[key])] == []


def test_schemas_accept_exactly_untouched_descriptors() -> None:
    answer_schema = _validator("chat.answer.json")
    for vector in FIXTURE["hostile_descriptors"]:
        clean = vector["expected"] is not None and vector["expected"] == vector["input"]
        assert answer_schema.is_valid({**MESSAGES["chat_answer"], "meta": {"attachments": [vector["input"]]}}) is clean, vector["name"]
    assert not answer_schema.is_valid({**MESSAGES["chat_answer"], "meta": {"attachments": [INPUTS[0]["descriptor"]]}})
    assert answer_schema.is_valid({**MESSAGES["chat_answer"], "meta": {**MESSAGES["chat_answer"]["meta"], "billing": {"summary": {}}}})
    assert not _validator("file.list.result.json").is_valid({"files": [{**OUTPUTS[0]["descriptor"], "file_id": "fi_x"}], "total": 1})


@pytest.mark.parametrize("vector", FIXTURE["hostile_descriptors"], ids=lambda v: v["name"])
def test_public_projection(vector: dict[str, Any]) -> None:
    assert parse_public_attachment(vector["input"]) == vector["expected"]


@pytest.mark.parametrize("vector", FIXTURE["answer_projection_cases"], ids=lambda v: v["name"])
def test_answer_attachments(vector: dict[str, Any]) -> None:
    assert [d["file_ref"] for d in parse_message_attachments(_answer_with(vector["attachments"]))] == vector["expected_refs"]


@pytest.mark.parametrize("vector", FIXTURE["echo_projection_cases"], ids=lambda v: v["name"])
def test_echo_attachments(vector: dict[str, Any]) -> None:
    assert [d["file_ref"] for d in parse_message_attachments(_echo_with(vector["attachments"]))] == vector["expected_refs"]


def test_answer_binds_by_numeric_turn() -> None:
    outputs = [{**file["descriptor"], "message_ref": "7"} for file in OUTPUTS]
    message = {"type": "chat::answer", "payload": {"content": ["x"], "role": "assistant", "answer_kind": "final", "turn": 7, "meta": {"attachments": outputs}}}
    assert parse_message_attachments(message) == outputs
    assert parse_message_attachments({**message, "payload": {**message["payload"], "turn": 8}}) == []


@pytest.mark.parametrize("vector", FIXTURE["send_rejections"], ids=lambda v: v["name"])
def test_send_rejection(vector: dict[str, Any]) -> None:
    with pytest.raises(CortexError) as exc_info:
        normalize_session_file_attachments(vector["attachments"])
    assert (exc_info.value.code, exc_info.value.retryable, exc_info.value.fatal) == (vector["error_code"], False, False)


def test_zero_one_three_and_eight_attachments_keep_order() -> None:
    assert normalize_session_file_attachments([]) == []
    assert normalize_session_file_attachments(["sf_one"]) == [{"file_ref": "sf_one"}]
    refs = [file["descriptor"]["file_ref"] for file in INPUTS]
    assert normalize_session_file_attachments(refs) == [{"file_ref": ref} for ref in refs]
    eight = [f"sf_n{i}" for i in range(MAX_ATTACHMENTS_PER_MESSAGE)]
    assert [a["file_ref"] for a in normalize_session_file_attachments(eight)] == eight


def test_session_file_list_rejects_invalid_entries() -> None:
    assert parse_session_file_list(MESSAGES["file_list_result"])["files"] == [f["descriptor"] for f in INPUTS + OUTPUTS]
    with pytest.raises(CortexError) as exc_info:
        parse_session_file_list({"files": [{**OUTPUTS[0]["descriptor"], "size": -1}], "total": 1})
    assert exc_info.value.code == "file_operation_failed"


@pytest.mark.parametrize("vector", FIXTURE["server_attachment_errors"], ids=lambda v: v["name"])
def test_catalog_classifies_server_attachment_errors(vector: dict[str, Any]) -> None:
    entry = lookup_error(vector["payload"]["code"])
    assert entry is not None and (entry.retryable, entry.fatal) == (vector["retryable"], vector["fatal"])


# ── strict SessionManager-like peer ────────────────────────────────────────

class SessionFileFake:
    def __init__(self) -> None:
        self.records: dict[str, dict[str, Any]] = {
            f["descriptor"]["file_ref"]: {"descriptor": dict(f["descriptor"]), "bytes": bytes.fromhex(f["bytes_hex"])}
            for f in OUTPUTS
        }
        self.order: list[str] = []
        self.upload_prepare_count = 0
        self.drop_next_echo = False
        self.resyncs = 0
        self._transfers: dict[str, dict[str, Any]] = {}
        self._next_transfer = 1
        self._next_input = 0

    def _transfer_id(self) -> str:
        transfer_id = f"ft_{self._next_transfer:032x}"
        self._next_transfer += 1
        return transfer_id

    async def handle(self, msg: dict[str, Any], ws: Any, srv: MockServer) -> None:
        msg_type = msg.get("type")
        payload = msg.get("payload") or {}
        meta = msg.get("meta") or {}
        correlation = {"client_msg_id": meta.get("client_msg_id")}

        async def send(envelope: dict[str, Any]) -> None:
            await srv.send_to(ws, {"schema": "1.0", "session_id": FIXED_SESSION_ID, "ts": "2026-10-15T00:00:00Z", **envelope})

        if msg_type == "system::resync":
            self.resyncs += 1
        elif msg_type == "file::upload.prepare":
            self.upload_prepare_count += 1
            transfer_id = self._transfer_id()
            self._transfers[transfer_id] = {"index": self._next_input, "size": payload["size"]}
            self._next_input += 1
            await send({"type": "file::upload.ready", "payload": {"transfer_id": transfer_id, "chunk_bytes": 64, "max_bytes": 1 << 20}, "meta": correlation})
        elif msg_type == "file::upload.commit":
            transfer_id = payload["transfer_id"]
            transfer = self._transfers[transfer_id]
            data = b"".join(frame[24:] for frame in srv.binary_frames if frame[:4] == b"CFT1" and frame[4:20].hex() == transfer_id[3:])
            source = INPUTS[transfer["index"]]
            assert _sha256(data) == source["sha256"] and len(data) == transfer["size"]
            descriptor = {k: v for k, v in source["descriptor"].items() if k not in ("message_ref", "message_ref_kind")}
            self.records[descriptor["file_ref"]] = {"descriptor": descriptor, "bytes": data}
            self.order.append(descriptor["file_ref"])
            await send({"type": "file::upload.complete", "payload": {"transfer_id": transfer_id, "file_ref": descriptor["file_ref"]}, "meta": correlation})
        elif msg_type == "file::download.prepare":
            record = self.records.get(payload.get("file_ref"))
            if record is None or record["descriptor"]["state"] != "available":
                await send({"type": "system::error", "payload": {"code": "file_unavailable", "message": "File is unavailable"}, "meta": correlation})
                return
            transfer_id = self._transfer_id()
            descriptor, data = record["descriptor"], record["bytes"]
            await send({"type": "file::download.ready", "payload": {
                "transfer_id": transfer_id, "file_ref": descriptor["file_ref"], "filename": descriptor["filename"],
                "content_type": descriptor["content_type"], "size": len(data), "chunk_bytes": 64,
            }, "meta": correlation})
            for sequence, offset in enumerate(range(0, max(len(data), 1), 64)):
                await ws.send(b"CFT1" + bytes.fromhex(transfer_id[3:]) + sequence.to_bytes(4, "big") + data[offset:offset + 64])
            await send({"type": "file::download.complete", "payload": {"transfer_id": transfer_id}})
        elif msg_type == "file::list":
            refs = self.order + [f["descriptor"]["file_ref"] for f in OUTPUTS]
            files = [self.records[ref]["descriptor"] for ref in refs]
            await send({"type": "file::list.result", "payload": {"files": files, "total": len(files)}, "meta": correlation})
        elif msg_type == "chat::message":
            await self._handle_chat(payload, send)

    async def _handle_chat(self, payload: dict[str, Any], send: Any) -> None:
        meta = payload.get("meta") or {}
        client_msg_id = meta.get("client_msg_id")
        refs = [a["file_ref"] for a in meta.get("attachments", [])]

        async def error(code: str, message: str) -> None:
            await send({"type": "system::error", "payload": {"code": code, "message": message}, "meta": {"client_msg_id": client_msg_id}})

        if len(refs) > FIXTURE["limits"]["max_attachments_per_message"]:
            await error("too_many_attachments", "At most 8 file(s) may be attached per message.")
            return
        for ref in refs:  # whole-list validation before any binding
            record = self.records.get(ref)
            if record is None or record["descriptor"]["owner_role"] != "user":
                await error("invalid_attachment", f"{ref}: session file not found")
                return
            if record["descriptor"].get("message_ref") not in (None, client_msg_id):
                await error("invalid_attachment", f"{ref}: message binding conflict")
                return
        bound = []
        for ref in refs:
            record = self.records[ref]
            record["descriptor"] = {**record["descriptor"], "message_ref": client_msg_id, "message_ref_kind": "client_msg_id"}
            bound.append(record["descriptor"])
        if not bound:
            return
        if self.drop_next_echo:
            self.drop_next_echo = False
            return
        hostile_echo = [{**d, "file_id": f"fi_{i}", "snapshot_id": f"sn_{i}"} for i, d in enumerate(bound)]
        await send({"type": "chat::echo", "payload": {"content": payload.get("content"), "role": "user", "meta": {"client_msg_id": client_msg_id, "attachments": hostile_echo}}})
        outputs = [f["descriptor"] for f in OUTPUTS]
        await send({"type": "chat::answer", "payload": {**MESSAGES["chat_answer"], "meta": {
            "billing": {"summary": {"authoritative": False}},
            "attachments": [bound[0], {**outputs[0], "download_mint_url": "https://evil.example/mint", "delivery_ticket": "tkt"}, outputs[1], outputs[0]],
        }}})


async def _start(fake: SessionFileFake) -> MockServer:
    return await start_mock_server(
        auto_chat_answer=False, auto_init_echo=True, auto_file_transport=False,
        on_ws_message=fake.handle,
    )


@pytest.mark.asyncio
async def test_three_inputs_two_outputs_retry_and_reconnect() -> None:
    fake = SessionFileFake()
    server = await _start(fake)
    received: list[Any] = []
    client = make_client(server, received)
    input_refs = [f["descriptor"]["file_ref"] for f in INPUTS]
    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)

        refs = [await client.upload_attachment(bytes.fromhex(f["bytes_hex"])) for f in INPUTS]
        assert refs == input_refs

        # Lost send response: retry reuses client_msg_id and refs; nothing is re-uploaded.
        fake.drop_next_echo = True
        meta = {"client_msg_id": FIXTURE["client_msg_id"]}
        await client.send_message(MESSAGES["chat_message"]["content"], refs, meta=meta)
        await asyncio.sleep(0.1)
        assert not any(_is_fixture_echo(m) for m in received)
        await client.send_message(MESSAGES["chat_message"]["content"], refs, meta=meta)
        await wait_for(lambda: any(m["type"] == "chat::answer" for m in received))
        assert fake.upload_prepare_count == 3

        sent = [m["payload"] for m in server.received if m["type"] == "chat::message"]
        assert sent == [MESSAGES["chat_message"], MESSAGES["chat_message"]]

        echo = next(m for m in received if _is_fixture_echo(m))
        assert echo["payload"]["meta"]["attachments"] == MESSAGES["chat_echo"]["meta"]["attachments"]
        answer = next(m for m in received if m["type"] == "chat::answer")
        assert answer["payload"]["meta"]["attachments"] == [f["descriptor"] for f in OUTPUTS]
        assert answer["payload"]["meta"]["billing"] == {"summary": {"authoritative": False}}
        assert not FORBIDDEN_JSON.search(json.dumps(received))

        for output in OUTPUTS:
            assert _sha256(await client.download_file(output["descriptor"]["file_ref"])) == output["sha256"]
        both = await asyncio.gather(*(client.download_file(o["descriptor"]["file_ref"]) for o in OUTPUTS))
        assert [_sha256(data) for data in both] == [o["sha256"] for o in OUTPUTS]

        await server.drop_connections()
        await wait_for(lambda: fake.resyncs == 1 and client.channel_state == "OPEN", timeout=6.0)
        listed = await client.list_files()
        assert listed == MESSAGES["file_list_result"]
        assert not FORBIDDEN_JSON.search(json.dumps(listed))
        assert _sha256(await client.download_file(OUTPUTS[1]["descriptor"]["file_ref"])) == OUTPUTS[1]["sha256"]
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_attachment_and_download_errors_do_not_fail_the_session() -> None:
    fake = SessionFileFake()
    server = await _start(fake)
    received: list[Any] = []
    client = make_client(server, received)
    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)

        for attachments, code in ((["sf_n%d" % i for i in range(9)], "too_many_attachments"), (["sf_a", "sf_a"], "invalid_attachment")):
            with pytest.raises(CortexError) as exc_info:
                await client.send_message("x", attachments)
            assert exc_info.value.code == code
        for meta in ({"attachments": ["fi_0123456789abcdef"]}, {"attachments": [{"file_ref": "sf_a", "download_mint_url": "https://evil.example"}]}):
            with pytest.raises(CortexError) as raw_meta:
                await client.send_message("x", meta=meta)
            assert raw_meta.value.code == "invalid_attachment"
        assert not [m for m in server.received if m["type"] == "chat::message"]
        await client.send_message("x", [], meta={"client_msg_id": "cli_msg_empty", "attachments": ["fi_ignored"]})
        await client.send_message("x", meta={"client_msg_id": "cli_msg_one", "attachments": [{"file_ref": OUTPUTS[0]["descriptor"]["file_ref"]}]})
        await wait_for(lambda: len([m for m in server.received if m["type"] == "chat::message"]) == 2)
        assert [m["payload"] for m in server.received if m["type"] == "chat::message"] == [
            {"content": "x", "role": "user", "meta": {"client_msg_id": "cli_msg_empty"}},
            {"content": "x", "role": "user", "meta": {"client_msg_id": "cli_msg_one", "attachments": [{"file_ref": OUTPUTS[0]["descriptor"]["file_ref"]}]}},
        ]
        # The second one is rejected server-side (assistant file as user attachment); discard both.
        await wait_for(lambda: any(m["type"] == "system::error" for m in received))
        received.clear()

        await client.send_message("x", ["sf_unknown"], meta={"client_msg_id": "cli_msg_bad"})
        await wait_for(lambda: any(m["type"] == "system::error" for m in received))
        error = next(m for m in received if m["type"] == "system::error")
        assert error["payload"]["code"] == "invalid_attachment"
        assert error["meta"]["client_msg_id"] == "cli_msg_bad"
        assert client.session_state == "ACTIVE" and client.channel_state == "OPEN"

        with pytest.raises(CortexError) as missing:
            await client.download_file("sf_out_missing")
        assert missing.value.code == "file_unavailable"
        first = OUTPUTS[0]["descriptor"]["file_ref"]
        fake.records[first]["descriptor"] = {**fake.records[first]["descriptor"], "state": "expired"}
        with pytest.raises(CortexError) as expired:
            await client.download_file(first)
        assert expired.value.code == "file_unavailable"
        listed = await client.list_files()
        assert [(f["file_ref"], f.get("state")) for f in listed["files"]] == [
            (first, "expired"), (OUTPUTS[1]["descriptor"]["file_ref"], "available"),
        ]
        for hostile in ("https://evil.example/f", "fi_0123456789abcdef"):
            with pytest.raises(CortexError) as rejected:
                await client.download_file(hostile)
            assert rejected.value.code == "file_operation_failed"
        assert client.session_state == "ACTIVE"
    finally:
        await client.disconnect()
        await server.close()
