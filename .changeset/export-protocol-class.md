---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/codemod': patch
---

Export the `Protocol` base class and `mergeCapabilities` from the `@modelcontextprotocol/client` and `@modelcontextprotocol/server` package roots.

Some SDK consumers build their own JSON-RPC protocols on the `Protocol` engine rather than speaking MCP itself — ext-apps (MCP Apps) runs its `ui/initialize` handshake over an iframe postMessage channel this way. Subclassing `Client`/`Server` forces the core MCP `initialize` handshake onto such channels, which their deployed peers do not understand. Exporting `Protocol` restores the v1 extension point: `Protocol.connect()` wires the transport without any handshake, and non-spec methods pass through the wire layer without era gating.

The supporting protocol types (`ProtocolOptions`, `BaseContext`, `RequestOptions`, `Transport`, …) were already public.

The codemod now rewrites `Protocol` and `mergeCapabilities` imports from `shared/protocol.js` to the client or server package root, like the module's other symbols, instead of dropping them with an action-required marker.
