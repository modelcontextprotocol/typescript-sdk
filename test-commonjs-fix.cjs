/**
 * Test script to verify that issue #971 is fixed
 * This tests the exact import that was failing before the fix
 */

// This is the CommonJS import that was failing in issue #971
const { McpError, ErrorCode } = require("./dist/cjs/index.js");

console.log("Testing CommonJS import from main package...");

try {
  // Test that McpError can be imported and used
  const error = new McpError(ErrorCode.InvalidRequest, "Test error for issue #971");
  
  console.log("✅ SUCCESS: McpError imported successfully");
  console.log("✅ SUCCESS: McpError instantiated:", error.message);
  console.log("✅ SUCCESS: Error code:", error.code);
  console.log("✅ SUCCESS: Error name:", error.name);
  
  // Verify the error is properly typed
  if (error instanceof Error && error instanceof McpError) {
    console.log("✅ SUCCESS: McpError inheritance works correctly");
  } else {
    console.log("❌ FAIL: McpError inheritance broken");
    process.exit(1);
  }
  
  console.log("\n🎉 Issue #971 has been RESOLVED!");
  console.log("Users can now import McpError from the main package without errors.");
  
} catch (err) {
  console.error("❌ FAIL: Error importing or using McpError:", err.message);
  process.exit(1);
}