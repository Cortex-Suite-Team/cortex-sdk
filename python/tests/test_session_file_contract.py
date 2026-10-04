from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from cortex_sdk.file_transfer import assert_safe_public_control, decode_cft1, encode_cft1
from cortex_sdk.upload import create_upload_source

CONTRACT = json.loads((Path(__file__).parents[2] / "contracts" / "session_file_ws_v1.json").read_text(encoding="utf-8"))


def test_shared_cft1_vectors() -> None:
    for vector in CONTRACT["cft1"]["vectors"]:
        if vector["valid"]:
            frame = encode_cft1(vector["transfer_id"], vector["sequence"], bytes.fromhex(vector["payload_hex"]))
            assert frame.hex() == vector["frame_hex"]
            transfer_id, sequence, payload = decode_cft1(bytes.fromhex(vector["frame_hex"]))
            assert (transfer_id, sequence, payload.hex()) == (vector["transfer_id"], vector["sequence"], vector["payload_hex"])
        elif "frame_hex" in vector:
            with pytest.raises(Exception):
                decode_cft1(bytes.fromhex(vector["frame_hex"]))
        else:
            with pytest.raises(Exception):
                encode_cft1(vector["transfer_id"], vector["sequence"], b"")


def test_identity_firewall() -> None:
    with pytest.raises(Exception):
        assert_safe_public_control({"nested": {"storage_key": "secret"}})
    with pytest.raises(Exception):
        assert_safe_public_control({"value": "fi_private"})


@pytest.mark.asyncio
async def test_bytes_and_seekable_sources_are_sized_without_copying() -> None:
    byte_source = await create_upload_source(b"abc", filename="a.bin")
    assert (byte_source.filename, byte_source.size) == ("a.bin", 3)
    stream = io.BytesIO(b"prefix-data")
    stream.seek(7)
    source = await create_upload_source(stream)
    assert source.size == 4
    chunks = [chunk async for chunk in source.chunks(2)]
    assert b"".join(chunks) == b"data"
    await source.cleanup()
    assert stream.tell() == 7
