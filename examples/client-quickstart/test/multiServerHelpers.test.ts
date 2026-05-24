import type { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import {
    getClientForTool,
    registerToolsForClient
} from '../src/multiServerHelpers.js';

describe('multiServerHelpers', () => {
    it('registers tool names to their owning client', () => {
        const client = { name: 'server-a' } as unknown as Client;
        const toolToClient = new Map<string, Client>();
        const [registeredTool] = registerToolsForClient(
            client,
            [
                {
                    name: 'forecast',
                    description: 'Look up a forecast by city.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            city: { type: 'string' }
                        }
                    }
                }
            ],
            toolToClient
        );

        expect(registeredTool).toEqual({
            client,
            tool: {
                name: 'forecast',
                description: 'Look up a forecast by city.',
                input_schema: {
                    type: 'object',
                    properties: {
                        city: { type: 'string' }
                    }
                }
            }
        });
        expect(getClientForTool('forecast', toolToClient)).toBe(client);
    });

    it('rejects duplicate tool names across clients', () => {
        const toolToClient = new Map<string, Client>();
        const tools = [
            {
                name: 'forecast',
                inputSchema: { type: 'object' }
            }
        ];

        registerToolsForClient({ name: 'server-a' } as unknown as Client, tools, toolToClient);

        expect(() =>
            registerToolsForClient({ name: 'server-b' } as unknown as Client, tools, toolToClient)
        ).toThrow('Duplicate tool name "forecast" found across MCP servers.');
    });
});
