---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Bundle automatic JSON Schema validator defaults in `@modelcontextprotocol/client` and `@modelcontextprotocol/server` runtime shims.

Client and server pick the right validator automatically based on the runtime: the Node shim uses AJV, the browser/workerd shim uses `@cfworker/json-schema`. Both backends are bundled into the shim chunks that select them, so the default code path needs no extra installs — `import { McpServer } from '@modelcontextprotocol/server'` does not pull `ajv` or `@cfworker/json-schema` into the root entry chunk.

The named validator classes remain part of the public surface for consumers who want to customize the built-in backend (pre-register schemas by `$id`, register custom AJV formats, switch dialects, change `@cfworker/json-schema` draft). They are exposed through explicit subpaths so they do not bloat the root index chunk:

- `import { AjvJsonSchemaValidator } from '@modelcontextprotocol/{client,server}/validators/ajv'`
- `import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/{client,server}/validators/cf-worker'`

Importing from one of these subpaths means the corresponding peer dep (`ajv` + `ajv-formats`, or `@cfworker/json-schema`) must be in your `package.json`. The shim keeps its own vendored copy for the default path, so a project can use the subpath in some files and rely on the default in others.

The `jsonSchemaValidator` interface remains the public extension point for replacing validation entirely with a custom implementation.
