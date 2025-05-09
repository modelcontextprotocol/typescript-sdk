#!/usr/bin/env node
/**
 * Example MCP server using the high-level McpServer API with outputSchema
 * This demonstrates how to easily create tools with structured output
 */

import { McpServer } from "../../server/mcp.js";
import { StdioServerTransport } from "../../server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  {
    name: "mcp-output-schema-example",
    version: "1.0.0",
  }
);

// Define a tool with structured output - Weather data
server.tool(
  "get_weather",
  "Get weather information for a city",
  {
    city: z.string().describe("City name"),
    country: z.string().describe("Country code (e.g., US, UK)")
  },
  {
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
  },
  async ({ city, country }: { city: string; country: string }) => {
    // Parameters are available but not used in this example
    void city;
    void country;
    // Simulate weather API call
    const temp_c = Math.round((Math.random() * 35 - 5) * 10) / 10;
    const conditions = ["sunny", "cloudy", "rainy", "stormy", "snowy"][Math.floor(Math.random() * 5)];
    
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
);

// Define a tool for data processing with structured output
server.tool(
  "process_csv",
  "Process CSV data and return statistics",
  {
    csv_data: z.string().describe("CSV data as a string"),
    delimiter: z.string().default(",").describe("CSV delimiter")
  },
  {
    type: "object",
    properties: {
      row_count: { type: "integer" },
      column_count: { type: "integer" },
      headers: {
        type: "array",
        items: { type: "string" }
      },
      data_types: {
        type: "object",
        additionalProperties: { 
          type: "string",
          enum: ["number", "string", "date", "boolean"]
        }
      },
      summary: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            min: { type: "number" },
            max: { type: "number" },
            mean: { type: "number" },
            count: { type: "integer" }
          }
        }
      }
    },
    required: ["row_count", "column_count", "headers", "data_types"]
  },
  async ({ csv_data, delimiter }) => {
    const lines = csv_data.trim().split('\n');
    const headers = lines[0].split(delimiter).map(h => h.trim());
    const data = lines.slice(1).map(line => line.split(delimiter).map(cell => cell.trim()));
    
    // Infer data types
    const dataTypes: { [key: string]: string } = {};
    const summary: { [key: string]: unknown } = {};
    
    headers.forEach((header, idx) => {
      const values = data.map(row => row[idx]);
      const numericValues = values.filter(v => !isNaN(Number(v)) && v !== '');
      
      if (numericValues.length === values.length) {
        dataTypes[header] = "number";
        const numbers = numericValues.map(Number);
        summary[header] = {
          min: Math.min(...numbers),
          max: Math.max(...numbers),
          mean: numbers.reduce((a, b) => a + b, 0) / numbers.length,
          count: numbers.length
        };
      } else {
        dataTypes[header] = "string";
      }
    });
    
    return {
      structuredContent: {
        row_count: data.length,
        column_count: headers.length,
        headers,
        data_types: dataTypes,
        summary
      }
    };
  }
);

// Traditional tool without outputSchema for comparison
server.tool(
  "echo",
  "Echo back the input message",
  {
    message: z.string()
  },
  async ({ message }) => {
    return {
      content: [
        {
          type: "text",
          text: `Echo: ${message}`
        }
      ]
    };
  }
);

// Tool that can return both structured and unstructured content
server.tool(
  "hybrid_tool", 
  "Tool that returns both structured and readable content",
  {
    data: z.array(z.number()).describe("Array of numbers to analyze")
  },
  {
    type: "object",
    properties: {
      stats: {
        type: "object",
        properties: {
          mean: { type: "number" },
          median: { type: "number" },
          std_dev: { type: "number" }
        }
      }
    },
    required: ["stats"]
  },
  async ({ data }) => {
    const mean = data.reduce((a, b) => a + b, 0) / data.length;
    const sorted = [...data].sort((a, b) => a - b);
    const median = sorted.length % 2 === 0 
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];
    const variance = data.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / data.length;
    const std_dev = Math.sqrt(variance);
    
    return {
      structuredContent: {
        stats: {
          mean: Math.round(mean * 100) / 100,
          median: Math.round(median * 100) / 100,
          std_dev: Math.round(std_dev * 100) / 100
        }
      },
      // Also provide human-readable content for backward compatibility
      content: [
        {
          type: "text",
          text: `Analysis of ${data.length} numbers:
- Mean: ${Math.round(mean * 100) / 100}
- Median: ${Math.round(median * 100) / 100}
- Standard Deviation: ${Math.round(std_dev * 100) / 100}`
        }
      ]
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("McpServer Output Schema Example running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});