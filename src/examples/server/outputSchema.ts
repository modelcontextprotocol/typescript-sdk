#!/usr/bin/env node
/**
 * Example MCP server demonstrating tool outputSchema support
 * This server exposes tools that return structured data
 */

import { Server } from "../../server/index.js";
import { StdioServerTransport } from "../../server/stdio.js";
import { CallToolRequest, CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "../../types.js";

const server = new Server(
  {
    name: "output-schema-example",
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
      name: "calculate_bmi",
      description: "Calculate BMI given height and weight",
      inputSchema: {
        type: "object",
        properties: {
          height_cm: { type: "number", description: "Height in centimeters" },
          weight_kg: { type: "number", description: "Weight in kilograms" }
        },
        required: ["height_cm", "weight_kg"]
      },
      outputSchema: {
        type: "object",
        properties: {
          bmi: { type: "number", description: "Body Mass Index" },
          category: { 
            type: "string", 
            enum: ["underweight", "normal", "overweight", "obese"],
            description: "BMI category"
          },
          healthy_weight_range: {
            type: "object",
            properties: {
              min_kg: { type: "number" },
              max_kg: { type: "number" }
            },
            required: ["min_kg", "max_kg"]
          }
        },
        required: ["bmi", "category", "healthy_weight_range"]
      }
    },
    {
      name: "analyze_text",
      description: "Analyze text and return structured insights",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to analyze" }
        },
        required: ["text"]
      },
      outputSchema: {
        type: "object",
        properties: {
          word_count: { type: "integer" },
          sentence_count: { type: "integer" },
          character_count: { type: "integer" },
          reading_time_minutes: { type: "number" },
          sentiment: {
            type: "string",
            enum: ["positive", "negative", "neutral"]
          },
          key_phrases: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["word_count", "sentence_count", "character_count", "reading_time_minutes"]
      }
    },
    {
      name: "traditional_tool",
      description: "A traditional tool without outputSchema",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" }
        },
        required: ["message"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  switch (request.params.name) {
    case "calculate_bmi": {
      const { height_cm, weight_kg } = request.params.arguments as { height_cm: number; weight_kg: number };
      
      const height_m = height_cm / 100;
      const bmi = weight_kg / (height_m * height_m);
      
      let category: string;
      if (bmi < 18.5) category = "underweight";
      else if (bmi < 25) category = "normal";
      else if (bmi < 30) category = "overweight";
      else category = "obese";
      
      // Calculate healthy weight range for normal BMI (18.5-24.9)
      const min_healthy_bmi = 18.5;
      const max_healthy_bmi = 24.9;
      const min_healthy_weight = min_healthy_bmi * height_m * height_m;
      const max_healthy_weight = max_healthy_bmi * height_m * height_m;
      
      // Return structured content matching the outputSchema
      return {
        structuredContent: {
          bmi: Math.round(bmi * 10) / 10,
          category,
          healthy_weight_range: {
            min_kg: Math.round(min_healthy_weight * 10) / 10,
            max_kg: Math.round(max_healthy_weight * 10) / 10
          }
        }
      };
    }
    
    case "analyze_text": {
      const { text } = request.params.arguments as { text: string };
      
      // Simple text analysis
      const words = text.trim().split(/\s+/);
      const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
      const wordsPerMinute = 200; // Average reading speed
      
      // Very simple sentiment analysis (for demo purposes)
      const positiveWords = ["good", "great", "excellent", "happy", "positive", "amazing"];
      const negativeWords = ["bad", "poor", "terrible", "sad", "negative", "awful"];
      
      let positiveCount = 0;
      let negativeCount = 0;
      words.forEach(word => {
        if (positiveWords.includes(word.toLowerCase())) positiveCount++;
        if (negativeWords.includes(word.toLowerCase())) negativeCount++;
      });
      
      let sentiment: string;
      if (positiveCount > negativeCount) sentiment = "positive";
      else if (negativeCount > positiveCount) sentiment = "negative";
      else sentiment = "neutral";
      
      // Extract key phrases (simple approach - just common bigrams)
      const keyPhrases: string[] = [];
      for (let i = 0; i < words.length - 1; i++) {
        if (words[i].length > 3 && words[i + 1].length > 3) {
          keyPhrases.push(`${words[i]} ${words[i + 1]}`);
        }
      }
      
      return {
        structuredContent: {
          word_count: words.length,
          sentence_count: sentences.length,
          character_count: text.length,
          reading_time_minutes: Math.round((words.length / wordsPerMinute) * 10) / 10,
          sentiment,
          key_phrases: keyPhrases.slice(0, 5) // Top 5 phrases
        }
      };
    }
    
    case "traditional_tool": {
      const { message } = request.params.arguments as { message: string };
      
      // Traditional tool returns content array
      return {
        content: [
          { 
            type: "text", 
            text: `Processed message: ${message.toUpperCase()}` 
          }
        ]
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
  console.error("Output Schema Example Server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});