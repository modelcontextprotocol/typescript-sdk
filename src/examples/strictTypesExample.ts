/**
 * Example showing the difference between extensible types and safe types
 * 
 * - Extensible types (types.js): Use .passthrough() - keep all fields
 * - Safe types (strictTypes.js): Use .strip() - remove unknown fields
 */

import { ToolSchema as ExtensibleToolSchema } from "../types.js";
import { ToolSchema } from "../strictTypes.js";

const toolData = {
  name: "get-weather",
  description: "Get weather for a location",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string" }
    }
  },
  // Extra properties that aren't in the schema
  customField: "This is an extension",
};

// With extensible types - ALL fields are preserved
const extensibleTool = ExtensibleToolSchema.parse(toolData);

console.log("Extensible tool keeps ALL properties:");
console.log("- name:", extensibleTool.name);
// Type assertion to access the extra field
console.log("- customField:", (extensibleTool as Record<string, unknown>).customField); // "This is an extension"

// With safe types - unknown fields are silently stripped
const safeTool = ToolSchema.parse(toolData);

console.log("\nSafe tool strips unknown properties:");
// Type assertion to check the field was removed
console.log("- customField:", (safeTool as Record<string, unknown>).customField); // undefined (stripped)
