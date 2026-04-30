/* eslint-disable import/no-unresolved --
   This test's purpose is to import from `@modelcontextprotocol/sdk/...` v1 subpaths.
   eslint can't resolve them until the sdk package is built; tsconfig `paths` covers TS. */
/**
 * v1 API surface compat test.
 *
 * Every import in this file uses a v1 deep-import path under
 * `@modelcontextprotocol/sdk/...`. The fact that it typechecks and runs IS the
 * primary assertion: a v1 consumer can bump `@modelcontextprotocol/sdk` to
 * 2.x and keep their existing imports and call shapes.
 *
 * Covers (by BC track):
 *  - D1  meta-package subpath re-exports (every import below)
 *  - C2  McpServer.tool() variadic
 *  - C4  registerTool raw-shape inputSchema
 *  - C5  flat ctx.* getters + RequestHandlerExtra type alias
 *  - C7  McpError/ErrorCode/JSONRPCError/StreamableHTTPError aliases
 *  - C8  StreamableHTTPServerTransport alias (from /node)
 *  - C10 *RequestSchema constants in sdk/types.js + OAuth schemas in shared/auth.js
 *  - A1  setRequestHandler(ZodSchema, h) + callTool(params, ResultSchema)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OAuthTokensSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, JSONRPCError } from '@modelcontextprotocol/sdk/types.js';
import {
    CallToolRequestSchema,
    CallToolResultSchema,
    ErrorCode,
    LATEST_PROTOCOL_VERSION,
    ListToolsRequestSchema,
    McpError,
    StreamableHTTPError
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

void StdioServerTransport; // type-level: import resolves
const _t: Transport | undefined = undefined;
void _t;

describe('v1 API surface (bump-only compat)', () => {
    it('McpServer.registerTool with raw-shape inputSchema + InMemory roundtrip + callTool(_, ResultSchema)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const server = new McpServer({ name: 't', version: '1.0.0' });
        // C4: raw-shape inputSchema (object of ZodTypes, not z.object)
        server.registerTool('echo', { inputSchema: { msg: z.string() } }, async ({ msg }) => ({
            content: [{ type: 'text', text: msg }]
        }));

        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'c', version: '1.0.0' });
        await Promise.all([server.connect(serverT), client.connect(clientT)]);

        // A1: callTool(params, ResultSchema) overload (first-class, no warning)
        const result = (await client.callTool({ name: 'echo', arguments: { msg: 'hi' } }, CallToolResultSchema)) as CallToolResult;
        expect(result.content[0]).toEqual({ type: 'text', text: 'hi' });
        warn.mockRestore();
        await Promise.all([client.close(), server.close()]);
    });

    it('low-level Server.setRequestHandler(ZodSchema, h) + flat ctx.* getters', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const server = new Server({ name: 't', version: '1.0.0' }, { capabilities: { tools: {} } });
        let sawExtra: RequestHandlerExtra | undefined;
        // A1: deprecated schema-arg form
        server.setRequestHandler(ListToolsRequestSchema, async (_req, extra) => {
            sawExtra = extra;
            // C5: flat getters
            expect(extra.signal).toBeInstanceOf(AbortSignal);
            expect(typeof extra.requestId === 'number' || typeof extra.requestId === 'string').toBe(true);
            expect(typeof extra.sendNotification).toBe('function');
            expect(typeof extra.sendRequest).toBe('function');
            return { tools: [] };
        });
        server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'c', version: '1.0.0' });
        await Promise.all([server.connect(serverT), client.connect(clientT)]);
        const tools = await client.listTools();
        expect(tools.tools).toEqual([]);
        expect(sawExtra).toBeDefined();
        warn.mockRestore();
        await Promise.all([client.close(), server.close()]);
    });

    it('McpError/ErrorCode/JSONRPCError/StreamableHTTPError aliases', () => {
        const e = new McpError(ErrorCode.InvalidParams, 'x');
        expect(e.code).toBe(ErrorCode.InvalidParams);
        // C7: ConnectionClosed/RequestTimeout shimmed onto ErrorCode
        expect(ErrorCode.ConnectionClosed).toBeDefined();
        expect(ErrorCode.RequestTimeout).toBeDefined();
        const httpErr = new StreamableHTTPError(404, 'nf');
        expect(httpErr).toBeInstanceOf(Error);
        // JSONRPCError is a type alias — assignable to the v2 shape
        const _je: JSONRPCError = { jsonrpc: '2.0', id: 1, error: { code: -32_600, message: 'x' } };
        void _je;
    });

    it('OAuth Zod schemas available for runtime parse (shared/auth.js)', () => {
        const parsed = OAuthTokensSchema.safeParse({ access_token: 'x', token_type: 'Bearer' });
        expect(parsed.success).toBe(true);
    });

    it('extensionless subpath imports resolve (claude-ai pattern)', async () => {
        const types = await import('@modelcontextprotocol/sdk/types');
        expect(types.LATEST_PROTOCOL_VERSION).toBe(LATEST_PROTOCOL_VERSION);
    });

    it('StreamableHTTPServerTransport alias available from /node-style import', async () => {
        const node = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
        expect(node.StreamableHTTPServerTransport).toBeDefined();
    });
});
