# Contributing an example

Each `examples/<story>/` directory is a tiny `@mcp-examples/<story>` workspace
package containing a `server.ts` / `client.ts` pair. The pair is a
self-verifying e2e test: the client connects, asserts results, and exits
non-zero on any mismatch. `pnpm run:examples` runs every story over its
configured transport × era legs and is part of the per-PR CI gate.

## Typical shape

Examples are **compiled documentation**. Every story shows the SDK transport
setup **inline** — no helper hides `serveStdio`, `createMcpHandler`, `Client`,
or transport construction. The duplication is the feature: when the public API
changes, 25 compile errors flag 25 doc pages.

Only the part a reader is _not_ here to learn — argv parsing — is shared, via
`parseExampleArgs` / `check` / `siblingPath` from `@mcp-examples/shared` (a
workspace package, so it reads as scaffolding, not part of the example). The
demo OAuth provider and `InMemoryEventStore` live at the
`@mcp-examples/shared/auth` subpath so the args-only root barrel does not pull
better-auth/express/better-sqlite3 into every story.

Most stories follow the skeleton below; deviate freely when the story calls for
it (HTTP-only auth, sessionful transports, framework adapters, etc.).

### `server.ts`

```ts
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

function buildServer(): McpServer {
    const server = new McpServer({ name: '<story>-example', version: '1.0.0' });
    // … register tools / resources / prompts here …
    return server;
}

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    void serveStdio(buildServer);
    console.error('[server] serving over stdio');
} else {
    const handler = createMcpHandler(buildServer);
    // `createMcpHonoApp()` arms localhost Host/Origin validation by default.
    const app = createMcpHonoApp();
    app.all('/mcp', c => handler.fetch(c.req.raw));
    serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
        console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
    });
}
```

The HTTP leg binds loopback explicitly and mounts the handler behind
`createMcpHonoApp()`, which applies host/origin validation by default —
matching the framework factories' defaults. A story whose point is the raw
`node:http` wiring (e.g. `gateway/`, `elicitation/`) keeps
`createServer` + `toNodeHandler` but must then bind
`.listen(port, '127.0.0.1')` and compose the `localhostHostValidation()` /
`localhostOriginValidation()` guards from `@modelcontextprotocol/node` in
front of the handler. Either way, no example teaches an unguarded HTTP mount.

### `client.ts`

```ts
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const { transport, url, era } = parseExampleArgs();

const client = new Client({ name: '<story>-example-client', version: '1.0.0' }, { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } });

await client.connect(transport === 'stdio' ? new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] }) : new StreamableHTTPClientTransport(new URL(url)));

// … example body — drive the server and assert with `check.*` …

await client.close();
```

The body uses top-level `await`. A `check.*` failure throws, Node prints the
error and exits 1; on success `client.close()` releases the last handle and
Node exits 0. `pnpm run:examples` reports PASS/FAIL from the exit code (a
timeout is reported as a hang — investigate it as a possible unclosed handle).

## Import rules (lint-enforced)

Stories may import from:

- `@modelcontextprotocol/{server,client,core,node,express,hono}` and their published
  subpath exports (e.g. `@modelcontextprotocol/server/stdio`)
- `@mcp-examples/shared` (args/assert) and `@mcp-examples/shared/auth` (demo OAuth + `InMemoryEventStore`)
- third-party packages a consumer would `npm install`

Stories may **not** import from:

- `@modelcontextprotocol/core-internal` or `@modelcontextprotocol/core-internal/*` (internal barrel)
- `@modelcontextprotocol/*/src/*` or `@modelcontextprotocol/*/dist/*` (deep paths)
- `@modelcontextprotocol/test-helpers`
- any relative path that hides the SDK transport setup behind a shared helper

`@mcp-examples/shared` itself must never import from a story package (one-way).
