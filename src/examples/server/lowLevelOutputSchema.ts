#!/usr/bin/env node
/**
 * Example MCP server demonstrating tool outputSchema support using the low-level Server API
 * This server manually handles tool listing and invocation requests to return structured data
 * For a simpler high-level API approach, see mcpServerOutputSchema.ts
 */

import { Server } from "../../server/index.js";
import { StdioServerTransport } from "../../server/stdio.js";
import { CallToolRequest, CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "../../types.js";

const server = new Server(
  {
    name: "output-schema-low-level-example",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool with structured output
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_weather",
      description: "Get weather information for a city",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name" },
          country: { type: "string", description: "Country code (e.g., US, UK)" }
        },
        required: ["city", "country"]
      },
      outputSchema: {
        type: "object",
        properties: {
          temperature: {
            type: "object",
            properties: {
              celsius: { type: "number" },
              fahrenheit: { type: "number" }
            },
            required: ["celsius", "fahrenheit"]
          },
          conditions: {
            type: "string",
            enum: ["sunny", "cloudy", "rainy", "stormy", "snowy"]
          },
          humidity: { type: "number", minimum: 0, maximum: 100 },
          wind: {
            type: "object",
            properties: {
              speed_kmh: { type: "number" },
              direction: { type: "string" }
            },
            required: ["speed_kmh", "direction"]
          }
        },
        required: ["temperature", "conditions", "humidity", "wind"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  switch (request.params.name) {
    case "get_weather": {
      const { city, country } = request.params.arguments as { city: string; country: string };

      // Parameters are available but not used in this example
      void city;
      void country;

      // Simulate weather API call
      const temp_c = Math.round((Math.random() * 35 - 5) * 10) / 10;
      const conditions = ["sunny", "cloudy", "rainy", "stormy", "snowy"][Math.floor(Math.random() * 5)];

      // Return structured content matching the outputSchema
      return {
        structuredContent: {
          temperature: {
            celsius: temp_c,
            fahrenheit: Math.round((temp_c * 9/5 + 32) * 10) / 10
          },
          conditions,
          humidity: Math.round(Math.random() * 100),
          wind: {
            speed_kmh: Math.round(Math.random() * 50),
            direction: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.floor(Math.random() * 8)]
          }
        }
      };
    }

    default:
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${request.params.name}`
      );
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Low-level Output Schema Example Server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});