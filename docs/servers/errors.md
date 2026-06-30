---
status: scaffold
shape: how-to
---
# Errors

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: isError vs McpError vs thrown; protocol error-code table at the bottom (allowed carve-out).
NOTE for the prose tranche: the v2 export is `ProtocolError` (+ `ProtocolErrorCode`), not v1's `McpError` — teach the real symbol, mention the rename once for v1 readers.
teaches: CallToolResult.isError, ProtocolError, ProtocolErrorCode, ResourceNotFoundError
source: mined from docs/server.md "Error handling" + docs/client.md "Error handling"
-->

## Return a tool error with `isError`
<!-- teaches: isError: true is a tool-level error the model SEES and can self-correct on | salvage: docs/server.md "Error handling" (registerTool_errorHandling) -->

```ts
// draft - API verified against packages/server/src/server/mcp.ts (registerTool, line 972) and CallToolResult.isError
server.registerTool(
  'fetch-data',
  {
    description: 'Fetch data from a URL',
    inputSchema: z.object({ url: z.string() }),
  },
  async ({ url }) => {
    const res = await fetch(url);
    if (!res.ok) {
      return {
        content: [{ type: 'text', text: `HTTP ${res.status}: ${res.statusText}` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: await res.text() }] };
  }
);
```
<!-- result: the tools/call response is a normal result with isError: true; the model reads the message and retries. -->

## Let a thrown exception become a tool error
<!-- teaches: the SDK catches handler throws and converts them to { isError: true }; explicit isError only buys you the message; output-schema validation is skipped on errors | salvage: docs/server.md "Error handling" closing paragraph -->
<!-- code: the same handler throwing; comment shows the converted result -->
<!-- result: the verbatim isError result a throw produces -->

## Throw a protocol error
<!-- teaches: ProtocolError(code, message, data?) for failures the MODEL must not see (bad params, unknown resource); JSON-RPC error response, not a result | source: packages/core-internal/src/types/errors.ts ProtocolError -->
<!-- code: throw new ProtocolError(ProtocolErrorCode.InvalidParams, '...') from a resource read callback -->
<!-- result: the verbatim JSON-RPC error object on the wire -->

## Choose between tool error and protocol error
<!-- teaches: the rule - recoverable, model-visible failures -> isError; malformed requests / missing things / infrastructure -> protocol error (hidden from the model) | salvage: docs/server.md "Error handling" + docs/client.md "Error handling" framing -->
<!-- code: none -->

## Use the typed error subclasses
<!-- teaches: ResourceNotFoundError, UrlElicitationRequiredError, UnsupportedProtocolVersionError carry structured data and the right code | source: packages/core-internal/src/types/errors.ts -->
<!-- code: throw new ResourceNotFoundError(uri) from a read callback -->

## Look up a protocol error code
<!-- teaches: ProtocolErrorCode enum; the table carve-out (the ONE table allowed on a narrative page) | source: packages/core-internal/src/types/enums.ts ProtocolErrorCode -->
<!-- table placeholder (bottom of page), values verified against ProtocolErrorCode:
ParseError -32700 · InvalidRequest -32600 · MethodNotFound -32601 · InvalidParams -32602 · InternalError -32603 ·
ResourceNotFound -32002 (receive-tolerated only; the SDK answers -32602 and never emits -32002) ·
MissingRequiredClientCapability -32021 · UnsupportedProtocolVersion -32022 · UrlElicitationRequired -32042
-->

## Recap
<!-- the claims this page will prove:
- isError: true is a successful JSON-RPC response carrying a tool failure the model can act on.
- A thrown exception in a tool handler becomes isError: true automatically.
- ProtocolError / its subclasses produce JSON-RPC error responses the model never sees.
- Pick by audience: model-recoverable -> isError; caller/infrastructure -> protocol error.
- The full code list lives in the table at the bottom of this page.
-->
