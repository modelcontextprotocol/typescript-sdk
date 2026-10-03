---
'@modelcontextprotocol/client': patch
---

Honour an explicit `Path` (or any non-`PATH` casing) passed in `StdioServerParameters.env` on Windows. Windows environment variables are case-insensitive but an object spread is not, so the inherited `PATH` and the caller's `Path` both survived the merge; Node's `child_process` then resolved the duplicate in favour of the inherited value and the configured one never reached the server process.
