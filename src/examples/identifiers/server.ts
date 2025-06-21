/**
 * MCP Server with identifier forwarding using stdio transport
 * Run with: npx tsx server.ts
 */

import { McpServer } from "../../server/mcp.js";
import { StdioServerTransport } from "../../server/stdio.js";
import { EnhancedRequestHandlerExtra } from "../../server/identifierTypes.js";
import fetch from "node-fetch";

// Create MCP server with identifier forwarding enabled
const serverInfo = { name: "test-server", version: "1.0.0" };
const serverOptions = {
  identifierForwarding: {
    enabled: true,
    headerPrefix: "X-MCP-",
    allowedKeys: undefined  // Allow all keys
  }
};

const mcpServer = new McpServer(serverInfo, serverOptions);

// Register a tool that makes HTTP requests to test API server
mcpServer.registerTool("call_api", {
  title: "Call API",
  description: "Makes an HTTP request with identifiers forwarded as headers",
  inputSchema: {},
}, async (_: any, extra: EnhancedRequestHandlerExtra) => {
  console.error('TOOL: Received identifiers:', extra.identifiers);
  
  try {
    // Apply identifiers to request options
    const requestOptions = extra.applyIdentifiersToRequestOptions({
      headers: { "Content-Type": "application/json" }
    });
    
    console.error('TOOL: Will send HTTP headers:');
    console.error(JSON.stringify(requestOptions.headers, null, 2));
    
    // Make HTTP request to API server
    const response = await fetch("http://localhost:4000/api", {
      method: "POST",
      ...requestOptions,
      body: JSON.stringify({ message: "Hello from MCP tool!" })
    });
    
    const data = await response.json();
    
    return {
      content: [{ 
        type: "text", 
        text: `API responded: ${JSON.stringify(data)}` 
      }]
    };
  } catch (error: any) {
    console.error("Error in tool:", error);
    return {
      content: [{ 
        type: "text", 
        text: `Error: ${error.message}` 
      }],
      isError: true
    };
  }
});

// Connect to stdio transport
const transport = new StdioServerTransport();
await mcpServer.connect(transport);

console.error("MCP Server started and listening on stdio");