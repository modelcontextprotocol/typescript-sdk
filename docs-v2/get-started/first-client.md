---
status: scaffold
shape: tutorial
---

# Build your first client

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Connect, list, call, read, close — neutral, no vendor SDK
teaches: Client, StdioClientTransport, connect, listTools, callTool, readResource, close
source: mined from docs/client-quickstart.md "Server connection management", "Query processing logic",
        "Main entry point"; readResource is net-new on this path (from docs/client.md "Resources").
vendor-neutral ruling: no Anthropic SDK in the main flow; the tool-use loop is a linked example
(proposal §3 path 1, §7 client-quickstart fate). Joins the e2e runner as a self-verifying story
(proposal §4.2) — every output block on this page is REAL once prose lands.
prereq: the weather server from get-started/first-server.md (or any stdio server script) — ONE
tool, `get-alerts(state)`, no resources, run with `npx tsx src/index.ts` (no build step).
Every command/output on this page must agree with that.
-->

## Connect to a server

<!-- teaches: Client, StdioClientTransport, connect | salvage: docs/client-quickstart.md "Server connection management" -->

```ts
// draft - API verified against packages/client/src/client/client.ts and packages/client/src/client/stdio.ts
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const client = new Client({ name: 'my-first-client', version: '1.0.0' });
const transport = new StdioClientTransport({
  // the weather server from "Build your first server" — adjust the path to where you put it
  command: 'npx',
  args: ['tsx', '../weather/src/index.ts'],
});
await client.connect(transport);
```

<!-- result: the client spawns the server process and completes the initialize handshake; nothing prints yet
     (the server's own banner lands on its stderr). -->
<!-- aside (::: info): npm install @modelcontextprotocol/client — project scaffolding is the same
     setup-once step as first-server, linked not repeated.
     salvage: docs/client-quickstart.md "Set up your environment". -->
<!-- aside (::: tip): the client owns the server's lifetime — never start the script yourself.
     salvage: docs/client-quickstart.md "Common Error Messages" (spawn ENOENT). -->

## List the server's tools

<!-- teaches: listTools | salvage: docs/client-quickstart.md "Server connection management" (listTools call) -->
<!-- code: ts — await client.listTools(); log each tool's name + description -->
<!-- output: REAL — the one weather tool, `get-alerts`, with its description, verbatim from the runner. -->

## Call a tool

<!-- teaches: callTool, CallToolResult.content, isError | salvage: docs/client-quickstart.md "Query processing logic" (callTool + isError) -->
<!-- code: ts — await client.callTool({ name: 'get-alerts', arguments: { state: 'CA' } }); print the text content block -->
<!-- output: REAL — the formatted alert text (or "No active alerts for CA."), verbatim. -->
<!-- aside (::: tip): pass arguments that fail the tool's schema and the call returns an error
     before the handler runs — the one validation-error output for this page. -->

## Add a resource and read it

<!-- teaches: listResources, readResource | source: net-new for the tutorial; mined from docs/client.md "Resources" -->
<!-- prereq honesty (MF1): the weather server registers NO resources, so this section first has the
     reader add one (a single registerResource line in the weather project's src/index.ts, with a
     cross-link to /servers/resources for depth) and then reads it from the client. -->
<!-- code: ts — await client.listResources() then await client.readResource({ uri }) on the first result -->
<!-- output: REAL — the one resource's uri/name from listResources, then its text contents. -->

## Close the connection

<!-- teaches: close | salvage: docs/client-quickstart.md "Interactive chat interface" (cleanup) + "Main entry point" (finally) -->
<!-- code: ts — await client.close() in a finally block -->
<!-- result: the spawned server process exits; the script terminates cleanly. -->

## Hand the tool list to a model

<!-- teaches: where an LLM slots in; this page stays vendor-neutral.
     salvage: docs/client-quickstart.md "What's happening under the hood" (the loop, told without vendor code);
     the full Anthropic tool-use loop survives as a linked, runner-excluded example (proposal §4.2). -->
<!-- code: none — one short paragraph: listTools() output is exactly what a tool-calling API wants;
     link the tool-use-loop example and the host page (real-host.md). -->

## Recap

<!-- the 5-6 claims this page will prove:
- A Client plus one transport is a complete MCP client; connect() runs the handshake.
- StdioClientTransport spawns and owns the server process — you never start it by hand.
- listTools, callTool, readResource are the verbs; each returns typed results.
- Tool results arrive as content blocks; isError marks a failed call without throwing.
- close() tears down the transport and the spawned process.
- Nothing here needs a model; an LLM consumes listTools() output unchanged.
-->
