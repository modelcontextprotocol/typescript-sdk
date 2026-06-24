---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
---

`AjvJsonSchemaValidator`, `CfWorkerJsonSchemaValidator` and `CfWorkerSchemaDraft` types are now only exported from the `/validators/ajv` and `/validators/cf-worker` subpaths, not the package root. The codemod already routes v1 imports there.
