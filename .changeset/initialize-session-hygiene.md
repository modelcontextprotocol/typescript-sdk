---
'@modelcontextprotocol/client': patch
---

The Streamable HTTP client transport no longer attaches a session ID to a POST containing an `initialize` request — a new session starts "without a session ID attached" (2025-11-25 transports §Session Management) — and it only captures the `mcp-session-id` response header from a successful initialize response, since the spec assigns the session ID "at initialization time … on the HTTP response containing the InitializeResult". Previously the transport stored the header from any response, so a legacy server answering a protocol-version probe with an error that happened to carry a session ID would poison the fallback initialize, which then went out with a session ID it should not have had. A stale session ID from a previous connection is likewise no longer leaked onto the initialize handshake.
