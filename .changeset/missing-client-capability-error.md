---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Add `MissingRequiredClientCapabilityError`, the typed error class for the 2026-07-28 `-32021` protocol error (processing a request requires a capability the client did not declare). Its `data.requiredCapabilities` lists the missing capabilities and `ProtocolError.fromError` recognizes the code/data shape. The 2026-07-28 HTTP entry gains a pre-dispatch gate that refuses a request requiring an undeclared client capability with this error and HTTP status `400`; no method served on the 2026-07-28 registry currently carries such a requirement, so observable behavior is unchanged until methods with capability requirements exist.
