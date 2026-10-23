---
'@modelcontextprotocol/sdk': patch
---

Silence Ajv's "unknown format ... ignored" warnings in the default `AjvJsonSchemaValidator` logger so vendor-specific `format` annotations (e.g. `google-duration`) no longer flood the console on every `listTools` call. Validation semantics are unchanged.
