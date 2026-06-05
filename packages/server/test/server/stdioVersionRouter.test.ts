import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '../../src/server/mcp.js';
import { StdioVersionRouter } from '../../src/server/stdioVersionRouter.js';

describe('StdioVersionRouter', () => {
    let mcpServer: McpServer;
    let router: StdioVersionRouter;

    beforeEach(() => {
        mcpServer = new McpServer({ name: 'test', version: '1.0' });
        router = new StdioVersionRouter(mcpServer, { legacySupport: true });
    });

    describe('classify', () => {
        it('returns legacy and locks when first message is initialize', () => {
            const result = router.classify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2025-11-05', capabilities: {}, clientInfo: { name: 'c', version: '1' } }
            });
            expect(result).toBe('legacy');

            // Subsequent messages should also be legacy (locked)
            const result2 = router.classify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
                params: {}
            });
            expect(result2).toBe('legacy');
        });

        it('returns modern and locks when first message is server/discover', () => {
            const result = router.classify({
                jsonrpc: '2.0',
                id: 1,
                method: 'server/discover',
                params: { _meta: { protocolVersion: '2026-06-30' } }
            });
            expect(result).toBe('modern');

            const result2 = router.classify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
                params: {}
            });
            expect(result2).toBe('modern');
        });

        it('returns modern when first message has _meta.clientCapabilities', () => {
            const result = router.classify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
                params: { _meta: { protocolVersion: '2026-06-30', clientCapabilities: {}, clientInfo: { name: 'c', version: '1' } } }
            });
            expect(result).toBe('modern');
        });

        it('defaults to modern for unknown first messages', () => {
            const result = router.classify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
                params: {}
            });
            expect(result).toBe('modern');
        });
    });
});
