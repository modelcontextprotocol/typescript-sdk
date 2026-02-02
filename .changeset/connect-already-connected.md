---
"@modelcontextprotocol/core": patch
---

fix: throw error when connecting to already-connected Protocol

Protocol.connect() now throws a descriptive error if called when already
connected to a transport. This prevents silent overwrites that break
concurrent HTTP sessions.

Fixes #1405
