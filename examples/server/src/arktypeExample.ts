#!/usr/bin/env node
/**
 * Example MCP server using ArkType for schema validation
 * This demonstrates how to use ArkType schemas with the MCP SDK's
 * StandardJSONSchemaV1 support for tool input/output schemas.
 *
 * ArkType implements the Standard Schema spec and provides built-in
 * JSON Schema conversion via toJsonSchema().
 */

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { type } from 'arktype';

const server = new McpServer({
    name: 'mcp-arktype-example',
    version: '1.0.0'
});

// Define schemas using ArkType
const weatherInputSchema = type({
    city: 'string',
    country: 'string'
});

const weatherOutputSchema = type({
    temperature: {
        celsius: 'number',
        fahrenheit: 'number'
    },
    conditions: "'sunny' | 'cloudy' | 'rainy' | 'stormy' | 'snowy'",
    humidity: 'number',
    wind: {
        speed_kmh: 'number',
        direction: 'string'
    }
});

// Register a tool with ArkType schemas
server.registerTool(
    'get_weather',
    {
        description: 'Get weather information for a city (using ArkType validation)',
        inputSchema: weatherInputSchema,
        outputSchema: weatherOutputSchema
    },
    async ({ city, country }) => {
        console.error(`Getting weather for ${city}, ${country}`);

        // Simulate weather API call
        const temp_c = Math.round((Math.random() * 35 - 5) * 10) / 10;
        const conditions = ['sunny', 'cloudy', 'rainy', 'stormy', 'snowy'][
            Math.floor(Math.random() * 5)
        ] as 'sunny' | 'cloudy' | 'rainy' | 'stormy' | 'snowy';

        const structuredContent = {
            temperature: {
                celsius: temp_c,
                fahrenheit: Math.round(((temp_c * 9) / 5 + 32) * 10) / 10
            },
            conditions,
            humidity: Math.round(Math.random() * 100),
            wind: {
                speed_kmh: Math.round(Math.random() * 50),
                direction: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.floor(Math.random() * 8)]!
            }
        };

        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(structuredContent, null, 2)
                }
            ],
            structuredContent
        };
    }
);

// Another tool example - calculator
const calcInputSchema = type({
    operation: "'add' | 'subtract' | 'multiply' | 'divide'",
    a: 'number',
    b: 'number'
});

const calcOutputSchema = type({
    result: 'number',
    operation: 'string',
    expression: 'string'
});

server.registerTool(
    'calculate',
    {
        description: 'Perform basic arithmetic operations (using ArkType validation)',
        inputSchema: calcInputSchema,
        outputSchema: calcOutputSchema
    },
    async ({ operation, a, b }) => {
        let result: number;
        switch (operation) {
            case 'add':
                result = a + b;
                break;
            case 'subtract':
                result = a - b;
                break;
            case 'multiply':
                result = a * b;
                break;
            case 'divide':
                if (b === 0) {
                    return {
                        content: [{ type: 'text', text: 'Error: Division by zero' }],
                        isError: true
                    };
                }
                result = a / b;
                break;
        }

        const structuredContent = {
            result,
            operation,
            expression: `${a} ${operation} ${b} = ${result}`
        };

        return {
            content: [
                {
                    type: 'text',
                    text: structuredContent.expression
                }
            ],
            structuredContent
        };
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('ArkType Example Server running on stdio');
}

try {
    await main();
} catch (error) {
    console.error('Server error:', error);
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
}
