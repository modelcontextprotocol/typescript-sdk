/**
 * Tool list changed notification example.
 *
 * Demonstrates how a client subscribes to `notifications/tools/list_changed`
 * and automatically refreshes its tool list when the server registers a new
 * tool after the connection is established.
 *
 * Uses InMemoryTransport so the example runs fully in-process — no server
 * process or network required.
 *
 * Expected output:
 *   [server] started with 1 tool: get_weather
 *   [client] connected. initial tools: [ 'get_weather' ]
 *   [server] registering new tool: get_forecast
 *   [client] tool list changed — updated tools: [ 'get_weather', 'get_forecast' ]
 *
 * Closes #1132
 */

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/core';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

async function main(): Promise<void> {
    // --- Server setup ---------------------------------------------------
    const server = new McpServer({ name: 'weather-server', version: '1.0.0' });

    server.registerTool(
        'get_weather',
        {
            description: 'Get current weather for a city',
            inputSchema: z.object({ city: z.string() })
        },
        async ({ city }) => ({ content: [{ type: 'text', text: `Sunny in ${city}` }] })
    );

    console.log('[server] started with 1 tool: get_weather');

    // --- Client setup ---------------------------------------------------
    // `listChanged.tools.onChanged` fires automatically whenever the server
    // sends `notifications/tools/list_changed`. The SDK re-fetches the full
    // tool list and passes it to `onChanged`.
    //
    // By default the client debounces list-changed notifications by 300 ms
    // (so rapid back-to-back registrations coalesce into a single refresh).
    // Here we set debounceMs: 0 so the callback fires immediately, which
    // keeps the example output predictable.
    let resolveChanged: () => void;
    const changedOnce = new Promise<void>(r => {
        resolveChanged = r;
    });

    const client = new Client(
        { name: 'weather-client', version: '1.0.0' },
        {
            listChanged: {
                tools: {
                    debounceMs: 0,
                    onChanged: (_error, tools) => {
                        if (_error) {
                            console.error('[client] error refreshing tools:', _error.message);
                            return;
                        }
                        const names = tools?.map(t => t.name) ?? [];
                        console.log('[client] tool list changed — updated tools:', names);
                        resolveChanged();
                    }
                }
            }
        }
    );

    // --- Connect via in-memory transport --------------------------------
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const { tools: initialTools } = await client.listTools();
    console.log(
        '[client] connected. initial tools:',
        initialTools.map(t => t.name)
    );

    // --- Dynamic tool registration --------------------------------------
    // Registering a tool AFTER connect fires sendToolListChanged() inside
    // McpServer, which pushes `notifications/tools/list_changed` to the
    // client. The `onChanged` callback above runs automatically.
    await new Promise<void>(resolve => setTimeout(resolve, 500));

    console.log('[server] registering new tool: get_forecast');
    server.registerTool(
        'get_forecast',
        {
            description: 'Get a 5-day weather forecast for a city',
            inputSchema: z.object({ city: z.string(), days: z.number().int().min(1).max(5).default(3) })
        },
        async ({ city, days }) => ({
            content: [{ type: 'text', text: `${days}-day forecast for ${city}: sunny throughout` }]
        })
    );

    // Wait for the onChanged callback to confirm the notification arrived
    // before closing the connection.
    await changedOnce;

    await client.close();
}

try {
    await main();
} catch (error) {
    console.error('Error running tool list changed example:', error);
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
}
