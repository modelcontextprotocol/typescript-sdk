import { Client } from '../../src/client/index.js';
import { InMemoryTransport } from '../../src/inMemory.js';
import { Server } from '../../src/server/index.js';
import { CallToolRequestSchema, ErrorCode, McpError, type JSONRPCError } from '../../src/types.js';

describe('Issue #2786: a handler-thrown McpError must not be double-prefixed', () => {
    test('wire message carries the original message; client reconstructs a single prefix', async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } });
        const client = new Client({ name: 'test-client', version: '1.0.0' });

        server.setRequestHandler(CallToolRequestSchema, async () => {
            throw new McpError(ErrorCode.MethodNotFound, 'Unknown tool: nope');
        });

        // Capture the raw JSON-RPC error the server puts on the wire.
        const wireErrors: JSONRPCError[] = [];
        const originalSend = serverTransport.send.bind(serverTransport);
        serverTransport.send = async message => {
            if ('error' in message) {
                wireErrors.push(message);
            }
            return originalSend(message);
        };

        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

        let caught: unknown;
        try {
            await client.callTool({ name: 'nope', arguments: {} });
        } catch (error) {
            caught = error;
        } finally {
            await Promise.all([client.close(), server.close()]);
        }

        // The wire carries the original message, without the local `MCP error <code>:` prefix...
        expect(wireErrors).toHaveLength(1);
        expect(wireErrors[0]?.error.code).toBe(ErrorCode.MethodNotFound);
        expect(wireErrors[0]?.error.message).toBe('Unknown tool: nope');

        // ...and the client reconstructs exactly one prefix.
        expect(caught).toBeInstanceOf(McpError);
        const mcpError = caught as McpError;
        expect(mcpError.code).toBe(ErrorCode.MethodNotFound);
        expect(mcpError.message).toBe('MCP error -32601: Unknown tool: nope');
        expect(mcpError.originalMessage).toBe('Unknown tool: nope');
    });
});
