import { Tool } from "../../types.js";
import { Client } from "../../client/index.js";
import { InMemoryTransport } from "../../inMemory.js";
import { McpServer, ToolCallback } from "../../server/mcp.js";
import { Transport } from "../../shared/transport.js";

async function main(): Promise<void> {
  console.log("MCP Client Group Example");
  console.log("============================");

  const clientTransports = await spinUpServers();

  const client1 = new Client({
    name: "client-1",
    version: "1.0.0",
  });
  client1.connect(clientTransports[0]);

  const client2 = new Client({
    name: "client-2",
    version: "1.0.0",
  });
  client2.connect(clientTransports[1]);

  const client3 = new Client({
    name: "client-3",
    version: "1.0.0",
  });
  client3.connect(clientTransports[2]);

  const allClients = [client1, client2, client3];
  const toolToClient: { [key: string]: Client } = {};
  const allTools = [];

  for (const client of allClients) {
    for (const tool of (await client.listTools()).tools) {
      if (toolToClient[tool.name]) {
        console.warn(
          `Tool name: ${tool.name} is available on multiple servers, picking an arbitrary one`,
        );
      }
      toolToClient[tool.name] = client;
      allTools.push(tool);
    }
  }

  const allResources = [];
  allResources.push(...(await client1.listResources()).resources);
  allResources.push(...(await client2.listResources()).resources);
  allResources.push(...(await client3.listResources()).resources);

  const toolName = simulatePromptModel(allTools);

  console.log(`Invoking tool: ${toolName}`);
  const toolResult = await toolToClient[toolName].callTool({
    name: toolName,
  });

  console.log(toolResult);

  for (const client of allClients) {
    await client.close();
  }
}

// Start the example
main().catch((error: unknown) => {
  console.error("Error running MCP Client Group example:", error);
  process.exit(1);
});

async function spinUpServer(
  name: string,
  cb: ToolCallback,
): Promise<Transport> {
  const server = new McpServer({
    name: name,
    version: "1.0.0",
  });

  server.tool(name, cb);

  server.resource("greeting", "greeting://hello", async (uri) => ({
    contents: [
      {
        uri: uri.href,
        text: `Hello from ${name}!`,
      },
    ],
  }));

  const transports = InMemoryTransport.createLinkedPair();
  await server.connect(transports[0]);

  return transports[1];
}

async function spinUpServers(): Promise<Transport[]> {
  const clientTransports = [];
  clientTransports.push(
    await spinUpServer("ping", async () => ({
      content: [{ type: "text", text: "pong" }],
    })),
  );

  clientTransports.push(
    await spinUpServer("pong", async () => ({
      content: [{ type: "text", text: "ping" }],
    })),
  );

  // We deliberately spin up 2 servers with the same tool name to
  // demonstrate dealing with that edge case in the sample.
  clientTransports.push(
    await spinUpServer("ping", async () => ({
      content: [{ type: "text", text: "pong2" }],
    })),
  );

  return clientTransports;
}

function simulatePromptModel(tools: Tool[]): string {
  console.log(`Model was prompted with the following tools:`);
  for (const tool of tools) {
    console.log(`  - ${tool.name}`);
  }
  return "ping";
}
