---
'@modelcontextprotocol/core': patch
---

Accept null arguments in tools/call requests and return -32602 (InvalidParams) instead of -32603 (InternalError) for request validation failures. Clients that serialize missing fields as null (common in Go, Java, C# JSON libraries) no longer get an opaque internal error when calling tools.
