import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "uvx",
  args:[
    "--quiet",
    "--refresh",
    "git+https://github.com/emsi/slow-mcp",
    "--transport",
    "stdio",
]
});

const client = new Client(
  {
    name: "example-client",
    version: "1.0.0"
  },
  {
    capabilities: {
      prompts: {},
      resources: {},
      tools: {}
    }
  }
);

await client.connect(transport);

const tools = await client.listTools();

console.log(tools);

// Call a tool
const result = await client.callTool({
  name: "run_command",
}, {
  timeout: 300000,
});


console.log(result);
