import type { JSONRPCMessage, JSONRPCRequest, JSONRPCResultResponse } from '@modelcontextprotocol/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpVersionRouter } from '../../src/server/httpVersionRouter.js';
import { McpServer } from '../../src/server/mcp.js';
import type { LegacySession } from '../../src/server/versionRouter.js';

/**
 * Helper: initialize a legacy session through the handshake sequence
 * (initialize + notifications/initialized) and return the collected responses.
 */
async function initializeLegacySession(session: LegacySession): Promise<JSONRPCMessage[]> {
    const responses: JSONRPCMessage[] = [];
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

    await vi.waitFor(() => expect(responses).toHaveLength(1));

    // Send the initialized notification (required before subsequent requests)
    session.injectMessage({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {}
    });

    // Clear the initialize response so callers only see subsequent messages
    responses.length = 0;
    return responses;
}

describe('Dual-era integration tests', () => {
    let mcpServer: McpServer;
    let router: HttpVersionRouter;

    beforeEach(() => {
        mcpServer = new McpServer({ name: 'dual-era-test', version: '1.0.0' });
        router = new HttpVersionRouter(mcpServer);
    });

    describe('Test 1: Modern and legacy paths share the same tool set', () => {
        it('both paths return the same registered tool', async () => {
            mcpServer.registerTool(
                'shared-tool',
                {
                    description: 'a tool visible to both eras'
                },
                async () => ({
                    content: [{ type: 'text', text: 'ok' }]
                })
            );

            // --- Modern path ---
            const modernRequest: JSONRPCRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
                params: {}
            };
            const modernResult = (await router.handleModernRequest(modernRequest)) as { tools: { name: string }[] };
            expect(modernResult.tools).toHaveLength(1);
            expect(modernResult.tools[0]!.name).toBe('shared-tool');

            // --- Legacy path ---
            const session = router.createLegacySession();
            const responses = await initializeLegacySession(session);

            session.injectMessage({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
                params: {}
            });
            await vi.waitFor(() => expect(responses).toHaveLength(1));

            const legacyResult = (responses[0] as JSONRPCResultResponse).result as { tools: { name: string }[] };
            expect(legacyResult.tools).toHaveLength(1);
            expect(legacyResult.tools[0]!.name).toBe('shared-tool');
        });
    });

    describe('Test 2: Tool registered after serving is visible to both paths', () => {
        it('late-registered tool appears in both modern and legacy tools/list', async () => {
            // Register the initial tool
            mcpServer.registerTool(
                'initial-tool',
                {
                    description: 'registered before any session'
                },
                async () => ({
                    content: [{ type: 'text', text: 'initial' }]
                })
            );

            // Create and initialize a legacy session BEFORE the second tool exists
            const session = router.createLegacySession();
            const responses = await initializeLegacySession(session);

            // Register a NEW tool after the legacy session is already alive
            mcpServer.registerTool(
                'late-tool',
                {
                    description: 'registered after the session exists'
                },
                async () => ({
                    content: [{ type: 'text', text: 'late' }]
                })
            );

            // --- Modern path: should see both tools ---
            const modernRequest: JSONRPCRequest = {
                jsonrpc: '2.0',
                id: 10,
                method: 'tools/list',
                params: {}
            };
            const modernResult = (await router.handleModernRequest(modernRequest)) as { tools: { name: string }[] };
            const modernToolNames = modernResult.tools.map(t => t.name).toSorted();
            expect(modernToolNames).toEqual(['initial-tool', 'late-tool']);

            // --- Legacy path: the EXISTING session should also see both tools ---
            session.injectMessage({
                jsonrpc: '2.0',
                id: 11,
                method: 'tools/list',
                params: {}
            });
            await vi.waitFor(() => expect(responses).toHaveLength(1));

            const legacyResult = (responses[0] as JSONRPCResultResponse).result as { tools: { name: string }[] };
            const legacyToolNames = legacyResult.tools.map(t => t.name).toSorted();
            expect(legacyToolNames).toEqual(['initial-tool', 'late-tool']);
        });
    });

    describe('Test 3: Legacy sessions have isolated per-session state', () => {
        it('closing one legacy session does not affect another', async () => {
            mcpServer.registerTool(
                'ping',
                {
                    description: 'simple ping'
                },
                async () => ({
                    content: [{ type: 'text', text: 'pong' }]
                })
            );

            // Create two independent sessions
            const sessionA = router.createLegacySession({ sessionId: 'session-a' });
            const sessionB = router.createLegacySession({ sessionId: 'session-b' });

            // Initialize session A
            await initializeLegacySession(sessionA);

            // Close session A
            const oncloseA = vi.fn();
            sessionA.onclose = oncloseA;
            await sessionA.close();
            expect(oncloseA).toHaveBeenCalled();

            // Session B should still work: initialize it after A is closed
            const responsesB = await initializeLegacySession(sessionB);

            // Verify session B can handle requests
            sessionB.injectMessage({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
                params: {}
            });
            await vi.waitFor(() => expect(responsesB).toHaveLength(1));

            const result = (responsesB[0] as JSONRPCResultResponse).result as { tools: { name: string }[] };
            expect(result.tools).toHaveLength(1);
            expect(result.tools[0]!.name).toBe('ping');
        });
    });
});
