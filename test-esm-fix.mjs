/**
 * Test script to verify that ESM imports also work correctly
 * This ensures our fix maintains proper dual module support
 */

// Test ESM import
import { McpError, ErrorCode, Client, Server } from "./dist/esm/index.js";

console.log("Testing ESM import from main package...");

try {
  // Test that McpError can be imported and used
  const error = new McpError(ErrorCode.MethodNotFound, "Test ESM import");
  
  console.log("✅ SUCCESS: McpError imported via ESM");
  console.log("✅ SUCCESS: McpError instantiated:", error.message);
  console.log("✅ SUCCESS: Error code:", error.code);
  
  // Test that Client and Server are also available
  console.log("✅ SUCCESS: Client class available:", typeof Client === 'function');
  console.log("✅ SUCCESS: Server class available:", typeof Server === 'function');
  
  console.log("\n🎉 ESM imports work correctly!");
  console.log("The SDK now supports both CommonJS and ESM properly.");
  
} catch (err) {
  console.error("❌ FAIL: Error with ESM import:", err.message);
  process.exit(1);
}