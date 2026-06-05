import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '../../src/server/mcp.js';
import { HttpVersionRouter } from '../../src/server/httpVersionRouter.js';

describe('HttpVersionRouter', () => {
    let mcpServer: McpServer;
    let router: HttpVersionRouter;

    beforeEach(() => {
        mcpServer = new McpServer({ name: 'test', version: '1.0' });
        router = new HttpVersionRouter(mcpServer, { legacySupport: true });
    });

    describe('classify', () => {
        it('returns modern when Mcp-Method header is present', () => {
            const result = router.classify(
                { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
                { httpHeaders: { 'mcp-method': 'tools/list' } }
            );
            expect(result).toBe('modern');
        });

        it('returns legacy when Mcp-Method header is absent', () => {
            const result = router.classify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { httpHeaders: {} });
            expect(result).toBe('legacy');
        });

        it('returns legacy when no transport meta', () => {
            const result = router.classify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
            expect(result).toBe('legacy');
        });

        it('returns modern for server/discover regardless of headers', () => {
            const result = router.classify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
            expect(result).toBe('modern');
        });
    });
});
