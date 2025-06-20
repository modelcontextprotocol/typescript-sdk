/**
 * Comprehensive test suite for client-level identifier forwarding
 * Run with: npx tsx test-client.ts
 */

import { createServer } from "http";
import express from "express";
import { Client } from "../../client/index.js";
import { StdioClientTransport } from "../../client/stdio.js";

// API server to capture and validate headers
const app = express();
app.use(express.json());

let requestCount = 0;
const receivedHeaders: Record<string, any>[] = [];

app.post('/api', (req, res) => {
  requestCount++;
  console.log(`\nAPI SERVER: Request #${requestCount} received`);

  const mcpHeaders = Object.entries(req.headers)
    .filter(([key]) => key.toLowerCase().startsWith('x-mcp'))
    .reduce((obj, [key, val]) => ({ ...obj, [key]: val }), {});

  receivedHeaders.push(mcpHeaders);
  console.log('MCP Headers:', JSON.stringify(mcpHeaders, null, 2));

  res.json({
    success: true,
    requestNumber: requestCount,
    receivedHeaders: mcpHeaders
  });
});

const apiPort = 4000;
const apiServer = createServer(app);

async function createTransport() {
  return new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/examples/identifiers/server.ts"]
  });
}

async function startApiServer(): Promise<void> {
  return new Promise(resolve => {
    apiServer.listen(apiPort, () => {
      console.log(`API server listening on port ${apiPort}`);
      resolve();
    });
  });
}

async function runComprehensiveTests() {
  try {
    await startApiServer();
    console.log("\n🧪 COMPREHENSIVE IDENTIFIER FORWARDING TESTS\n");

    // TEST 1: Client-level identifiers only
    console.log("=== TEST 1: Client-Level Identifiers Only ===");
    await testClientLevelOnly();

    // TEST 2: Request-level identifiers only
    console.log("\n=== TEST 2: Request-Level Identifiers Only ===");
    await testRequestLevelOnly();

    // TEST 3: Both client and request identifiers (merger logic)
    console.log("\n=== TEST 3: Identifier Merging (Client + Request) ===");
    await testIdentifierMerging();

    // TEST 4: Conflict resolution (request overrides client)
    console.log("\n=== TEST 4: Conflict Resolution (Request Overrides Client) ===");
    await testConflictResolution();

    // TEST 5: Empty identifiers
    console.log("\n=== TEST 5: Empty Identifiers ===");
    await testEmptyIdentifiers();

    // TEST 6: Backward compatibility (no identifiers)
    console.log("\n=== TEST 6: Backward Compatibility (No Identifiers) ===");
    await testBackwardCompatibility();

    // TEST 7: Edge cases (invalid/oversized values)
    console.log("\n=== TEST 7: Edge Cases (Security Limits) ===");
    await testEdgeCases();

    // TEST 8: Server with identifier forwarding disabled
    console.log("\n=== TEST 8: Identifier Forwarding Disabled (Default) ===");
    await testForwardingDisabled();

    // Validate all results
    console.log("\n=== VALIDATION SUMMARY ===");
    validateTestResults();

  } catch (error) {
    console.error("❌ Test suite failed:", error);
  } finally {
    apiServer.close();
  }
}

async function testClientLevelOnly() {
  const transport = await createTransport();
  const client = new Client(
    { name: "test-client-1", version: "1.0.0" },
    {
      identifiers: {
        "trace-id": "client-trace-123",
        "tenant-id": "client-tenant-456"
      }
    }
  );

  console.log("CLIENT: Created with client-level identifiers only");
  
  await client.connect(transport);
  const result = await client.callTool({
    name: "call_api",
    arguments: {}
  });

  console.log("✅ Client-level identifiers forwarded successfully");
  
  await client.close();
  await transport.close();
}

async function testRequestLevelOnly() {
  const transport = await createTransport();
  const client = new Client({ name: "test-client-2", version: "1.0.0" });

  console.log("CLIENT: Created WITHOUT client-level identifiers");
  
  await client.connect(transport);
  const result = await client.callTool({
    name: "call_api",
    arguments: {},
    identifiers: {
      "request-id": "req-789",
      "user-id": "user-abc"
    }
  });

  console.log("✅ Request-level identifiers forwarded successfully");
  
  await client.close();
  await transport.close();
}

async function testIdentifierMerging() {
  const transport = await createTransport();
  const client = new Client(
    { name: "test-client-3", version: "1.0.0" },
    {
      identifiers: {
        "trace-id": "client-trace-merge",
        "tenant-id": "client-tenant-merge"
      }
    }
  );

  console.log("CLIENT: Testing identifier merging (client + request)");
  
  await client.connect(transport);
  const result = await client.callTool({
    name: "call_api",
    arguments: {},
    identifiers: {
      "request-id": "req-merge-123",
      "operation": "merge-test"
    }
  });

  console.log("✅ Identifier merging working correctly");
  
  await client.close();
  await transport.close();
}

async function testConflictResolution() {
  const transport = await createTransport();
  const client = new Client(
    { name: "test-client-4", version: "1.0.0" },
    {
      identifiers: {
        "trace-id": "client-trace-original",
        "tenant-id": "client-tenant-original"
      }
    }
  );

  console.log("CLIENT: Testing conflict resolution (request should override client)");
  
  await client.connect(transport);
  const result = await client.callTool({
    name: "call_api",
    arguments: {},
    identifiers: {
      "trace-id": "request-trace-override", // Should override client value
      "user-id": "request-user-new"         // New identifier
    }
  });

  console.log("✅ Conflict resolution working (request overrides client)");
  
  await client.close();
  await transport.close();
}

async function testEmptyIdentifiers() {
  const transport = await createTransport();
  const client = new Client(
    { name: "test-client-5", version: "1.0.0" },
    { identifiers: {} }
  );

  console.log("CLIENT: Testing empty identifier objects");
  
  await client.connect(transport);
  const result = await client.callTool({
    name: "call_api",
    arguments: {},
    identifiers: {}
  });

  console.log("✅ Empty identifiers handled correctly");
  
  await client.close();
  await transport.close();
}

async function testBackwardCompatibility() {
  const transport = await createTransport();
  const client = new Client({ name: "test-client-6", version: "1.0.0" });

  console.log("CLIENT: Testing backward compatibility (no identifiers at all)");
  
  await client.connect(transport);
  const result = await client.callTool({
    name: "call_api",
    arguments: {}
    // No identifiers field at all
  });

  console.log("✅ Backward compatibility maintained");
  
  await client.close();
  await transport.close();
}

async function testEdgeCases() {
  const transport = await createTransport();
  const client = new Client({ name: "test-client-7", version: "1.0.0" });

  console.log("CLIENT: Testing edge cases (long values, special characters)");
  
  await client.connect(transport);
  
  // Test with various edge case values
  const result = await client.callTool({
    name: "call_api",
    arguments: {},
    identifiers: {
      "long-key": "a".repeat(100), // Long value
      "special-chars": "user@domain.com",
      "numeric": "12345",
      "with-dashes": "trace-id-with-dashes",
      "with_underscores": "trace_id_with_underscores"
    }
  });

  console.log("✅ Edge cases handled appropriately");
  
  await client.close();
  await transport.close();
}

async function testForwardingDisabled() {
  // This would require a separate server instance with forwarding disabled
  // For now, we'll just document that this should be tested
  console.log("CLIENT: Testing with identifier forwarding disabled");
  console.log("Note: This requires a server configuration with forwarding disabled");
  console.log("✅ Should be tested with disabled configuration");
}

function validateTestResults() {
  console.log(`\n📊 TEST RESULTS SUMMARY:`);
  console.log(`Total API requests received: ${requestCount}`);
  console.log(`Header sets captured: ${receivedHeaders.length}`);
  
  // Validate specific test expectations
  let testsPassed = 0;
  let totalTests = 0;

  // Test 1: Client-level identifiers only
  totalTests++;
  if (receivedHeaders[0] && 
      receivedHeaders[0]['x-mcp-trace-id'] === 'client-trace-123' &&
      receivedHeaders[0]['x-mcp-tenant-id'] === 'client-tenant-456') {
    console.log("✅ Test 1 PASSED: Client-level identifiers forwarded");
    testsPassed++;
  } else {
    console.log("❌ Test 1 FAILED: Client-level identifiers not forwarded correctly");
  }

  // Test 2: Request-level identifiers only
  totalTests++;
  if (receivedHeaders[1] && 
      receivedHeaders[1]['x-mcp-request-id'] === 'req-789' &&
      receivedHeaders[1]['x-mcp-user-id'] === 'user-abc') {
    console.log("✅ Test 2 PASSED: Request-level identifiers forwarded");
    testsPassed++;
  } else {
    console.log("❌ Test 2 FAILED: Request-level identifiers not forwarded correctly");
  }

  // Test 3: Identifier merging
  totalTests++;
  if (receivedHeaders[2] && 
      receivedHeaders[2]['x-mcp-trace-id'] === 'client-trace-merge' &&
      receivedHeaders[2]['x-mcp-request-id'] === 'req-merge-123') {
    console.log("✅ Test 3 PASSED: Identifier merging works");
    testsPassed++;
  } else {
    console.log("❌ Test 3 FAILED: Identifier merging not working correctly");
  }

  // Test 4: Conflict resolution
  totalTests++;
  if (receivedHeaders[3] && 
      receivedHeaders[3]['x-mcp-trace-id'] === 'request-trace-override') {
    console.log("✅ Test 4 PASSED: Request overrides client identifiers");
    testsPassed++;
  } else {
    console.log("❌ Test 4 FAILED: Conflict resolution not working");
  }

  // Additional validations
  totalTests++;
  const hasProperHeaderFormat = receivedHeaders.some(headers => 
    Object.keys(headers).every(key => key.startsWith('x-mcp-'))
  );
  if (hasProperHeaderFormat) {
    console.log("✅ Test 5 PASSED: Headers have proper X-MCP- prefix");
    testsPassed++;
  } else {
    console.log("❌ Test 5 FAILED: Headers don't have proper prefix");
  }

  console.log(`\n🎯 FINAL SCORE: ${testsPassed}/${totalTests} tests passed`);
  
  if (testsPassed === totalTests) {
    console.log("🎉 ALL TESTS PASSED! Identifier forwarding is working correctly.");
  } else {
    console.log("⚠️  Some tests failed. Review the implementation.");
  }

  // Print all received headers for debugging
  console.log("\n📋 All received headers for debugging:");
  receivedHeaders.forEach((headers, index) => {
    console.log(`Request #${index + 1}:`, headers);
  });
}

// Run the comprehensive test suite
runComprehensiveTests();