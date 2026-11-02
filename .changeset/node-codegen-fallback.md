---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
---

On Node with code generation from strings disallowed (`--disallow-code-generation-from-strings`), the default JSON Schema validator is now the cf-worker validator. Ajv, the default otherwise, threw an `EvalError` on the first schema, so `fromJsonSchema` and the server and client constructors failed on such hosts.
