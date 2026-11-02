---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Suppress unknown-format warnings in the default Ajv validators for every supported schema dialect. Vendor-specific formats remain ignored, known formats remain validated, and other diagnostics and caller-supplied Ajv instances are unchanged.
