import { McpServer } from "../../dist/esm/server/mcp.js";
import { StdioServerTransport } from "../../dist/esm/server/stdio.js";

const transport = new StdioServerTransport();

const server = new McpServer({
  name: "test-server",
  version: "1.0.0",
});

await server.connect(transport);
