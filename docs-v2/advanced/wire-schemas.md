---
status: scaffold
shape: how-to
---
# Wire schemas

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: @modelcontextprotocol/core for gateways/proxies (raw wire schemas).
teaches: @modelcontextprotocol/core, CallToolResultSchema (and the ~160 spec *Schema constants), JSONRPCMessageSchema, the OAuth/OpenID schema group, where the TypeScript types live instead
source: mined from docs/migration/upgrade-to-v2.md "Zod *Schema constants moved to @modelcontextprotocol/core"; packages/core/src/index.ts header
-->

## Validate a wire payload
<!-- teaches: @modelcontextprotocol/core exports the exact Zod schemas the SDK validates with; *.safeParse on untrusted JSON | salvage: docs/migration/upgrade-to-v2.md "Zod *Schema constants moved to @modelcontextprotocol/core" -->
A gateway holds raw JSON, not SDK objects. `@modelcontextprotocol/core` ships the spec's Zod schemas so you can validate it directly.

```ts
// draft - API verified against packages/core/src/index.ts (CallToolResultSchema re-export)
import { CallToolResultSchema } from '@modelcontextprotocol/core';

const parsed = CallToolResultSchema.safeParse(payload);
if (!parsed.success) {
  throw new Error(`upstream returned an invalid tools/call result: ${parsed.error.message}`);
}
```
<!-- result: parsed.data is the typed result; a malformed upstream response is rejected at the boundary -->

## Decide whether you need this package at all
<!-- teaches: the audience split — Client/Server users never import core; gateways, proxies and test harnesses that touch raw JSON-RPC do -->
<!-- code: none — two-sentence router; links back to servers/ and clients/ for the SDK-object path -->

## Pick the schema for the message you hold
<!-- teaches: naming convention <SpecType>Schema; the request/result/notification/params families; JSONRPCMessageSchema for the undecoded envelope -->
<!-- code: JSONRPCMessageSchema.parse(line) on an incoming frame -->

## Route raw JSON-RPC in a proxy
<!-- teaches: parse the envelope once, branch on method, validate params with the per-method schema — no Client or Server in the path -->
<!-- code: switch on message.method, then CallToolRequestSchema.safeParse(message) before forwarding -->

## Validate OAuth and discovery metadata
<!-- teaches: the second export group — OAuth/OpenID *Schema constants for token responses, protected-resource metadata, authorization-server metadata -->
<!-- code: OAuthMetadataSchema.safeParse(await response.json()) -->

## Get the TypeScript types, guards and errors from the SDK packages
<!-- teaches: core is Zod values ONLY; the spec types, isJSONRPCRequest-style guards and error classes ship from @modelcontextprotocol/server and /client (and z.infer works on any core schema) -->
<!-- code: import type { CallToolResult } from '@modelcontextprotocol/client' next to the core schema import -->

## Recap
<!-- the claims this page will prove:
* @modelcontextprotocol/core re-exports the SDK's own spec + OAuth Zod schemas and nothing else.
* Its audience is code that holds raw JSON — gateways, proxies, test harnesses — not normal Client/Server users.
* Every spec type has a <Name>Schema constant; JSONRPCMessageSchema validates the undecoded envelope.
* Types, guards and error classes are not in core — import them from @modelcontextprotocol/server or /client.
* The package is runtime-neutral; zod is its only dependency.
-->
