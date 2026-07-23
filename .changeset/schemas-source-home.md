---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/server-legacy': minor
---

Move the schema source modules (spec schemas, OAuth schemas, protocol constants) into `@modelcontextprotocol/core` and resolve them from there as a regular runtime dependency instead of bundling a private copy into each package. An application importing more than one of the packages now evaluates a single shared schema graph with shared object identity. `@modelcontextprotocol/core` gains a `./internal` subpath (SDK-internal contract; may change in any release) and the four packages now version together.
