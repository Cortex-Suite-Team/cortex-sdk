# DISCREPANCIES.md

Known gaps, path changes, and reconciliation decisions for `sdk/shared` artifacts.
Each item records what was found, what decision was taken, and what still needs owner resolution.

---

## D-1. Repository path change

**Found:** The original task description and `coding_plan.md` reference `control-plane/sdk/shared/`.
**Current state:** `control-plane/sdk/` was deleted. The active SDK lives at `sdk/` at project root.
**Decision taken:** All Phase 0 artifacts created at `sdk/shared/`.
**Owner action needed:** None — update any remaining internal references to the old path.

---

## D-2. `07_normative_appendices.md` not on disk

**Found:** `coding_plan.md` points to `07_normative_appendices.md` for payload field definitions.
This file does not exist in the current `sdk/docs/` directory.
**Current state:** The file exists in git history at commit `3616100` (`control-plane/sdk/docs/07_normative_appendices.md`).
**Decision taken:** Payload tables from the git-history version of the appendices are used as the
authoritative field source for all schemas in `schema/`.
**Owner action needed:** Restore or republish `07_normative_appendices.md` in `sdk/docs/` so future
contributors have a canonical on-disk reference.

---

## D-3. `system::resync` payload

**Inferred from task brief:** `{ "last_seq": integer }`
**Normative appendix says:** Empty payload object `{}`.
**Decision taken (updated):** `last_seq` is required. `backend_contract.md` (the runtime-facing spec)
explicitly shows `{ "last_seq": 42 }` and states the server replays messages with `seq > last_seq`.
`schema/system.resync.json` updated to require `last_seq: integer`.
Transcripts `reconnect_resync.json` and `auth_refresh.json` updated to include `last_seq`.
**Owner action needed:** None — closed.

---

## D-4. `system::init` payload

**Inferred from task brief:** Empty `{}`.
**Normative appendix says:** Three required fields: `execution_mode`, `bundle_url`, `checksum`;
three optional sandbox fields: `artifact_id`, `artifact_kind`, `run_mode`.
**Decision taken:** Normative definition used in `schema/system.init.json`.
Outbound envelope additionally requires `meta.client_msg_id`, and successful bootstrap is confirmed
by inbound `system::opened`.
**Verification:** Confirmed against runtime code in `cortex-runtime`:
- `SessionManager` parses `execution_mode`, `bundle_url`, `checksum`, and optional sandbox fields.
- `GraphRuntime` consumes `bundle_url` and `checksum` and enforces checksum match.
 - `SessionManager` uses `meta.client_msg_id` as init idempotency key and emits `system::opened`.
**Owner action needed:** None.

---

## D-5. `system::ping` and `system::pong` payloads

**Inferred from task brief:** Both empty `{}`.
**Normative appendix says:**
- ping requires `heartbeat_id` (client-generated opaque id) and `channel_id`.
- pong requires `heartbeat_id` (echoed), `channel_id`, and `server_ts`.
**Decision taken:** Normative definitions used.
**Owner action needed:** None unless the runtime uses a different ping/pong shape.

---

## D-6. `fatal` field in `system::error` wire payload

**Inferred from task brief:** `system::error` payload should include `fatal: boolean`.
**Normative appendix says:** Wire payload carries only `code`, `message`, and optional `node_key`.
`fatal` is a property of the error catalog, not the wire message.
**Decision taken:** `schema/system.error.json` does not include `fatal`. Bindings derive fatality
by looking up `code` in `errors.json` at runtime.
**Verification attempted:** The runtime that sends `system::error` is a separate service not
present in this repository (`cortex-control-plane` is the Django management plane only).
No wire-construction code found here.
**Owner action needed:** Provide a real `system::error` wire sample or confirm the payload shape
from the Runtime/SessionManager repo. If `fatal` is present in the wire payload, add it as an
optional boolean field to `schema/system.error.json`.

---

## D-7. `chat::message` attachment refs

**Normative appendix:** Does not list attachments (the appendix predates the file attachment feature).
**Runtime contract:** `payload.meta.attachments` is canonical; top-level `payload.attachments` is not
part of the MVP contract.
**Decision taken:** `schema/chat.message.json` accepts attachment refs at `meta.attachments`.
**Owner action needed:** Confirm that the runtime accepts and ignores `meta.attachments: []` when no
attachments are present, and that the runtime processes `meta.attachments` when provided.

---

## D-8. Error catalog scope: 13 vs 17 codes

**`06_errors.md` (current):** 13 error codes covering auth, transport, session, resync, upload.
**Normative appendix (git history):** 17 codes, including four additional codes:
- `stale_wait_token` — wait token no longer valid
- `invalid_wait_token` — wait token malformed
- `delivery_failed` — chat::forward/hail delivery failed
- `recipient_unresolved` — forward recipient not found

**Decision taken:** `errors.json` contains only the 13 codes from `06_errors.md`. The four extra
codes relate to message delivery and escalation features (`chat::forward`, `chat::hail`) that are
not part of the current SDK public surface.
**Owner action needed:** When delivery and escalation features are added (future phase), extend
`errors.json` with the additional codes and update all bindings.

---

## D-9. JSON Schema draft version

**Old schemas (git history):** Used `"$schema": "https://json-schema.org/draft/2020-12/schema"`.
**Phase 0 requirement:** Use `"$schema": "http://json-schema.org/draft-07/schema#"`.
**Decision taken:** All Phase 0 schemas use draft-07.
**Owner action needed:** None. Draft-07 is more broadly supported across JS and Python validator
libraries. Upgrade to draft 2020-12 in a future phase if strict vocabulary features are needed.

---

## D-10. Transcript direction vocabulary

**Old transcripts (git history):** Used `"direction": "outbound"` / `"direction": "inbound"`.
**Phase 0 requirement:** Use `"direction": "client"` / `"direction": "server"`.
**Decision taken:** New vocabulary used in all Phase 0 transcripts.
**Owner action needed:** Update any tooling that reads old transcripts if it is ever reintroduced.

---

## D-11. `chat::answer` payload shape vs current Runtime

**Found (SDK #2, 2026-10-15):** `cortex-runtime` `ChatAnswerPayload.to_dict()` emits `content` as
`list[str]`, an integer `turn` (legacy `turn_id` is dropped on parse), an optional `meta` object
(e.g. `meta.billing.summary`), and `role: "operator"` on the operator-close path.
`schema/chat.answer.json` still requires a string `content`, a string `turn_id` and `role: "assistant"`.
**Decision taken:** SDK #2 only adds `meta` (open object, strict `meta.attachments` descriptors) so a
final answer can carry generated files. The SDK binds generated files to an answer by `payload.turn_id`,
or by `String(payload.turn)` when only `turn` is present (`message_ref_kind = "turn"`).
**Owner action needed:** Decide whether `chat.answer.json` follows the Runtime shape (`content: string[]`,
`turn: integer`, operator role). Runtime #24 must set each published file's `message_ref` to the turn
identity the user-visible answer carries; any other value makes the SDK exclude those files.

---

## D-12. `fi_` value-prefix check on file control responses

**Found (SDK #2):** `assertSafePublicControl` / `assert_safe_public_control` reject any string value that
starts with `fi_` anywhere in a `file::*` control response (`session_file_ws_v1.json`
`forbidden_public_value_prefixes`). A user file legitimately named e.g. `fi_budget.csv` would make
`listFiles()` / `downloadFile()` fail with `invalid_file_transfer`.
**Decision taken:** Unchanged (frozen session-file-ws-v1 contract). Message attachment projection only applies
the internal-prefix ban to identity fields (`file_ref`, `message_ref`), never to `filename`.
**Owner action needed:** Decide whether the v1 control check should exempt `filename`.
