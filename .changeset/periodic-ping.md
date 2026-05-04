---
"@modelcontextprotocol/core": minor
"@modelcontextprotocol/client": minor
"@modelcontextprotocol/server": minor
---

feat: add opt-in periodic ping for connection health monitoring

Adds a `pingIntervalMs` option to `ProtocolOptions` that enables automatic
periodic pings to verify the remote side is still responsive. Per the MCP
specification, implementations SHOULD periodically issue pings to detect
connection health, with configurable frequency.

The feature is disabled by default. When enabled, pings begin after
initialization completes and stop automatically when the connection closes.
Failures are reported via the `onerror` callback without stopping the timer.
