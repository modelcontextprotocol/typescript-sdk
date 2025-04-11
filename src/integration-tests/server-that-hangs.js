import { McpServer } from "../../dist/esm/server/mcp.js";
import { StdioServerTransport } from "../../dist/esm/server/stdio.js";
import { spawn } from "node:child_process";

const transport = new StdioServerTransport();

const server = new McpServer({
  name: "test-stdio-server",
  version: "1.0.0"
});

await server.connect(transport);

const doNotExitImmediately = async () => {
  setTimeout(() => process.exit(0), 30 * 1000);
};

process.stdin.on('close', doNotExitImmediately);
process.on('SIGINT', doNotExitImmediately);
process.on('SIGTERM', doNotExitImmediately);
