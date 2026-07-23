---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Construct the default Ajv validation engine lazily on first validation. Creating a `Client` or `Server` no longer pays the ajv + ajv-formats instantiation cost at startup when no JSON Schema validation ever runs.
