/**
 * Example showing the difference between regular types and strict types
 */

import { ToolSchema as OpenToolSchema } from "../types.js";
import { ToolSchema as StrictToolSchema } from "../strictTypes.js";

// With regular (open) types - this is valid
const openTool = OpenToolSchema.parse({
  name: "get-weather",
  description: "Get weather for a location",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string" }
    }
  },
  // Extra properties are allowed
  customField: "This is allowed in open types",
  anotherExtra: 123
});

console.log("Open tool accepts extra properties:", openTool);

// With strict types - this would throw an error
try {
  StrictToolSchema.parse({
    name: "get-weather",
    description: "Get weather for a location",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string" }
      }
    },
    // Extra properties cause validation to fail
    customField: "This is NOT allowed in strict types",
    anotherExtra: 123
  });
} catch (error) {
  console.log("Strict tool rejects extra properties:", error instanceof Error ? error.message : String(error));
}

// Correct usage with strict types
const strictToolCorrect = StrictToolSchema.parse({
  name: "get-weather",
  description: "Get weather for a location",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string" }
    }
  }
  // No extra properties
});

console.log("Strict tool with no extra properties:", strictToolCorrect);