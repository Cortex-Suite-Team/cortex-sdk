# Cortex SDK 1.1.22

Release candidate for both `@cortex-suite/sdk` and `cortex-suite-sdk`.

- Native Human Assistance request/status subscriptions, inbox snapshots, correlated replies,
  cancellation, and terminal delivery outcomes.
- Canonical `content: string[]` chat payloads across Python, Node.js, and browser bindings.
- Multiple inbound attachments and generated-file descriptors with strict public `sf_` identities,
  CFT1 upload/download, and disconnect/reconnect transfer invariants.
- Installed-package smoke checks cover the HA responder and SessionFiles APIs in every binding.

The accepted transport baseline is source commit
`3a790ad7b751c30b26c5a154592353a19d69b7af`, including its checked-in
`shared/schema`, `shared/transcripts`, and `contracts` vectors. This is local package
qualification against that contract, not a deployed Runtime end-to-end qualification.

Publish Python and JavaScript together from one frozen release SHA and tag `v1.1.22`.
Then release SDK UI, then Chat Widget with exact published dependency versions.
No release tag, workflow dispatch, or registry publication is authorized by this source change.
GitHub Release cleanup follows successful replacement publication and consumer verification;
retain the current `v1.1.21` release until then. Registry version deletion is a separate decision.
