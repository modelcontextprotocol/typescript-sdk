# `@modelcontextprotocol/node`

Node.js adapters for the MCP TypeScript server SDK.

This package is a thin Node.js integration layer for [`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server). It provides a Streamable HTTP transport that works with Node’s `IncomingMessage` / `ServerResponse`.

For web‑standard runtimes (Cloudflare Workers, Deno, Bun, etc.), use `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server` directly.

## Install

```bash
npm install @modelcontextprotocol/server @modelcontextprotocol/node
```

## Exports

- `NodeStreamableHTTPServerTransport`
- `StreamableHTTPServerTransportOptions` (type alias for `WebStandardStreamableHTTPServerTransportOptions`)
- `toNodeHandler(handler, opts?)` — adapt a web-standard `{ fetch }` MCP handler to a Node `(req, res, parsedBody?)` handler
- `hostHeaderValidation(allowedHostnames)` / `localhostHostValidation()` — `Host` header guards for hand-wired `node:http` servers
- `originValidation(allowedOriginHostnames)` / `localhostOriginValidation()` — `Origin` header guards for hand-wired `node:http` servers
- `ToNodeHandlerOptions`, `FetchLikeMcpHandler`, `NodeMcpRequestHandler` (types for `toNodeHandler`)
- `toWebRequest(req, parsedBody?, opts?)` — the Node `IncomingMessage` → web-standard `Request` conversion `toNodeHandler` performs internally, exported on its own (for example to feed `isLegacyRequest()` from a hand-wired `(req, res)` handler)
- `ToWebRequestOptions` (options type for `toWebRequest`)
- `NodeIncomingMessageLike`, `NodeServerResponseLike` (structural Node request/response shapes)

## Usage

### Express + Streamable HTTP

```ts
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
const app = createMcpExpressApp();

app.post('/mcp', async (req, res) => {
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);

    // If you use Express JSON parsing, pass the pre-parsed body to avoid re-reading the stream.
    await transport.handleRequest(req, res, req.body);
});
```

### Node.js `http` server

Plain `node:http` has no middleware chain, so bind loopback explicitly and
compose the `Host`/`Origin` guards in front of the transport — matching the
defaults the framework app factories (`createMcpExpressApp`,
`createMcpHonoApp`, `createMcpFastifyApp`) apply for you. The guards answer
rejected requests with `403` themselves and return `false`, so the handler
must not touch the request further.

```ts
import { createServer } from 'node:http';
import { localhostHostValidation, localhostOriginValidation, NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });

const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

createServer(async (req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
}).listen(3000, '127.0.0.1');
```
