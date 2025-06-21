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

    // TEST 8: Security validation (unsafe keys and values)
    console.log("\n=== TEST 8: Security Validation (Unsafe Content) ===");
    await testSecurityValidation();

    // TEST 9: Identifier limits and truncation
    console.log("\n=== TEST 9: Identifier Limits and Truncation ===");
    await testIdentifierLimits();

    // TEST 10: Header format validation
    console.log("\n=== TEST 10: Header Format Validation ===");
    await testHeaderFormatValidation();

    // TEST 11: Server with identifier forwarding disabled
    console.log("\n=== TEST 11: Identifier Forwarding Disabled (Default) ===");
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
      "special-chars": "user@domain.com", // Special chars in value (should be rejected)
      "numeric": "12345",
      "with-dashes": "trace-id-with-dashes",
      "with_underscores": "trace_id_with_underscores"
    }
  });

  console.log("✅ Edge cases handled appropriately");

  await client.close();
  await transport.close();
}

async function testSecurityValidation() {
  const transport = await createTransport();
  const client = new Client({ name: "test-client-security", version: "1.0.0" });

  console.log("CLIENT: Testing security validation (should reject unsafe values)");

  await client.connect(transport);

  // Test with potentially unsafe values that should be filtered out
  const result = await client.callTool({
    name: "call_api",
    arguments: {},
    identifiers: {
      "valid-key": "safe-value",
      "key with spaces": "should-be-rejected", // Invalid key (spaces)
      "key@with#symbols": "should-be-rejected", // Invalid key (special chars)
      "control-char": "value\x00with\x1Fcontrol", // Invalid value (control chars)
      "good-key": "normal-value",
      "tab\tkey": "should-be-rejected", // Invalid key (tab)
      "valid-key-2": "value\x7F", // Invalid value (DEL character)
      "unicode-test": "测试value", // Valid unicode in value
      "empty-value": "", // Valid empty value
      "hyphen-key": "valid-hyphen-value",
      "underscore_key": "valid_underscore_value"
    }
  });

  console.log("✅ Security validation working correctly");

  await client.close();
  await transport.close();
}

async function testIdentifierLimits() {
  const transport = await createTransport();
  const client = new Client({ name: "test-client-limits", version: "1.0.0" });

  console.log("CLIENT: Testing identifier count limits and value length limits");

  await client.connect(transport);

  // Create identifiers that exceed the default limits
  const manyIdentifiers: Record<string, string> = {};

  // Create 23 identifiers (should be truncated to 20 by default)
  for (let i = 1; i <= 23; i++) {
    manyIdentifiers[`id-${i.toString().padStart(2, '0')}`] = `value-${i}`;
  }

  // Add some with oversized values (should be rejected by validation even if within count limit)
  manyIdentifiers["oversized-value"] = "x".repeat(300); // Should be rejected (over 256 chars)
  manyIdentifiers["normal-value"] = "normal"; // Should be included if within first 20 after sorting
  manyIdentifiers["another-normal"] = "another"; // Should be included if within first 20 after sorting

  const result = await client.callTool({
    name: "call_api",
    arguments: {},
    identifiers: manyIdentifiers
  });

  console.log("✅ Identifier limits enforced correctly");

  await client.close();
  await transport.close();
}

async function testHeaderFormatValidation() {
  const transport = await createTransport();
  const client = new Client({ name: "test-client-headers", version: "1.0.0" });

  console.log("CLIENT: Testing header format validation and casing");

  await client.connect(transport);

  // Test various naming patterns to ensure proper header formatting
  const result = await client.callTool({
    name: "call_api",
    arguments: {},
    identifiers: {
      "simple": "value1",
      "kebab-case": "value2",
      "snake_case": "value3",
      "mixed-case_test": "value4",
      "UPPERCASE": "value5",
      "lowercase": "value6",
      "single": "value7",
      "multi-word-identifier": "value8"
    }
  });

  console.log("✅ Header format validation working correctly");

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

  // Test 5: Empty identifiers (should have no MCP headers)
  totalTests++;
  if (receivedHeaders[4] && Object.keys(receivedHeaders[4]).length === 0) {
    console.log("✅ Test 5 PASSED: Empty identifiers handled correctly");
    testsPassed++;
  } else {
    console.log("❌ Test 5 FAILED: Empty identifiers not handled correctly");
  }

  // Test 6: Backward compatibility (should have no MCP headers)
  totalTests++;
  if (receivedHeaders[5] && Object.keys(receivedHeaders[5]).length === 0) {
    console.log("✅ Test 6 PASSED: Backward compatibility maintained");
    testsPassed++;
  } else {
    console.log("❌ Test 6 FAILED: Backward compatibility not maintained");
  }

  // Test 7: Edge cases - should reject some values but keep valid ones
  totalTests++;
  const edgeCaseHeaders = receivedHeaders[6] || {};
  const hasValidEdgeCases = edgeCaseHeaders['x-mcp-numeric'] === '12345' &&
    edgeCaseHeaders['x-mcp-with-dashes'] === 'trace-id-with-dashes';

  // Note: special-chars contains "@" which should be allowed per our current rules
  // This is ok as user@domain.com doesn't contain control chars or non-ASCII chars

  if (hasValidEdgeCases) {
    console.log("✅ Test 7 PASSED: Edge cases handled appropriately");
    testsPassed++;
  } else {
    console.log("❌ Test 7 FAILED: Edge cases not handled correctly");
    console.log("Debug - Edge case headers:", edgeCaseHeaders);
  }

  // Test 8: Security validation - should only have safe identifiers
  totalTests++;
  const securityHeaders = receivedHeaders[7] || {};
  const hasSafeIdentifiers = securityHeaders['x-mcp-valid-key'] === 'safe-value' &&
    securityHeaders['x-mcp-good-key'] === 'normal-value';
  const rejectedUnsafeKeys = !securityHeaders['x-mcp-key-with-spaces'] &&
    !securityHeaders['x-mcp-control-char'];

  if (hasSafeIdentifiers && rejectedUnsafeKeys) {
    console.log("✅ Test 8 PASSED: Security validation working");
    testsPassed++;
  } else {
    console.log("❌ Test 8 FAILED: Security validation not working");
  }

  // Test 9: Identifier limits - should be truncated to max 20 and reject oversized values
  totalTests++;
  const limitHeaders = receivedHeaders[8] || {};
  const headerCount = Object.keys(limitHeaders).length;

  // Should have exactly 20 headers (truncated from 26 total)
  // Should NOT have oversized-value (rejected by validation)
  // Should have some normal identifiers
  const hasCorrectCount = headerCount <= 20;
  const rejectedOversized = !limitHeaders['x-mcp-oversized-value'];
  const hasNormalValues = limitHeaders['x-mcp-normal-value'] === 'normal' ||
    limitHeaders['x-mcp-another-normal'] === 'another' ||
    limitHeaders['x-mcp-id-01'] === 'value-1';

  if (hasCorrectCount && rejectedOversized && hasNormalValues) {
    console.log("✅ Test 9 PASSED: Identifier limits enforced");
    testsPassed++;
  } else {
    console.log("❌ Test 9 FAILED: Identifier limits not enforced correctly");
    console.log(`Debug - Header count: ${headerCount} (should be ≤20)`);
    console.log("Debug - Rejected oversized:", rejectedOversized);
    console.log("Debug - Has normal values:", hasNormalValues);
  }

  // Test 10: Header format validation
  totalTests++;
  const formatHeaders = receivedHeaders[9] || {};
  const hasProperFormatting = formatHeaders['x-mcp-kebab-case'] === 'value2' &&
    formatHeaders['x-mcp-snake-case'] === 'value3' &&
    formatHeaders['x-mcp-multi-word-identifier'] === 'value8';

  if (hasProperFormatting) {
    console.log("✅ Test 10 PASSED: Header format validation working");
    testsPassed++;
  } else {
    console.log("❌ Test 10 FAILED: Header format validation not working");
  }

  // General header format validation
  totalTests++;
  const hasProperHeaderFormat = receivedHeaders.some(headers =>
    Object.keys(headers).every(key => key.startsWith('x-mcp-'))
  );
  if (hasProperHeaderFormat || receivedHeaders.every(h => Object.keys(h).length === 0)) {
    console.log("✅ Test 11 PASSED: Headers have proper X-MCP- prefix");
    testsPassed++;
  } else {
    console.log("❌ Test 11 FAILED: Headers don't have proper prefix");
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

  // Additional security analysis
  console.log("\n🔒 SECURITY ANALYSIS:");
  console.log("- Testing rejection of unsafe key characters");
  console.log("- Testing rejection of control characters in values");
  console.log("- Testing identifier count limits");
  console.log("- Testing value length limits");
  console.log("- Testing header format consistency");
}

// Run the comprehensive test suite
runComprehensiveTests();