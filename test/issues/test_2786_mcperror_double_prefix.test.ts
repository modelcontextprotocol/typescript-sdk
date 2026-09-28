import { Client } from '../../src/client/index.js';
import { Server } from '../../src/server/index.js';
import { InMemoryTransport } from '../../src/inMemory.js';
import { CallToolRequestSchema, ErrorCode, McpError, UrlElicitationRequiredError } from '../../src/types.js';

describe('Issue #2786: McpError double prefix', () => {
    test('thrown McpError has single prefix on client and bare message on wire', async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'test-client', version: '1.0' });
        const server = new Server({ name: 'test-server', version: '1.0' }, { capabilities: { tools: {} } });

        let wireErrorMessage: string | undefined;
        const originalSend = serverTransport.send.bind(serverTransport);
        serverTransport.send = async (message: any) => {
            if (message.error) {
                wireErrorMessage = message.error.message;
            }
            return originalSend(message);
        };

        server.setRequestHandler(CallToolRequestSchema, async () => {
            throw new McpError(ErrorCode.MethodNotFound, 'Unknown tool: nope');
        });

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        let capturedClientError: McpError | undefined;
        try {
            await client.callTool({ name: 'nope', arguments: {} });
        } catch (e: any) {
            capturedClientError = e;
        }

        expect(wireErrorMessage).toBe('Unknown tool: nope');
        expect(capturedClientError).toBeInstanceOf(McpError);
        expect(capturedClientError?.message).toBe('MCP error -32601: Unknown tool: nope');
    });

    test('McpError.fromError does not double prefix when server sends already-prefixed message', () => {
        const err = McpError.fromError(ErrorCode.MethodNotFound, 'MCP error -32601: Unknown tool: nope');
        expect(err.message).toBe('MCP error -32601: Unknown tool: nope');
    });

    test('UrlElicitationRequiredError fromError does not double prefix', () => {
        const elicitations = [{ mode: 'url' as const, url: 'https://example.com' }];
        const err = McpError.fromError(ErrorCode.UrlElicitationRequired, 'MCP error -32042: URL elicitation required', { elicitations });
        expect(err).toBeInstanceOf(UrlElicitationRequiredError);
        expect(err.message).toBe('MCP error -32042: URL elicitation required');
    });
});
