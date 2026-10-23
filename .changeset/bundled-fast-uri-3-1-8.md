---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

The bundled Ajv validator is now built with fast-uri 3.1.8 (was 3.1.0). fast-uri 3.1.6 and later reject a `$id` or `$ref` whose text before the first colon is not a valid URI scheme, for example `my_tool:output` or `urn:my_tool:output`: a schema that uses one no longer compiles, and a tool that carries it fails with an invalid-schema error. An underscore without a colon (`my_tool_output`) and a `$ref` into `#/$defs/...` or `#/definitions/...` are not affected.
