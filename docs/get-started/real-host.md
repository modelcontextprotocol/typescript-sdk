---
status: scaffold
shape: tutorial
---

# Plug into a real host

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Plug your server into Claude Code / VS Code / Cursor
teaches: the host launch contract (command + args), .vscode/mcp.json, host registration, agent-mode tool call
source: mined from docs/server-quickstart.md "Running the server", "Testing your server in VS Code", "What's happening under the hood", "Troubleshooting"
host order (Felix ruling): VS Code leads the main flow; Claude Code and Cursor are H3 subsections after it.
prereq: the weather server from get-started/first-server.md — one tool (`get-alerts(state)`),
run with `npx tsx src/index.ts` from the project root; there is no build step.
Every host on this page is given that one command.
-->

## Hand the host a launch command

<!-- teaches: the launch contract — a host starts your server as a child process from a command + args; first-server's `src/index.ts` already ends with the serve call, so `npx tsx src/index.ts` IS the entry. No new server code on this page. | salvage: docs/server-quickstart.md "Running the server" -->

```ts
// draft - API verified against packages/server/src/server/serveStdio.ts
import { serveStdio } from '@modelcontextprotocol/server/stdio';

// the last lines of src/index.ts from "Build your first server" — createServer is the factory you wrote there
void serveStdio(createServer);
console.error('weather MCP server running on stdio');
```

<!-- result: `npx tsx src/index.ts` (from the project root) starts it, waits silently on stdin, and logs only to stderr — the command and behavior every host below relies on. -->
<!-- aside (::: warning): console.error, never console.log — stdout is the JSON-RPC channel.
     salvage: docs/server-quickstart.md IMPORTANT box (lines 362-363). -->

## Register the server in VS Code

<!-- teaches: .vscode/mcp.json (type: stdio, command, args) | salvage: docs/server-quickstart.md "Configure the MCP server" -->
<!-- code: json — .vscode/mcp.json with one "weather" stdio entry: command "npx", args ["tsx", "src/index.ts"] (the workspace root is the cwd) -->
<!-- result: VS Code prompts to trust the server; "MCP: List Servers" shows `weather` running. -->
<!-- aside (::: info): VS Code 1.99+, GitHub Copilot extension; Copilot Free is enough.
     salvage: docs/server-quickstart.md "Prerequisites" under "Testing your server in VS Code". -->

## Call the tool from Copilot Chat

<!-- teaches: agent mode, tool approval, the conversion moment | salvage: docs/server-quickstart.md "Use the tools" -->
<!-- code: text — the prompt ("Are there any weather alerts in Texas?") and the assistant turn that shows
     get-alerts being invoked; REAL transcript captured when prose lands. -->
<!-- result: the assistant calls get-alerts with a two-letter state code and answers from its output. -->

## Trace the round trip

<!-- teaches: host -> model -> tools/call -> server -> model loop | salvage: docs/server-quickstart.md "What's happening under the hood" -->
<!-- code: none — six-step numbered sequence (question -> model picks tool -> client sends tools/call ->
     server handler runs -> result back to model -> answer). No new API. -->

## Connect other hosts

<!-- teaches: the same stdio command works in any MCP host; only the config file differs.
     salvage: net-new (current docs cover VS Code only; modelcontextprotocol.io clients list is the link target). -->

### Claude Code

<!-- code: sh — `claude mcp add weather -- npx tsx src/index.ts` (verify exact CLI form in the prose tranche) -->
<!-- result: /mcp lists `weather` as connected; the same prompts work. -->

### Cursor

<!-- code: json — .cursor/mcp.json, same { command, args } shape as VS Code -->
<!-- result: the server appears under Cursor's MCP settings with `get-alerts` listed. -->

## Fix a host that does not see your tools

<!-- teaches: the three real failure modes | salvage: docs/server-quickstart.md "Troubleshooting" (VS Code <details>) -->
<!-- code: sh — `npx tsx src/index.ts` started by hand: it must sit and wait, not print to stdout and exit. -->
<!-- result: a server that starts, waits, and logs only to stderr is one the host can attach to. -->

## Recap

<!-- the 4-5 claims this page will prove:
- A host launches your server from a command + args; `npx tsx src/index.ts` is that command — no build step.
- One .vscode/mcp.json entry registers a stdio server in VS Code.
- In agent mode the model discovers your tools from their schemas and calls them unprompted.
- Claude Code and Cursor take the same command; only where you put it differs.
- stdout belongs to JSON-RPC; log to stderr or the host drops the connection.
-->
