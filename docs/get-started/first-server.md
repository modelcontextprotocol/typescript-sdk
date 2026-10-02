---
status: calibration
shape: tutorial
---

# Build your first server

Build an MCP **server** — a program that exposes tools a model can call — and call its one tool, a US weather-alert lookup, from a client.

## Set up the project

You need Node.js 20 or later and nothing else. Create the project and install the SDK.

```sh
mkdir weather && cd weather
npm init -y
npm pkg set type=module
npm install @modelcontextprotocol/server zod tsx
mkdir src
```

`type=module` matters — the SDK ships ES modules only. `tsx` runs TypeScript directly, so there is no build step.

## Register a tool

Create `src/index.ts`: a `createServer` factory that builds an `McpServer` and registers one **tool** — a function the connected model can call.

```ts source="../../examples/guides/get-started/firstServer.examples.ts#firstServer_registerTool"
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const NWS_API = 'https://api.weather.gov';

interface AlertsResponse {
    features: { properties: { event?: string; headline?: string } }[];
}

function createServer(): McpServer {
    const server = new McpServer({ name: 'weather', version: '1.0.0' });

    server.registerTool(
        'get-alerts',
        {
            description: 'Get the active weather alerts for a US state',
            inputSchema: z.object({
                state: z.string().length(2).describe('Two-letter US state code, e.g. CA')
            })
        },
        async ({ state }) => {
            const code = state.toUpperCase();
            const url = `${NWS_API}/alerts/active?area=${code}`;
            const res = await fetch(url, { headers: { 'User-Agent': 'mcp-weather-tutorial/1.0' } });
            if (!res.ok) {
                return { content: [{ type: 'text', text: `NWS API error: HTTP ${res.status}` }], isError: true };
            }
            const { features } = (await res.json()) as AlertsResponse;
            if (features.length === 0) {
                return { content: [{ type: 'text', text: `No active alerts for ${code}.` }] };
            }
            const lines = features.map(f => f.properties.headline ?? f.properties.event ?? 'Unnamed alert');
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
    );

    return server;
}
```

`registerTool` takes a name, a config, and an async handler. `inputSchema` is a Zod schema — the only schema you write. From that one schema the SDK derives the JSON Schema the model sees, validates arguments before your handler runs, and infers the handler's argument types.

The handler returns **content**, a list of typed blocks — one `text` block here. `isError: true` marks a failed result the model can read and react to.

::: tip
Call `get-alerts` with `{ "state": "California" }` and the SDK rejects it before your handler runs. The result is the failure the model sees:

```text
Input validation error: Invalid arguments for tool get-alerts: state: Too big: expected string to have <=2 characters
```

:::

## Serve it over stdio

At the end of the file, hand the factory to `serveStdio`.

```ts source="../../examples/guides/get-started/firstServer.examples.ts#firstServer_serve"
void serveStdio(createServer);
console.error('weather MCP server running on stdio');
```

`serveStdio` owns the **stdio transport**: it reads requests on stdin, writes responses to stdout, and calls `createServer` to build the instance that serves the connection.

::: warning
stdout is the protocol channel. Log with `console.error` — one `console.log` corrupts the JSON-RPC stream.
:::

## Run it

Start the server from the project root.

```sh
npx tsx src/index.ts
```

The banner lands on stderr, leaving stdout for the protocol:

```text
weather MCP server running on stdio
```

Nothing else happens: an stdio server waits on stdin for a client to start the conversation. Stop it with `Ctrl+C`.

## Call the tool

The **MCP Inspector** is a local web app for calling a server's tools directly — it launches the command you give it and connects over stdio.

```sh
npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

In the browser tab it opens, click **Connect**, open the **Tools** tab, select `get-alerts`, enter a two-letter state code such as `TX`, and run it. The text block in the result lists each active alert headline for that state — the same content a model receives when it calls your tool.

## Pick a transport

Your server speaks stdio because a host launches it as a local process and owns its lifetime. To host one endpoint that many clients connect to, serve the same `createServer` factory over [HTTP](../serving/http.md) instead.

Next on this path, [Plug into a real host](./real-host.md) registers this server in VS Code, Claude Code, and Cursor; [Tools](../servers/tools.md) goes deeper on what a tool can return.

## Recap

- `registerTool(name, config, handler)` registers a tool; `inputSchema` is the one Zod schema you write.
- The SDK validates every call against that schema and rejects bad arguments before your handler runs.
- `serveStdio(createServer)` builds the server from your factory and serves it on stdin/stdout.
- stdout carries the protocol; log to stderr.
- `npx @modelcontextprotocol/inspector <command>` exercises any stdio server without a host.
