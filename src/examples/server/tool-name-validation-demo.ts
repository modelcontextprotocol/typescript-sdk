#!/usr/bin/env tsx

/**
 * Demo script showcasing the consolidated tool name validation according to SEP: Specify Format for Tool Names
 * 
 * This demonstrates how the MCP TypeScript SDK now validates tool names and issues warnings
 * for non-conforming names while still allowing registration to proceed.
 * 
 * Key improvement: All validation issues are now consolidated into warnings only (no more double-logging).
 */

import { McpServer } from "../../server/mcp.js";

console.log("🔧 MCP Tool Name Validation Demo (Consolidated Warnings)");
console.log("========================================================\n");

// Create an MCP server
const server = new McpServer({
  name: "validation-demo-server",
  version: "1.0.0"
});

console.log("📝 Registering tools with various name patterns...\n");

// 1. Valid tool name (no warnings)
console.log("✅ Registering tool: 'getUser'");
server.registerTool("getUser", {
  title: "Get User",
  description: "Retrieve user information"
}, async () => ({
  content: [{ type: "text", text: "User data retrieved successfully" }]
}));

// 2. Valid tool name with warnings (starts with dash)
console.log("⚠️  Registering tool: '-warning-tool'");
server.registerTool("-warning-tool", {
  title: "Warning Tool",
  description: "A tool that generates warnings due to leading dash"
}, async () => ({
  content: [{ type: "text", text: "Warning tool executed" }]
}));

// 3. Valid tool name with warnings (ends with dot)
console.log("⚠️  Registering tool: 'admin.tools.'");
server.registerTool("admin.tools.", {
  title: "Admin Tools",
  description: "A tool that generates warnings due to trailing dot"
}, async () => ({
  content: [{ type: "text", text: "Admin tools executed" }]
}));

// 4. Invalid tool name (contains spaces) - now generates warnings, not errors
console.log("⚠️  Registering tool: 'invalid tool name'");
server.registerTool("invalid tool name", {
  title: "Invalid Tool",
  description: "A tool with an invalid name containing spaces"
}, async () => ({
  content: [{ type: "text", text: "Invalid tool executed" }]
}));

// 5. Invalid tool name (contains parentheses) - now generates warnings, not errors
console.log("⚠️  Registering tool: 'test (new api)'");
server.registerTool("test (new api)", {
  title: "Test API",
  description: "A tool with an invalid name containing parentheses"
}, async () => ({
  content: [{ type: "text", text: "Test API executed" }]
}));

// 6. Valid hierarchical tool name
console.log("✅ Registering tool: 'user/profile/update'");
server.registerTool("user/profile/update", {
  title: "Update User Profile",
  description: "A hierarchical tool name using forward slashes"
}, async () => ({
  content: [{ type: "text", text: "User profile updated successfully" }]
}));

// 7. Valid tool name with mixed characters
console.log("✅ Registering tool: 'DATA_EXPORT_v2.1'");
server.registerTool("DATA_EXPORT_v2.1", {
  title: "Data Export v2.1",
  description: "A tool name with mixed characters (underscores, dots, numbers)"
}, async () => ({
  content: [{ type: "text", text: "Data export completed" }]
}));

console.log("\n🎯 Tool registration completed!");
console.log("\n📊 Summary:");
console.log("   • Valid names: 3 tools registered without warnings");
console.log("   • Names with warnings: 4 tools registered with warnings");
console.log("   • No more double-logging or confusing error messages");
console.log("\n💡 Key improvements:");
console.log("   • All validation issues are now consolidated into warnings only");
console.log("   • No more confusion between warnings vs errors");
console.log("   • Cleaner, more consistent console output");
console.log("   • Tools still register successfully despite validation issues");
console.log("\n🔍 Check the console output above for the consolidated warning messages.");