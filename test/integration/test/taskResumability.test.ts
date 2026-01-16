import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { EventStore, JSONRPCMessage } from '@modelcontextprotocol/server';
import { CallToolResultSchema, LoggingMessageNotificationSchema, McpServer } from '@modelcontextprotocol/server';
import type { ZodMatrixEntry } from '@modelcontextprotocol/test-helpers';
import { listenOnRandomPort, zodTestMatrix } from '@modelcontextprotocol/test-helpers';

/**
 * Simple in-memory EventStore for testing resumability.
 */
class InMemoryEventStore implements EventStore {
    private events = new Map<string, { streamId: string; message: JSONRPCMessage }>();

    async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
        const eventId = `${streamId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        this.events.set(eventId, { streamId, message });
        return eventId;
    }

    async replayEventsAfter(
        lastEventId: string,
        { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }
    ): Promise<string> {
        if (!lastEventId || !this.events.has(lastEventId)) return '';
        const streamId = lastEventId.split('_')[0] ?? '';
        if (!streamId) return '';

        let found = false;
        const sorted = [...this.events.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        for (const [eventId, { streamId: sid, message }] of sorted) {
            if (sid !== streamId) continue;
            if (eventId === lastEventId) {
                found = true;
                continue;
            }
            if (found) await send(eventId, message);
        }
        return streamId;
    }
}

describe.each(zodTestMatrix)('$zodVersionLabel', (entry: ZodMatrixEntry) => {
    const { z } = entry;
    describe('Transport resumability', () => {
        let server: Server;
        let mcpServer: McpServer;
        let serverTransport: NodeStreamableHTTPServerTransport;
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
            serverTransport = new NodeStreamableHTTPServerTransport({
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
            baseUrl = await listenOnRandomPort(server);
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
            const clientTitle = 'test-client-long-running';
            const notifications = [];
            let lastEventId: string | undefined;

            // Create first client
            const client1 = new Client({
                title: clientTitle,
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
            const onLastEventIdUpdate = vi.fn((eventId: string) => {
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

            // Fix for node 18 test failures, allow some time for notifications to arrive
            const maxWaitTime = 2000; // 2 seconds max wait
            const pollInterval = 10; // Check every 10ms
            const startTime = Date.now();
            while (notifications.length === 0 && Date.now() - startTime < maxWaitTime) {
                // Wait for some notifications to arrive (not all) - shorter wait time
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }

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
                title: clientTitle,
                name: 'test-client',
                version: '1.0.0'
            });

            // Track replayed notifications separately
            const replayedNotifications: unknown[] = [];
            client2.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
                if (notification.method === 'notifications/message') {
                    replayedNotifications.push(notification.params);
                }
            });

            // Connect second client with same session ID
            const transport2 = new StreamableHTTPClientTransport(baseUrl, {
                sessionId
            });
            await client2.connect(transport2);

            // Resume GET SSE stream with Last-Event-ID to replay missed events
            // Per spec, resumption uses GET with Last-Event-ID header
            await transport2.resumeStream(lastEventId!, { onresumptiontoken: onLastEventIdUpdate });

            // Wait for replayed events to arrive via SSE
            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify the test infrastructure worked - we received notifications in first session
            // and captured the lastEventId for potential replay
            expect(notifications.length).toBeGreaterThan(0);
            expect(lastEventId).toBeDefined();

            // Clean up
            await transport2.close();
        });
    });
});
