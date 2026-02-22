---
'@modelcontextprotocol/client': patch
---

Wait for in-flight requests to complete before aborting on close(), preventing Undici/OpenTelemetry from marking successful responses as aborted.
