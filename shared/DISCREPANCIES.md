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
`list[str]`, an optional integer `turn` (legacy `turn_id` is dropped on parse), an optional `meta` object
(e.g. `meta.billing.summary`), and `role: "operator"` on the operator-close path (no `turn`).
**Decision taken (owner review 2026-10-15, resolved):** `schema/chat.answer.json` follows that serialization
strictly: `content: string[]`, `role` in `assistant|operator`, `answer_kind: final`, optional integer `turn`,
no `turn_id`, at most 8 `meta.attachments`, each bound with `message_ref = String(turn)` and
`message_ref_kind = "turn"`. Mock servers in both bindings reject any other answer shape they are asked to send.
Runtime #24 must publish generated files with exactly that `message_ref`.
**Owner action needed:** None.

---

## D-12. `fi_` value-prefix check on file control responses

**Found (SDK #2):** `assertSafePublicControl` / `assert_safe_public_control` rejected any string value starting
with `fi_` anywhere in a `file::*` control reply, so a user file named `fi_budget.csv` broke `listFiles()`.
**Decision taken (owner review 2026-10-15, resolved):** Forbidden keys (`file_id`, `snapshot_id`, storage,
ticket, `url`/`download_url`/`upload_url`/`download_mint_url`/`upload_path`, ...) are still rejected anywhere.
The `fi_`/`sn_` value prefixes are rejected only in identity/credential fields (key matching
`(?:^|_)(?:id|ref|token|secret)$`, e.g. `file_ref`, `transfer_id`, `message_ref`). Shared vectors:
`contracts/session_file_ws_v1.json` `control_safety_vectors`.
**Owner action needed:** None.

---

## D-13. `chat::partial` / `chat::echo` turn identity vs current Runtime

**Found (SDK #2 follow-up):** Runtime `ChatPartialPayload` and `ChatEchoPayload` also serialize an integer `turn`,
`list[str]` content and drop `turn_id`, while `schema/chat.partial.json` still requires a string `turn_id`
and string `content`.
**Decision taken (owner GO 2026-10-15, resolved):** both schemas follow the Runtime serialization strictly.
`chat.partial.json`: `content: string[]`, `role: assistant`, optional non-negative integer `turn`, no `turn_id`,
no `meta` (a partial owns no files). `chat.echo.json`: `content: string[]` (no legacy `message`), `role` in
`user|operator`, optional non-negative integer `turn`, no `turn_id`, `meta` passes through; `meta.attachments`
stays user/inbound bound to `meta.client_msg_id`, and an operator echo (escalation reply) carries and owns no
files. Partials correlate with their final `chat::answer` by the integer `turn`. Shared vectors:
`contracts/session_file_attachments_v1.json` `runtime_partial_schema_cases` / `runtime_echo_schema_cases`;
mock servers in both bindings reject any other answer, partial or echo shape they are asked to send.
**Owner action needed:** None.
