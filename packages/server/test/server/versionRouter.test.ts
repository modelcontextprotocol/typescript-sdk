import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JSONRPCMessage, JSONRPCRequest, JSONRPCResultResponse } from '@modelcontextprotocol/core';
import { McpServer } from '../../src/server/mcp.js';
import type { McpEra, TransportMeta } from '../../src/server/versionRouter.js';
import { McpVersionRouter } from '../../src/server/versionRouter.js';

// Concrete test router that always returns a fixed era
class TestRouter extends McpVersionRouter {
    public era: McpEra = 'modern';
    classify(_message: JSONRPCMessage, _meta?: TransportMeta): McpEra {
        return this.era;
    }
}

describe('McpVersionRouter', () => {
    let mcpServer: McpServer;
    let router: TestRouter;

    beforeEach(() => {
        mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' });
        mcpServer.registerTool('hello', { description: 'says hello' }, async () => ({
            content: [{ type: 'text', text: 'hello world' }]
        }));
        router = new TestRouter(mcpServer);
    });

    describe('modern dispatch', () => {
        it('dispatches a modern tools/list request', async () => {
            const request: JSONRPCRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
                params: {}
            };
            const result = await router.handleModernRequest(request);
            expect(result).toHaveProperty('tools');
            expect((result as any).tools).toHaveLength(1);
        });
    });

    describe('server/discover', () => {
        it('returns server info and capabilities', () => {
            const result = router.handleDiscover();
            expect(result).toHaveProperty('serverInfo');
            expect(result).toHaveProperty('capabilities');
            expect(result.serverInfo.name).toBe('test-server');
            expect(result.supportedVersions).toContain('2026-06-30');
        });
    });

    describe('legacy bridge', () => {
        it('creates a legacy session and routes initialize through it', async () => {
            const responses: JSONRPCMessage[] = [];
            const session = router.createLegacySession();
            session.onOutgoing = msg => responses.push(msg);

            session.injectMessage({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-05',
                    capabilities: {},
                    clientInfo: { name: 'test-client', version: '1.0' }
                }
            });

            await vi.waitFor(() => {
                expect(responses).toHaveLength(1);
            });

            const response = responses[0] as JSONRPCResultResponse;
            expect(response.result).toHaveProperty('protocolVersion');
            expect(response.result).toHaveProperty('capabilities');
            expect(response.result).toHaveProperty('serverInfo');
        });

        it('legacy session shares handlers with modern path', async () => {
            const session = router.createLegacySession();
            const responses: JSONRPCMessage[] = [];
            session.onOutgoing = msg => responses.push(msg);

            // Initialize
            session.injectMessage({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-05',
                    capabilities: {},
                    clientInfo: { name: 'test', version: '1.0' }
                }
            });
            await vi.waitFor(() => expect(responses).toHaveLength(1));
            responses.length = 0;

            session.injectMessage({
                jsonrpc: '2.0',
                method: 'notifications/initialized',
                params: {}
            });

            // tools/list
            session.injectMessage({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
                params: {}
            });
            await vi.waitFor(() => expect(responses).toHaveLength(1));

            const result = (responses[0] as JSONRPCResultResponse).result as { tools: { name: string }[] };
            expect(result.tools).toHaveLength(1);
            expect(result.tools[0]!.name).toBe('hello');
        });

        it('session has an id', () => {
            const session = router.createLegacySession({ sessionId: 'my-session' });
            expect(session.id).toBe('my-session');
        });

        it('session close fires onclose', async () => {
            const session = router.createLegacySession();
            const onclose = vi.fn();
            session.onclose = onclose;
            await session.close();
            expect(onclose).toHaveBeenCalled();
        });
    });
});
