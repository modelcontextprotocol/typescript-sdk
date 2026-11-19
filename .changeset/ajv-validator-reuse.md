---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

`AjvJsonSchemaValidator.getValidator()` no longer recompiles a schema it has already compiled. Ajv retains every compiled validator for the lifetime of its engine, so a long-running client that periodically refreshed its tool catalogue grew its heap without bound; tool schemas typically carry no `$id`, which meant Ajv's own cache never hit. Validators are now reused per engine, keyed by the serialised schema.