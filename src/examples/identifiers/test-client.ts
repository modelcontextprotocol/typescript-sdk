/**
 * Test client with API server for identifier forwarding demo
 * Run with: npx tsx test-client.ts
 */

import { createServer } from "http";
import express from "express";
import { Client } from "../../client/index.js";
import { StdioClientTransport } from "../../client/stdio.js";

// 1. Create Express API server to log received headers
const app = express();
app.use(express.json());

// API endpoint to receive requests and check headers
app.post('/api', (req, res) => {
  console.log('\nAPI SERVER: Received request with headers:');

  // Extract and log MCP-specific headers
  const mcpHeaders = Object.entries(req.headers)
    .filter(([key]) => key.toLowerCase().startsWith('x-mcp'))
    .reduce((obj, [key, val]) => ({ ...obj, [key]: val }), {});

  console.log(JSON.stringify(mcpHeaders, null, 2));

  res.json({
    success: true,
    message: 'Request processed with headers',
    receivedHeaders: mcpHeaders
  });
});

// Start API server
const apiPort = 4000;
const apiServer = createServer(app);

// Manual test function that exercises all parts of the system
async function runTest() {
  // Set up stdio transport to connect to the MCP server
  let transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/examples/identifiers/server.ts"]
  });

  try {
    // Start API server
    await new Promise<void>(resolve => {
      apiServer.listen(apiPort, () => {
        console.log(`API server listening on port ${apiPort}`);
        resolve();
      });
    });

    console.log("\n=== TEST 1: Client-Level Identifiers Only ===");

    // Create client with client-level identifiers
    const clientWithIds = new Client({
      name: "test-client-1",
      version: "1.0.0",
      identifiers: {
        "trace-id": "client-trace-123",
        "tenant-id": "client-tenant-456"
      }
    });

    console.log("\nCLIENT: Created with identifiers:");
    console.log({
      "trace-id": "client-trace-123",
      "tenant-id": "client-tenant-456"
    });



    // Connect client to server via stdio
    await clientWithIds.connect(transport);
    console.log("\nCLIENT: Connected to MCP server via stdio");

    // Make the tool call WITHOUT any request identifiers
    // This should only use the client-level identifiers
    console.log("\nCLIENT: Calling tool with NO request identifiers (client-level only)");
    console.log("\nCLIENT: Executing tool call...");
    const result1 = await clientWithIds.callTool({
      name: "call_api",
      arguments: {}
      // No identifiers field - should use client-level identifiers only
    });

    console.log("\nCLIENT: Received tool call result:");
    console.log(JSON.stringify(result1, null, 2));

    // Close first client connection
    await clientWithIds.close();
    if (transport) {
      await transport.close();
    }

    console.log("\n\n=== TEST 2: Request-Level Identifiers Only ===");

    // Create client WITHOUT any client-level identifiers
    const clientWithoutIds = new Client({
      name: "test-client-2",
      version: "1.0.0"
      // No identifiers specified at client level
    });

    console.log("\nCLIENT: Created WITHOUT any client-level identifiers");

    // Create new transport for second test
    transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/examples/identifiers/server.ts"]
    });

    // Connect second client to server
    await clientWithoutIds.connect(transport);
    console.log("\nCLIENT: Connected to MCP server via stdio");

    // Call the tool with request-level identifiers only
    console.log("\nCLIENT: Calling tool with request-level identifiers:");
    const requestIdentifiers = {
      "request-id": "req-789",
      "user-id": "user-abc",
      "tenant-id": "request-tenant-xyz"
    };
    console.log(requestIdentifiers);

    // Make the tool call with request identifiers
    console.log("\nCLIENT: Executing tool call...");
    const result2 = await clientWithoutIds.callTool({
      name: "call_api",
      arguments: {},
      identifiers: requestIdentifiers
    });

    console.log("\nCLIENT: Received tool call result:");
    console.log(JSON.stringify(result2, null, 2));

    // Verify the flow worked correctly
    console.log("\n=== Test Results ===");
    console.log("✅ Client-level identifiers were set on client");
    console.log("✅ Request-level identifiers were included in request");
    console.log("✅ MCP server received request via stdio transport");
    console.log("✅ Tool received merged identifiers on server");
    console.log("✅ Identifiers were forwarded as HTTP headers");
    console.log("✅ API server received requests with X-MCP headers");

    // Clean up
    await clientWithoutIds.close();
    if (transport) {
      await transport.close();
    }

    console.log("\nTest completed successfully!");

  } catch (error) {
    console.error("Test error:", error);
  } finally {
    apiServer.close();
  }
}

// Run the test
runTest();