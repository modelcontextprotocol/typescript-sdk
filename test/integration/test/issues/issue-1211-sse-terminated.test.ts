/**
 * Tests for SSE stream graceful termination handling
 *
 * Issue #1211: SSE stream disconnected: TypeError: terminated
 * https://github.com/modelcontextprotocol/typescript-sdk/issues/1211
 *
 * This test verifies that graceful stream termination (TypeError: terminated)
 * is handled quietly without reporting unnecessary errors.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
    McpServer,
    StreamableHTTPServerTransport
} from '@modelcontextprotocol/server';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';

describe('SSE Stream Graceful Termination (Issue #1211)', () => {
    let server: Server;
    let mcpServer: McpServer;
    let serverTransport: StreamableHTTPServerTransport;
    let client: Client;
    let clientTransport: StreamableHTTPClientTransport;
    let baseUrl: URL;

    beforeEach(async () => {
        server = createServer();
        mcpServer = new McpServer(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {}
            }
        );

        serverTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID()
        });

        await mcpServer.connect(serverTransport);

        server.on('request', async (req, res) => {
            await serverTransport.handleRequest(req, res);
        });

        baseUrl = await listenOnRandomPort(server);
    });

    afterEach(async () => {
        await client?.close().catch(() => {});
        await mcpServer?.close().catch(() => {});
        server?.close();
    });

    test('should not report error when server closes SSE stream gracefully', async () => {
        const errors: Error[] = [];

        clientTransport = new StreamableHTTPClientTransport(baseUrl);
        client = new Client(
            { name: 'test-client', version: '1.0.0' },
            { capabilities: {} }
        );

        // Track any errors
        clientTransport.onerror = (error) => {
            errors.push(error);
        };

        await client.connect(clientTransport);

        // Verify connection is working
        expect(client.getServerCapabilities()).toBeDefined();

        // Close the server-side transport (simulating graceful termination)
        await serverTransport.close();

        // Give some time for any error events to propagate
        await new Promise(resolve => setTimeout(resolve, 100));

        // Should not have any "TypeError: terminated" errors reported
        const terminatedErrors = errors.filter(
            e => e.message.includes('terminated') || e.message.includes('body stream')
        );

        expect(terminatedErrors).toHaveLength(0);
    });

    test('should handle server shutdown without reporting termination errors', async () => {
        const errors: Error[] = [];

        clientTransport = new StreamableHTTPClientTransport(baseUrl);
        client = new Client(
            { name: 'test-client', version: '1.0.0' },
            { capabilities: {} }
        );

        clientTransport.onerror = (error) => {
            errors.push(error);
        };

        await client.connect(clientTransport);

        // Wait a bit to simulate some activity
        await new Promise(resolve => setTimeout(resolve, 50));

        // Close server abruptly
        await serverTransport.close();
        server.close();

        await new Promise(resolve => setTimeout(resolve, 100));

        // No terminated errors should be reported
        const terminatedErrors = errors.filter(
            e => e.message.includes('terminated') || e.message.includes('body stream')
        );

        expect(terminatedErrors).toHaveLength(0);
    });
});
