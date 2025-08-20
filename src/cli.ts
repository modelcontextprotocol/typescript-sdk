import WebSocket from "ws";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).WebSocket = WebSocket;

import http from "http";
import { Client } from "./client/index.js";
import { SSEClientTransport } from "./client/sse.js";
import { StdioClientTransport } from "./client/stdio.js";
import { WebSocketClientTransport } from "./client/websocket.js";
import { Server } from "./server/index.js";
import { SSEServerTransport } from "./server/sse.js";
import { StdioServerTransport } from "./server/stdio.js";
import { ListResourcesResultSchema } from "./types.js";

async function runClient(url_or_command: string, args: string[]) {
  const client = new Client(
    {
      name: "mcp-typescript test client",
      version: "0.1.0",
    },
    {
      capabilities: {
        sampling: {},
      },
    },
  );

  let clientTransport;

  let url: URL | undefined = undefined;
  try {
    url = new URL(url_or_command);
  } catch {
    // Ignore
  }

  if (url?.protocol === "http:" || url?.protocol === "https:") {
    clientTransport = new SSEClientTransport(new URL(url_or_command));
  } else if (url?.protocol === "ws:" || url?.protocol === "wss:") {
    clientTransport = new WebSocketClientTransport(new URL(url_or_command));
  } else {
    clientTransport = new StdioClientTransport({
      command: url_or_command,
      args,
    });
  }

  console.log("Connected to server.");

  await client.connect(clientTransport);
  console.log("Initialized.");

  await client.request({ method: "resources/list" }, ListResourcesResultSchema);

  await client.close();
  console.log("Closed.");
}

async function runServer(port: number | null) {
  if (port !== null) {
    let servers: Server[] = [];
    const app = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/sse') {
        console.log("Got new SSE connection");

        const transport = new SSEServerTransport("/message", res);
        const server = new Server(
          {
            name: "mcp-typescript test server",
            version: "0.1.0",
          },
          {
            capabilities: {},
          },
        );

        servers.push(server);

        server.onclose = () => {
          console.log("SSE connection closed");
          servers = servers.filter((s) => s !== server);
        };

        await server.connect(transport);
      }

      if (req.method === 'POST' && url.pathname === '/message') {
        console.log("Received message");

        const sessionId = url.searchParams.get("sessionId") as string;
        const transport = servers
          .map((s) => s.transport as SSEServerTransport)
          .find((t) => t.sessionId === sessionId);
        if (!transport) {
          res.statusCode = 404;
          res.end("Session not found");
          return;
        }

        await transport.handlePostMessage(req, res);
      }
    });

    app.on('error', error => {
      console.error('Failed to start server:', error);
      process.exit(1);
    })
    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}/sse`);
    });
  } else {
    const server = new Server(
      {
        name: "mcp-typescript test server",
        version: "0.1.0",
      },
      {
        capabilities: {
          prompts: {},
          resources: {},
          tools: {},
          logging: {},
        },
      },
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.log("Server running on stdio");
  }
}

const args = process.argv.slice(2);
const command = args[0];
switch (command) {
  case "client":
    if (args.length < 2) {
      console.error("Usage: client <server_url_or_command> [args...]");
      process.exit(1);
    }

    runClient(args[1], args.slice(2)).catch((error) => {
      console.error(error);
      process.exit(1);
    });

    break;

  case "server": {
    const port = args[1] ? parseInt(args[1]) : null;
    runServer(port).catch((error) => {
      console.error(error);
      process.exit(1);
    });

    break;
  }

  default:
    console.error("Unrecognized command:", command);
}
