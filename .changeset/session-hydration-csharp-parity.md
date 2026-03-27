---
'@modelcontextprotocol/server': minor
---

Add multi-node session hydration support, aligned with the C# SDK pattern:

- `WebStandardStreamableHTTPServerTransport` now accepts a `sessionId` constructor option. When set, the transport validates incoming `mcp-session-id` headers against that value and rejects re-initialization, without requiring a fresh initialize handshake on this node.
- `Server.restoreInitializeState(params)` restores negotiated client capabilities and version from persisted `InitializeRequest` params, so capability-gated server-initiated features (sampling, elicitation, roots) work on hydrated instances.

Internal refactor: the private `_initialized` flag is removed. Its checks are replaced by equivalent `sessionId === undefined` checks, so observable behavior (error codes and messages) is unchanged.
