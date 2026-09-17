---
shape: how-to
---

# Wire schemas

`@modelcontextprotocol/core` exports the **wire schemas** — the exact Zod constants the SDK validates protocol and OAuth payloads against — for code that holds raw JSON instead of SDK objects.

## Validate a wire payload

`CallToolResultSchema.safeParse` validates an upstream body before you relay it.

```ts source="../../examples/guides/advanced/wire-schemas.examples.ts#wireSchemas_validateResult"
import { CallToolResultSchema } from '@modelcontextprotocol/core';

// The body an upstream server returned for a tools/call you forwarded.
const body: unknown = JSON.parse('{"content":[{"type":"text","text":"Travel mug"}]}');

const parsed = CallToolResultSchema.safeParse(body);
if (!parsed.success) {
    throw new Error(`upstream returned an invalid tools/call result: ${parsed.error.message}`);
}
console.log(parsed.data.content);
```

`parsed.data` is the typed result:

```
[ { type: 'text', text: 'Travel mug' } ]
```

Hand the same schema a malformed body and `safeParse` returns the failure instead of throwing.

```ts source="../../examples/guides/advanced/wire-schemas.examples.ts#wireSchemas_validateResult_invalid"
const malformed = CallToolResultSchema.safeParse({ content: 'Travel mug' });
console.log(malformed.error?.issues);
```

The error names the field that broke the contract:

```
[
  {
    expected: 'array',
    code: 'invalid_type',
    path: [ 'content' ],
    message: 'Invalid input: expected array, received string'
  }
]
```

::: info Coming from v1?
These are the `*Schema` constants v1 exported from `@modelcontextprotocol/sdk/types.js`. The codemod rewrites the import path — see the [upgrade guide](../migration/upgrade-to-v2.md).
:::

## Decide whether you need this package at all

If you build with `McpServer` or `Client`, skip this package: [tools](../servers/tools.md) arrive in your handler already validated, and [tool calls](../clients/calling.md) come back as typed results. Reach for `@modelcontextprotocol/core` when nothing stands between you and the JSON — gateways, proxies, test harnesses, [worker fleets](./gateway.md).

`@modelcontextprotocol/server` and `@modelcontextprotocol/client` keep a Zod-free public surface, but they resolve their shared schema graph from this package at runtime, so it already arrives transitively in your tree. Add it to your own `dependencies` (`npm install @modelcontextprotocol/core`) when you import from it directly. The package is runtime-neutral; `zod` is its only dependency.

## Pick the schema for the message you hold

Every named type in the spec has a matching constant, `<SpecType>Schema`. When you do not yet know which one you hold, `JSONRPCMessageSchema` validates the undecoded envelope.

```ts source="../../examples/guides/advanced/wire-schemas.examples.ts#wireSchemas_envelope"
import { JSONRPCMessageSchema } from '@modelcontextprotocol/core';

const frame = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"query":"mug"}}}';
const message = JSONRPCMessageSchema.parse(JSON.parse(frame));
```

`message` narrows to one of the four JSON-RPC shapes — request, notification, result response, error response — and an invalid frame throws a `ZodError`.

The constants come in the same families as the spec: requests (`CallToolRequestSchema`), results (`ListToolsResultSchema`), notifications (`ProgressNotificationSchema`), and `*ParamsSchema` for when you hold only the `params` object (`CallToolRequestParamsSchema`).

## Route raw JSON-RPC in a proxy

Parse the envelope once, branch on `method`, then validate with the per-method request schema before forwarding.

```ts source="../../examples/guides/advanced/wire-schemas.examples.ts#wireSchemas_route"
import { CallToolRequestSchema } from '@modelcontextprotocol/core';

if ('method' in message) {
    switch (message.method) {
        case 'tools/call': {
            const call = CallToolRequestSchema.parse(message);
            console.log(`forward tools/call for ${call.params.name} upstream`);
            break;
        }
        default:
            console.log(`forward ${message.method} unchanged`);
    }
}
```

`call.params.name` is a typed `string`, with no `Client` or `Server` anywhere in the path:

```
forward tools/call for search upstream
```

For everything beyond validation — sessions, capability negotiation, request correlation — build on the SDK instead: see the [low-level server](./low-level-server.md).

## Validate OAuth and discovery metadata

The second export group covers OAuth and OpenID discovery. `OAuthMetadataSchema` validates an authorization server's metadata document.

```ts source="../../examples/guides/advanced/wire-schemas.examples.ts#wireSchemas_oauthMetadata"
import { OAuthMetadataSchema } from '@modelcontextprotocol/core';

// In production this body comes from GET <issuer>/.well-known/oauth-authorization-server.
const response = new Response(
    JSON.stringify({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        response_types_supported: ['code']
    })
);

const metadata = OAuthMetadataSchema.parse(await response.json());
console.log(metadata.token_endpoint);
```

A document missing a required endpoint fails the parse; a valid one comes back typed:

```
https://auth.example.com/token
```

The group follows the same naming convention: `OAuthTokensSchema` for token responses, `OAuthProtectedResourceMetadataSchema` for protected-resource metadata, `OpenIdProviderDiscoveryMetadataSchema` for OpenID provider discovery.

## Get the TypeScript types, guards and errors from the SDK packages

`@modelcontextprotocol/core` exports Zod values and nothing else. The spec types, the `isJSONRPCRequest`-style guards, and the error classes are public API of `@modelcontextprotocol/server` and `@modelcontextprotocol/client` — import them from whichever package you already depend on.

```ts source="../../examples/guides/advanced/wire-schemas.examples.ts#wireSchemas_types"
import type { CallToolResult } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';

// The SDK's spec type and the schema's own inferred output describe the same value.
const relayed: CallToolResult = parsed.data;
type CallToolResultFromCore = z.infer<typeof CallToolResultSchema>;
```

The assignment typechecks: what a core schema parses is what the SDK packages type. A package that depends only on core derives the same types with `z.infer`.

::: tip
To check a value's shape without taking a Zod dependency at all, use the `isSpecType` guards exported from `@modelcontextprotocol/client` and `@modelcontextprotocol/server`: `isSpecType.CallToolResult(value)`.
:::

## Recap

- `@modelcontextprotocol/core` exports the SDK's own spec and OAuth/OpenID Zod schemas, and nothing else.
- Its audience is code that holds raw JSON — gateways, proxies, test harnesses — not `Client` or `Server` users.
- Every spec type has a `<Name>Schema` constant; `JSONRPCMessageSchema` validates the undecoded envelope.
- Types, guards and error classes are not in core — import them from `@modelcontextprotocol/server` or `@modelcontextprotocol/client`.
- The package is runtime-neutral; `zod` is its only dependency.
