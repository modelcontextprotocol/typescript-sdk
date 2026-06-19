---
'@modelcontextprotocol/server': patch
---

Bound the protocol-version checks gating SSE resumability behavior (priming events and `closeSSEStream` callbacks) in the Streamable HTTP server transport. Previously an open-ended `>= '2025-11-25'` comparison let unknown future protocol version strings from an `initialize`
request body enable this behavior; the version must now also be one of the transport's supported protocol versions. Behavior for all currently supported protocol versions is unchanged.
