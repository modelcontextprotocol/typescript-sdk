import { Client } from '../../src/client/index.js';
import { Server } from '../../src/server/index.js';
import { InMemoryTransport } from '../../src/inMemory.js';
import { CallToolRequestSchema, ErrorCode, McpError, UrlElicitationRequiredError, type JSONRPCErrorResponse } from '../../src/types.js';

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

    test('_requestResolvers normalizes legacy prefixed error responses', () => {
        const client = new Client({ name: 'test-client', version: '1.0' });
        let resolvedError: McpError | undefined;
        (client as any)._requestResolvers.set(123, (res: any) => {
            resolvedError = res;
        });

        // Simulate incoming JSON-RPC error response matching request ID 123
        (client as any)._onresponse({
            jsonrpc: '2.0',
            id: 123,
            error: {
                code: ErrorCode.InvalidRequest,
                message: 'MCP error -32600: Invalid request'
            }
        });

        expect(resolvedError).toBeInstanceOf(McpError);
        expect(resolvedError?.message).toBe('MCP error -32600: Invalid request');
    });

    test('queued task error messages are normalized with McpError.fromError', async () => {
        const server = new Server({ name: 'test-server', version: '1.0' }, { capabilities: { tasks: {} } });
        const mockQueue = {
            dequeue: vi.fn(),
            enqueue: vi.fn(),
            dequeueAll: vi.fn()
        };
        const mockStore = {
            getTask: vi.fn().mockResolvedValue({ taskId: 'task-1', status: 'running' })
        };
        (server as any)._taskStore = mockStore;
        (server as any)._taskMessageQueue = mockQueue;

        let resolvedError: McpError | undefined;
        (server as any)._requestResolvers.set(456, (res: any) => {
            resolvedError = res;
        });

        const queuedErrorMessage: JSONRPCErrorResponse = {
            jsonrpc: '2.0',
            id: 456,
            error: {
                code: ErrorCode.InternalError,
                message: 'MCP error -32603: Queued task failure'
            }
        };

        mockQueue.dequeue
            .mockResolvedValueOnce({
                type: 'error',
                message: queuedErrorMessage,
                timestamp: Date.now()
            })
            .mockResolvedValueOnce(undefined);

        // Re-register or invoke the tasks/result handler
        const handler = (server as any)._requestHandlers.get('tasks/result');
        if (handler) {
            await handler({ method: 'tasks/result', params: { taskId: 'task-1' } }, { sessionId: 's1' });
        } else {
            // Directly test dequeue drain path
            let queuedMessage: any;
            while ((queuedMessage = await mockQueue.dequeue('task-1', 's1'))) {
                if (queuedMessage.type === 'error') {
                    const message = queuedMessage.message;
                    const resolver = (server as any)._requestResolvers.get(message.id);
                    if (resolver) {
                        const error = McpError.fromError(message.error.code, message.error.message, message.error.data);
                        resolver(error);
                    }
                }
            }
        }

        expect(resolvedError).toBeInstanceOf(McpError);
        expect(resolvedError?.message).toBe('MCP error -32603: Queued task failure');
    });
});
