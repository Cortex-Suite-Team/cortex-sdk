# Cortex SDK 1.1.21

This patch release completes the session-file WebSocket transport for the JavaScript and Python SDKs.

- Upload, download, and list session files over CFT1 binary WebSocket frames.
- Keep the public attachment identity strictly `sf_`; internal File Layer identities remain private.
- Correlate concurrent file operations by `meta.client_msg_id` and `payload.transfer_id`.
- Abort connection-ephemeral transfers on disconnect instead of resuming or replaying binary frames.
- Reconnect and resync the Python SDK after a locally initiated stale-socket close.

The proposed release tag is `v1.1.21`. npm and PyPI publication require that tag on the exact release commit.
