# S20 native SDK Human Assistance responder wire

Source contract: Common `HA_POST_WAIT_S19.md` at `998912cb4046d74c3bea086224092f5068d24296`. This is SDK source contract v1 on the existing authenticated WebSocket envelope (`schema: "1.0"`). It is not yet accepted by production SessionManager. The active packages are `js/` (`@cortex-suite/sdk`) and `python/` (`cortex-suite-sdk`); `sdk-ui` is a separate repository.

## Wire

| Direction/type | Exact payload |
| --- | --- |
| SM → SDK `human_assistance::request` | `{version:1,request_id,question,options:[{id,label}],allow_text,deadline_at,status:"pending"}`. `deadline_at` is an RFC 3339 timestamp. Options may be empty only when free text is allowed. A server-authored display label can be added in a reviewed later revision; it cannot grant authority. |
| SM → SDK `human_assistance::status` | `{version:1,request_id,status,client_reply_id?,reason?}`. Status: `reply_accepted`, `reply_rejected`, `resolved`, `expired`, `revoked`; `client_reply_id` is required for reply statuses. `reply_rejected` requires reason `unauthorized|duplicate|invalid_answer|late`. A reply status is a server acknowledgement or denial, not proof that Runtime has continued. `resolved` is the terminal request result. |
| SDK → SM `human_assistance::reply` | `{version:1,request_id,client_reply_id,action:"answer"|"refuse",option_id?,text?}`. `answer` requires a configured option and/or nonblank text. `refuse` has neither. The caller supplies and reuses `client_reply_id` for one submission across transport retries. The same ID cannot be used with different content. |

All IDs are bounded opaque strings (1–128 characters, ASCII letters, digits, `_ . : -`). `question` and `text` are at most 4,096 characters; option IDs at most 128 characters, labels at most 256; no more than 32 options. Each notification uses the current authenticated WS binding; its envelope `session_id`, if present, must equal the current SDK session A. No payload accepts origin session, tenant, Release, provider root, participant authority or Runtime `wait_token`. The SDK may reject an unknown, expired, revoked or resolved request locally; SM/Runtime remain authoritative for eligibility, deadline, dedupe and final outcome.

The SDK emits HA notifications only through dedicated `onHumanAssistance` / `on_human_assistance` subscriptions and snapshots. It does not forward them to chat `onMessage` / `on_message`, change the current session, or write transcript state. Replayed identical requests collapse by `request_id`; conflicting same-ID content is dropped. A status update is delivered once per distinct state/`client_reply_id`. A terminal status received before its request suppresses that request locally. The terminal tombstone cache holds up to 64 IDs; on overflow the inbox rejects new unknown requests until the client is explicitly disconnected. Cache lifetime is the client instance; SM must replay active requests and terminal updates after reconnect/resync. The SDK does not create a second socket or recipient DW session.

## Ownership and server gates

Runtime creates `request_id` after durable origin WAIT registration. Edge/SM delivers request/status to the authenticated recipient binding, validates `request_id` against the origin interaction and Release participant policy, deduplicates `client_reply_id`, and returns explicit accepted/rejected/expired/revoked status. SDK reply envelope session A is only the recipient's live transport context, never the origin address. Edge must accept/routinely resync these new types explicitly; current `cortex-edge-node` source has no HA type in `_SDK_FORWARD_ALLOWED` or `_GR_TO_SDK_ALLOWED`. Mock WS tests demonstrate the client source contract only. No physical HA E2E or Runtime continuation is claimed here.
