---
status: scaffold
shape: how-to
---
# Schema libraries

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Valibot/ArkType, JSON-Schema-in, pluggable validators.
teaches: registerTool (Standard Schema overload), StandardSchemaWithJSON, @valibot/to-json-schema, fromJsonSchema, jsonSchemaValidator option, AjvJsonSchemaValidator, CfWorkerJsonSchemaValidator
source: mined from docs/migration/upgrade-to-v2.md "Standard Schema objects (raw shapes deprecated)" and "Automatic JSON Schema validator selection by runtime"; examples/schema-validators/
-->

## Register a tool with an ArkType schema
<!-- teaches: registerTool accepts any Standard-Schema-with-JSON value, not only Zod | salvage: docs/migration/upgrade-to-v2.md "Standard Schema objects (raw shapes deprecated)"; examples/schema-validators/server.ts -->
`inputSchema` takes any **Standard Schema** that can produce JSON Schema — ArkType works as-is.

```ts
// draft - API verified against packages/server/src/server/mcp.ts (registerTool StandardSchemaWithJSON overload)
import { McpServer } from '@modelcontextprotocol/server';
import { type } from 'arktype';

const server = new McpServer({ name: 'greeter', version: '1.0.0' });

server.registerTool(
  'greet',
  { description: 'Greet someone', inputSchema: type({ name: 'string' }) },
  async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] })
);
```
<!-- result: same payoff as Zod — derived JSON Schema, pre-handler validation, inferred handler argument types -->

## Register a tool with a Valibot schema
<!-- teaches: Valibot needs the @valibot/to-json-schema wrapper to expose JSON Schema conversion | salvage: examples/schema-validators/server.ts -->
<!-- code: inputSchema: toStandardJsonSchema(v.object({ name: v.string() })) -->

## Start from JSON Schema you already have
<!-- teaches: fromJsonSchema(schema) wraps a plain JSON Schema document into a Standard Schema you can pass to inputSchema/outputSchema | salvage: docs/migration/upgrade-to-v2.md "Standard Schema objects (raw shapes deprecated)" -->
<!-- code: inputSchema: fromJsonSchema({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }) -->

## Validate structured output with any library
<!-- teaches: outputSchema works with the same Standard Schema rule; structuredContent is validated against it | salvage: examples/schema-validators/server.ts "get-weather" -->
<!-- code: outputSchema with the chosen library; handler returns { content, structuredContent } -->

## Swap the JSON Schema validator
<!-- teaches: jsonSchemaValidator option on ServerOptions; @modelcontextprotocol/server/validators/ajv subpath (Ajv, addFormats, AjvJsonSchemaValidator) | salvage: docs/migration/upgrade-to-v2.md "Automatic JSON Schema validator selection by runtime" -->
<!-- code: new McpServer(info, { jsonSchemaValidator: new AjvJsonSchemaValidator(customAjv) }) -->

## Pick the validator for your runtime
<!-- teaches: the default is runtime-selected (AJV on Node.js, @cfworker/json-schema on browser/workerd); /validators/cf-worker subpath to force it -->
<!-- code: import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker' -->

## Recap
<!-- the claims this page will prove:
* inputSchema and outputSchema accept any Standard Schema that exposes JSON Schema — Zod, ArkType, Valibot (via @valibot/to-json-schema).
* The raw-shape ZodRawShape overload is deprecated; pass a schema object.
* fromJsonSchema turns an existing JSON Schema document into something you can register.
* The JSON Schema validator is pluggable: pass jsonSchemaValidator, or import a provider from a validators/ subpath.
* The default validator is chosen by runtime; you only override it to pin or configure one.
-->
