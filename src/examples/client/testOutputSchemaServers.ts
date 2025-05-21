#!/usr/bin/env node
/**
 * Client to test outputSchema servers
 * This client connects to either the high-level or low-level outputSchema server
 * and calls the get_weather tool to demonstrate structured output
 */

import { Client } from "../../client/index.js";
import { StdioClientTransport } from "../../client/stdio.js";

async function main() {
  const serverPath = process.argv[2];
  
  if (!serverPath) {
    console.error("Usage: npx tsx src/examples/client/testOutputSchemaServers.ts <server-path>");
    console.error("Example: npx tsx src/examples/client/testOutputSchemaServers.ts ../server/mcpServerOutputSchema.ts");
    process.exit(1);
  }

  console.log(`Connecting to ${serverPath}...`);
  
  // Create transport that spawns the server process
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", serverPath]
  });

  const client = new Client({
    name: "output-schema-test-client",
    version: "1.0.0"
  }, {
    capabilities: {}
  });

  try {
    await client.connect(transport);
    console.log("Connected to server\n");

    // List available tools
    console.log("Listing available tools...");
    const toolsResult = await client.listTools();

    console.log("Available tools:");
    for (const tool of toolsResult.tools) {
      console.log(`- ${tool.name}: ${tool.description}`);
      if (tool.outputSchema) {
        console.log("  Has outputSchema: Yes");
        console.log("  Output schema:", JSON.stringify(tool.outputSchema, null, 2));
      } else {
        console.log("  Has outputSchema: No");
      }
    }

    // Call the weather tool
    console.log("\nCalling get_weather tool...");
    // Note: Output schema validation only works when using the high-level Client API
    // methods like callTool(). Low-level protocol requests do not validate the response.
    const weatherResult = await client.callTool({
      name: "get_weather",
      arguments: {
        city: "London",
        country: "UK"
      }
    });

    console.log("\nWeather tool result:");
    if (weatherResult.structuredContent) {
      console.log("Structured content:");
      console.log(JSON.stringify(weatherResult.structuredContent, null, 2));
    }
    
    if (weatherResult.content && Array.isArray(weatherResult.content)) {
      console.log("Unstructured content:");
      weatherResult.content.forEach(content => {
        if (content.type === "text") {
          console.log(content.text);
        }
      });
    }

    await client.close();
    console.log("\nDisconnected from server");
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();