#!/usr/bin/env node
/**
 * Example MCP server using Valibot for schema validation
 * This demonstrates how to use Valibot schemas with the MCP SDK's
 * StandardJSONSchemaV1 support for tool input/output schemas.
 *
 * Valibot implements the Standard Schema spec. Use toStandardJsonSchema()
 * from @valibot/to-json-schema to create StandardJSONSchemaV1-compliant schemas.
 */

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

const server = new McpServer({
    name: 'mcp-valibot-example',
    version: '1.0.0'
});

// Define schemas using Valibot and wrap with toStandardJsonSchema
const weatherInputSchema = toStandardJsonSchema(
    v.object({
        city: v.pipe(v.string(), v.description('City name')),
        country: v.pipe(v.string(), v.description('Country code (e.g., US, UK)'))
    })
);

const weatherOutputSchema = toStandardJsonSchema(
    v.object({
        temperature: v.object({
            celsius: v.number(),
            fahrenheit: v.number()
        }),
        conditions: v.picklist(['sunny', 'cloudy', 'rainy', 'stormy', 'snowy']),
        humidity: v.pipe(v.number(), v.minValue(0), v.maxValue(100)),
        wind: v.object({
            speed_kmh: v.number(),
            direction: v.string()
        })
    })
);

// Register a tool with Valibot schemas
server.registerTool(
    'get_weather',
    {
        description: 'Get weather information for a city (using Valibot validation)',
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
const calcInputSchema = toStandardJsonSchema(
    v.object({
        operation: v.picklist(['add', 'subtract', 'multiply', 'divide']),
        a: v.number(),
        b: v.number()
    })
);

const calcOutputSchema = toStandardJsonSchema(
    v.object({
        result: v.number(),
        operation: v.string(),
        expression: v.string()
    })
);

server.registerTool(
    'calculate',
    {
        description: 'Perform basic arithmetic operations (using Valibot validation)',
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
    console.error('Valibot Example Server running on stdio');
}

try {
    await main();
} catch (error) {
    console.error('Server error:', error);
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
}
