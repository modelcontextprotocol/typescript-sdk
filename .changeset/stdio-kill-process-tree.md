---
'@modelcontextprotocol/client': minor
---

Add an opt-in `killProcessTree` option to `StdioClientTransport`. When enabled, `close()` tears down the entire process tree — the child is spawned as its own process-group leader on POSIX (signalled via the process group) and torn down with `taskkill /T /F` on Windows — preventing orphaned server processes when the server is launched through a wrapper such as `npx`, `uvx`, or `python -m`. Defaults to `false`, preserving existing signal-propagation behaviour. Fixes #2023.
