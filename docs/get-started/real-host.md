---
shape: tutorial
---

# Plug into a real host

A **host** is an application with a model in it — VS Code with Copilot, Claude Code, Cursor. Register the weather server from [Build your first server](./first-server.md) in all three and watch the assistant call `get-alerts` on its own.

## Hand the host a launch command

To attach your server, a host needs one thing — a command it can launch as a child process and talk to over that process's stdin and stdout — and `src/index.ts` already ends with the entry that speaks to those two pipes.

```ts source="../../examples/guides/get-started/realHost.examples.ts#realHost_serve"
void serveStdio(createServer);
console.error('weather MCP server running on stdio');
```

So the launch command is the one you already use: `npx tsx src/index.ts`, run from the project root. There is no build step, and there is no new server code on this page — every host below gets that one command.

::: warning
stdout is the protocol channel. One `console.log` and the host drops the connection — log with `console.error`.
:::

## Register the server in VS Code

Create `.vscode/mcp.json` in the `weather` project root, with one stdio entry that holds the launch command.

```json
{
  "servers": {
    "weather": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "src/index.ts"]
    }
  }
}
```

VS Code runs the command from the workspace root — the same directory you run it from by hand — and prompts you to trust the new server. Confirm, then run **MCP: List Servers** from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`): `weather` shows a running status.

::: info
You need VS Code 1.99 or later with the **GitHub Copilot** extension installed and signed in. [Copilot Free](https://github.com/features/copilot/plans) is enough.
:::

## Call the tool from Copilot Chat

Open **Copilot Chat** (`Ctrl+Alt+I` / `Ctrl+Cmd+I`), switch the mode selector at the top of the panel to **Agent** — the only Copilot mode that calls tools — and ask about the one thing your server knows.

```text
What are the active weather alerts in Texas?
```

Copilot stops to show the call it wants to make — `get-alerts` with a two-letter `state` — and waits for you to approve it. Approve, and the handler you wrote in `src/index.ts` runs; the answer in the chat is written from the text block it returned.

Nothing in the prompt names the tool. The model picked `get-alerts` from its name, its description, and the JSON Schema the SDK derived from your `inputSchema`.

::: tip
Click the **Tools** button in the chat panel to see the list the model is choosing from — `get-alerts` is in it, described exactly as you registered it.
:::

## Trace the round trip

That one answer is six steps.

1. VS Code sends your question to the model, along with the name, description, and input schema of every available tool.
2. The model decides `get-alerts` answers the question and emits a call with the arguments it chose.
3. VS Code — the MCP **client** inside the host — sends a `tools/call` request to your server over stdio.
4. The SDK validates the arguments against your `inputSchema` and runs your handler.
5. The handler's `content` goes back over stdout as the `tools/call` result.
6. The model reads the text block and writes the answer you see in the chat.

## Connect other hosts

Every MCP host launches a stdio server from the same command and arguments. Only where you put them differs.

### Claude Code

Register the server from the project root; everything after `--` is the launch command.

```sh
claude mcp add weather -- npx tsx src/index.ts
```

Run `/mcp` inside a Claude Code session in that directory: `weather` is connected, with `get-alerts` listed under it. The same prompt drives the same tool call.

### Cursor

Create `.cursor/mcp.json` in the project root.

```json
{
  "mcpServers": {
    "weather": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"]
    }
  }
}
```

The entry is the same `command` plus `args`; only the wrapper key and the file name change. The server appears under Cursor's MCP settings with `get-alerts` listed, and agent chat calls it the same way.

## Fix a host that does not see your tools

Run the launch command by hand, from the project root, before you change any host config.

```sh
npx tsx src/index.ts
```

It prints one line to stderr and then waits.

```text
weather MCP server running on stdio
```

Anything else is the bug, and it has one of three causes.

- The process exits or crashes: the host has nothing to attach to. Fix the command here, where you can read the error, then re-register it.
- Anything besides JSON-RPC reaches stdout: the host reads it as a corrupt message and drops the connection. Find the `console.log` and make it `console.error`.
- The server runs but Copilot never calls it: confirm the chat is in **Agent** mode, then run **MCP: Reset Cached Tools** from the Command Palette.

A command that prints that one line to stderr and waits is one every host on this page can attach to.

## Take the server further

[Tools](../servers/tools.md) covers structured output, annotations, and everything else a handler can return. [HTTP](../serving/http.md) serves the same `createServer` factory as one endpoint many clients share. [Test a server](../testing.md) drives it from an in-memory client — no host, no approval click.

## Recap

- A host launches your server as a child process from a command plus arguments; `npx tsx src/index.ts` is that command, with no build step.
- One `.vscode/mcp.json` entry — `type: stdio`, `command`, `args` — registers the server in VS Code.
- In agent mode the model picks `get-alerts` from its name, description, and input schema; you never name it.
- Claude Code and Cursor take the same launch command; only the config file differs.
- stdout belongs to JSON-RPC — log to stderr or the host drops the connection.
