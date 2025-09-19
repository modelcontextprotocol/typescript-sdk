import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Client } from '../client/index.js';
import { StreamableHTTPClientTransport } from '../client/streamableHttp.js';
import { McpServer } from '../server/mcp.js';
import { StreamableHTTPServerTransport } from '../server/streamableHttp.js';
import { CallToolResultSchema, LoggingMessageNotificationSchema } from '../types.js';
import { z } from 'zod';
import { InMemoryEventStore } from '../examples/shared/inMemoryEventStore.js';

describe('Transport resumability', () => {
    let server: Server;
    let mcpServer: McpServer;
    let serverTransport: StreamableHTTPServerTransport;
    let baseUrl: URL;
    let eventStore: InMemoryEventStore;

    beforeEach(async () => {
        // Create event store for resumability
        eventStore = new InMemoryEventStore();

        // Create a simple MCP server
        mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { logging: {} } });

        // Add a simple notification tool that completes quickly
        mcpServer.tool(
            'send-notification',
            'Sends a single notification',
            {
                message: z.string().describe('Message to send').default('Test notification')
            },
            async ({ message }, { sendNotification }) => {
                // Send notification immediately
                await sendNotification({
                    method: 'notifications/message',
                    params: {
                        level: 'info',
                        data: message
                    }
                });

                return {
                    content: [{ type: 'text', text: 'Notification sent' }]
                };
            }
        );

        // Add a long-running tool that sends multiple notifications
        mcpServer.tool(
            'run-notifications',
            'Sends multiple notifications over time',
            {
                count: z.number().describe('Number of notifications to send').default(10),
                interval: z.number().describe('Interval between notifications in ms').default(50)
            },
            async ({ count, interval }, { sendNotification }) => {
                // Send notifications at specified intervals
                for (let i = 0; i < count; i++) {
                    await sendNotification({
                        method: 'notifications/message',
                        params: {
                            level: 'info',
                            data: `Notification ${i + 1} of ${count}`
                        }
                    });

                    // Wait for the specified interval before sending next notification
                    if (i < count - 1) {
                        await new Promise(resolve => setTimeout(resolve, interval));
                    }
                }

                return {
                    content: [{ type: 'text', text: `Sent ${count} notifications` }]
                };
            }
        );

        // Create a transport with the event store
        serverTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            eventStore
        });

        // Connect the transport to the MCP server
        await mcpServer.connect(serverTransport);

        // Create and start an HTTP server
        server = createServer(async (req, res) => {
            await serverTransport.handleRequest(req, res);
        });

        // Start the server on a random port
        baseUrl = await new Promise<URL>(resolve => {
            server.listen(0, '127.0.0.1', () => {
                const addr = server.address() as AddressInfo;
                resolve(new URL(`http://127.0.0.1:${addr.port}`));
            });
        });
    });

    afterEach(async () => {
        // Clean up resources
        await mcpServer.close().catch(() => {});
        await serverTransport.close().catch(() => {});
        server.close();
    });

    it('should store session ID when client connects', async () => {
        // Create and connect a client
        const client = new Client({
            name: 'test-client',
            version: '1.0.0'
        });

        const transport = new StreamableHTTPClientTransport(baseUrl);
        await client.connect(transport);

        // Verify session ID was generated
        expect(transport.sessionId).toBeDefined();

        // Clean up
        await transport.close();
    });

    it('should have session ID functionality', async () => {
        // The ability to store a session ID when connecting
        const client = new Client({
            name: 'test-client-reconnection',
            version: '1.0.0'
        });

        const transport = new StreamableHTTPClientTransport(baseUrl);

        // Make sure the client can connect and get a session ID
        await client.connect(transport);
        expect(transport.sessionId).toBeDefined();

        // Clean up
        await transport.close();
    });

    // This test demonstrates the capability to resume long-running tools
    // across client disconnection/reconnection
    it('should resume long-running notifications with lastEventId', async () => {
        // Create unique client ID for this test
        const clientId = 'test-client-long-running';
        const notifications = [];
        let lastEventId: string | undefined;

        // Create first client
        const client1 = new Client({
            id: clientId,
            name: 'test-client',
            version: '1.0.0'
        });

        // Set up notification handler for first client
        client1.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
            if (notification.method === 'notifications/message') {
                notifications.push(notification.params);
            }
        });

        // Connect first client
        const transport1 = new StreamableHTTPClientTransport(baseUrl);
        await client1.connect(transport1);
        const sessionId = transport1.sessionId;
        expect(sessionId).toBeDefined();

        // Start a long-running notification stream with tracking of lastEventId
        const onLastEventIdUpdate = jest.fn((eventId: string) => {
            lastEventId = eventId;
        });
        expect(lastEventId).toBeUndefined();
        // Start the notification tool with event tracking using request
        const toolPromise = client1.request(
            {
                method: 'tools/call',
                params: {
                    name: 'run-notifications',
                    arguments: {
                        count: 3,
                        interval: 10
                    }
                }
            },
            CallToolResultSchema,
            {
                resumptionToken: lastEventId,
                onresumptiontoken: onLastEventIdUpdate
            }
        );

        // Wait for some notifications to arrive (not all) - shorter wait time
        await new Promise(resolve => setTimeout(resolve, 20));

        // Verify we received some notifications and lastEventId was updated
        expect(notifications.length).toBeGreaterThan(0);
        expect(notifications.length).toBeLessThan(4);
        expect(onLastEventIdUpdate).toHaveBeenCalled();
        expect(lastEventId).toBeDefined();

        // Disconnect first client without waiting for completion
        // When we close the connection, it will cause a ConnectionClosed error for
        // any in-progress requests, which is expected behavior
        await transport1.close();
        // Save the promise so we can catch it after closing
        const catchPromise = toolPromise.catch(err => {
            // This error is expected - the connection was intentionally closed
            if (err?.code !== -32000) {
                // ConnectionClosed error code
                console.error('Unexpected error type during transport close:', err);
            }
        });

        // Add a short delay to ensure clean disconnect before reconnecting
        await new Promise(resolve => setTimeout(resolve, 10));

        // Wait for the rejection to be handled
        await catchPromise;

        // Create second client with same client ID
        const client2 = new Client({
            id: clientId,
            name: 'test-client',
            version: '1.0.0'
        });

        // Set up notification handler for second client
        client2.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
            if (notification.method === 'notifications/message') {
                notifications.push(notification.params);
            }
        });

        // Connect second client with same session ID
        const transport2 = new StreamableHTTPClientTransport(baseUrl, {
            sessionId
        });
        await client2.connect(transport2);

        // Resume the notification stream using lastEventId
        // This is the key part - we're resuming the same long-running tool using lastEventId
        await client2.request(
            {
                method: 'tools/call',
                params: {
                    name: 'run-notifications',
                    arguments: {
                        count: 1,
                        interval: 5
                    }
                }
            },
            CallToolResultSchema,
            {
                resumptionToken: lastEventId, // Pass the lastEventId from the previous session
                onresumptiontoken: onLastEventIdUpdate
            }
        );

        // Verify we eventually received at leaset a few motifications
        expect(notifications.length).toBeGreaterThan(1);

        // Clean up
        await transport2.close();
    });
});
