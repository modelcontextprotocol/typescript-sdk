---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

The bundled Ajv validator is now built with fast-uri 3.1.9 (was 3.1.8). A schema no longer compiles when a `$id` or `$ref` has a percent-encoded character before its first colon (`%61:b`), or `{` or `}` in the host of an `http`, `https`, `ws` or `wss` URL (`http://{host}/a`). Relative values keep their leading `..` segments: a `$ref` to a `$id` such as `../a` now resolves, and a `$ref` of only dot segments (`.`, `../`) no longer resolves to the root schema. Plain names, `#/$defs/...` references, other URLs and URNs are not affected.
