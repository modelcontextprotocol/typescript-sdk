---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/core-internal': patch
---

Return HTTP 400 for a `MissingRequiredClientCapabilityError` (`-32021`) produced after dispatch. The spec mandates `400 Bad Request` for this error with no condition on where it arose, but only the pre-dispatch capability gate honored that; the post-handler emission — the `input_required` gate rejecting an embedded request whose required capability the caller did not declare — surfaced in-band on HTTP 200. The JSON-RPC error body is unchanged, every other error code (including a handler relaying a downstream peer's `-32020`/`-32022`) keeps the origin-keyed in-band behavior, and the mapping only applies while the response is uncommitted: an exchange that already streamed — or one hosted with `responseMode: 'sse'`, which opens its stream at dispatch end — keeps its committed 200 and carries the error in-stream.
