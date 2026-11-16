---
'@modelcontextprotocol/core-internal': patch
---

Classify an inbound JSON-RPC message by its envelope keys before validating, so a request runs one schema walk instead of three and a notification one instead of four. The transport has already parsed the message, so re-running the response schemas on every request only added zod work. Messages whose keys do not settle the kind still fall through to the previous guard chain.
