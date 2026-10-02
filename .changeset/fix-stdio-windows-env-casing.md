---
'@modelcontextprotocol/sdk': patch
---

On Windows, an explicit `env` entry passed to `StdioClientTransport` now replaces the inherited default with the same name in any casing, so `Path` no longer loses to the inherited `PATH`.
