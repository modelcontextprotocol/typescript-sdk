import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { z } from 'zod';

// Exercise the v1 deep-import subpaths.
import { McpError, ErrorCode, type CallToolRequest } from '../src/types.js';
import { Server } from '../src/server/index.js';
import { Client } from '../src/client/index.js';
import { McpServer } from '../src/server/mcp.js';
import { InvalidTokenError, OAuthError as LegacyOAuthError } from '../src/server/auth/errors.js';
import { StreamableHTTPServerTransport } from '../src/server/streamableHttp.js';
import type { Transport } from '../src/shared/transport.js';
import type { RequestHandlerExtra } from '../src/shared/protocol.js';
import { ProtocolError } from '../src/index.js';

describe('@modelcontextprotocol/sdk meta-package', () => {
    let warnSpy: MockInstance;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    it('re-exports v1 deep-import subpaths', () => {
        // ./types.js — McpError/ErrorCode aliases
        const err = new McpError(ErrorCode.InvalidParams, 'x');
        expect(err).toBeInstanceOf(ProtocolError);

        // ./server/mcp.js
        expect(typeof McpServer).toBe('function');

        // ./server/auth/errors.js — v1 OAuth subclasses (legacy hierarchy, shared with sibling auth subpaths)
        const tokenErr = new InvalidTokenError('bad');
        expect(tokenErr).toBeInstanceOf(LegacyOAuthError);
        expect(tokenErr.errorCode).toBe('invalid_token');

        // ./server/streamableHttp.js — alias to NodeStreamableHTTPServerTransport
        expect(typeof StreamableHTTPServerTransport).toBe('function');

        // ./shared/transport.js + ./shared/protocol.js — type-only re-exports compile
        const _t: Transport | undefined = undefined;
        const _ctx: RequestHandlerExtra | undefined = undefined;
        const _req: CallToolRequest | undefined = undefined;
        void _t;
        void _ctx;
        void _req;
    });

    describe('Server.setRequestHandler (Zod-schema form)', () => {
        it('accepts a Zod request schema and registers by extracted method (first-class, no warning)', () => {
            const server = new Server({ name: 't', version: '1' }, { capabilities: { tools: {} } });
            const ListToolsRequestSchema = z.object({ method: z.literal('tools/list') });

            server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));

            expect(warnSpy).not.toHaveBeenCalled();
            expect(() => server.assertCanSetRequestHandler('tools/list')).toThrow();
        });

        it('accepts the v2 string-method form without warning', () => {
            const server = new Server({ name: 't', version: '1' }, { capabilities: { tools: {} } });
            server.setRequestHandler('tools/list', () => ({ tools: [] }));
            expect(warnSpy).not.toHaveBeenCalled();
        });
    });

    describe('McpServer.server reaches the schema-arg overload', () => {
        it('accepts a Zod request schema on .server.setRequestHandler (no warning)', () => {
            const mcp = new McpServer({ name: 't', version: '1' }, { capabilities: { resources: {} } });
            const ListResourcesRequestSchema = z.object({ method: z.literal('resources/list') });

            mcp.server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));

            expect(warnSpy).not.toHaveBeenCalled();
            expect(() => mcp.server.assertCanSetRequestHandler('resources/list')).toThrow();
            expect(mcp.server).toBeInstanceOf(Server);
        });
    });

    describe('Client.request (result-schema form)', () => {
        it('accepts (req, ResultSchema, opts) call shape (first-class, no warning)', async () => {
            const client = new Client({ name: 't', version: '1' });
            const ResultSchema = z.object({});

            // Not connected — rejects, but the call shape is accepted at the type/dispatch level.
            await expect(client.request({ method: 'ping' }, ResultSchema, { timeout: 10 })).rejects.toThrow();

            expect(warnSpy).not.toHaveBeenCalled();
        });
    });
});
