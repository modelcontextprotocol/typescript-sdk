---
'@modelcontextprotocol/core-internal': patch
---

Fix a client-side race where `notifications/progress` emitted immediately before a response could surface as a spurious "unknown progress token" `onerror`: notification handlers now dispatch synchronously in arrival order (matching responses), and progress for a request that has already settled is dropped silently — never-issued tokens still error. A new `ProtocolOptions.onLateProgress` hook lets callers observe the dropped late notifications. Also: aborts (pre-dispatch and in-flight) now carry the original `signal.reason` at `SdkError.data.reason` in addition to the stringified message, so callers can recover the abort reason structurally.
