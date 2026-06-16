---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Add `MissingRequiredClientCapabilityError`, the typed error class for the 2026-07-28 `-32003` protocol error (processing a request requires a capability the client did not declare). Its `data.requiredCapabilities` lists the missing capabilities and `ProtocolError.fromError` recognizes the code/data shape. The 2026-07-28 HTTP entry refuses requests that require an undeclared client capability with this error and HTTP status `400` before dispatch.
