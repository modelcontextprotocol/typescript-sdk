# apps-elicitation

A self-verifying `2026-07-28` example of using an MCP App as the UI for a
standard form elicitation.

The client and server negotiate `elicitation: {}` as a setting of the existing
`io.modelcontextprotocol/ui` extension. The server returns an
`InputRequiredResult` whose `inputRequests["delivery-window"]` entry is an
ordinary `elicitation/create` request with:

- a complete `requestedSchema` for native fallback; and
- `_meta.ui.resourceUri` pointing to a `text/html;profile=mcp-app` resource.

The headless client resolves that resource through the same MCP connection and
returns a standard `ElicitResult`. The SDK then retries the original
`tools/call` with the result under the matching `inputResponses` key. A
graphical host replaces the deterministic selection with an MCP Apps bridge;
the MRTR wire flow is unchanged.

The HTTP/modern leg is stateless: `createMcpHandler(buildServer)` constructs a
fresh server for each request, so the elicitation response reaches the retried
`tools/call` entirely through the MRTR `inputResponses` envelope rather than
in-memory session state. The examples runner exercises both this HTTP leg and
the stdio leg.

No app-elicitation extension, custom method, or custom result type is used.
MCP Apps continues to negotiate its View↔Host protocol independently of core
MCP's `2026-07-28` revision.

```bash
# stdio
pnpm tsx examples/apps-elicitation/client.ts

# HTTP (two terminals)
pnpm tsx examples/apps-elicitation/server.ts --http --port 3000
pnpm tsx examples/apps-elicitation/client.ts --http http://127.0.0.1:3000/mcp
```

Related proposals:

- [MCP Apps draft PR #733](https://github.com/modelcontextprotocol/ext-apps/pull/733)
- [SEP-3118](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3118)
