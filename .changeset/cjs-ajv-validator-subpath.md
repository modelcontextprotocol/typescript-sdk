---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
---

Fix the CommonJS `validators/ajv` subpath so reading the exported `Ajv` class no longer throws `ReferenceError: import_ajv is not defined`. The subpath now re-exports the bundled provider's concrete `Ajv` value in CJS output, matching the existing ESM behavior.
