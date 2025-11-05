/**
 * Integration tests for streaming tool calls functionality
 */

import { Server } from '../server/index.js';
import { Client } from '../client/index.js';
import { InMemoryTransport } from '../inMemory.js';

describe('Streaming Tool Calls Integration', () => {
    let server: Server;
    let client: Client;
    let clientTransport: InMemoryTransport;
    let serverTransport: InMemoryTransport;

    beforeEach(() => {
        [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: { streaming: {} } } });
        client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { tools: { streaming: {} } } });
    });

    afterEach(async () => {
        await client.close();
        await server.close();
    });

    describe('Basic streaming workflow', () => {
        it('should handle basic streaming tool call request', async () => {
            // Connect client and server
            await server.connect(serverTransport);
            await client.connect(clientTransport);

            // Initiate streaming call
            const streamResult = await client.streamTool({
                name: 'test_tool'
            });

            expect(streamResult.callId).toMatch(/^stream_\d+$/);
            expect(streamResult.status).toBe('stream_open');
        });

        it('should handle streaming capability negotiation', async () => {
            // Connect client and server
            await server.connect(serverTransport);
            await client.connect(clientTransport);

            // Check server capabilities
            const serverCapabilities = server.getServerCapabilities();
            expect(serverCapabilities?.tools).toBeDefined();
        });
    });

    describe('Error handling', () => {
        it('should handle invalid stream ID error', async () => {
            // Connect client and server
            await server.connect(serverTransport);
            await client.connect(clientTransport);

            // Try to complete stream with invalid ID (should not throw client-side)
            // The server will handle the error internally
            await expect(client.completeStream('invalid_stream_id')).resolves.toBeUndefined();
        });
    });
});
