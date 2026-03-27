---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/server': patch
---

Treat schema-invalid stdio JSON-RPC payloads as invalid requests, exposing the dedicated core error type and letting stdio servers reply with a JSON-RPC `Invalid Request` error before continuing.
