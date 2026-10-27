/**
 * `McpServerOptions.extensions`: each extension is advertised under
 * `capabilities.extensions[id]` and set up at construction through a
 * `ServerExtensionContext`, which registers custom methods, middleware on spec
 * methods, capability settings and dependencies.
 */
import type { JSONRPCRequest, MessageClassification } from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    MissingRequiredClientCapabilityError,
    PROTOCOL_VERSION_META_KEY,
    setNegotiatedProtocolVersion
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import type { ServerExtension } from '../../src/server/extension';
import { invoke } from '../../src/server/invoke';
import { McpServer } from '../../src/server/mcp';
import type { Server } from '../../src/server/server';

const MODERN_REVISION = '2026-07-28';
const MODERN: MessageClassification = { era: 'modern', revision: MODERN_REVISION };
const EXT_ID = 'com.example/gate';
const info = { name: 's', version: '1' };

const modernRequest = (
    method: string,
    params: Record<string, unknown> = {},
    clientCapabilities: Record<string, unknown> = {}
): JSONRPCRequest =>
    ({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
            ...params,
            _meta: {
                [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
                [CLIENT_INFO_META_KEY]: { name: 'ext-client', version: '1.0.0' },
                [CLIENT_CAPABILITIES_META_KEY]: clientCapabilities
            }
        }
    }) as JSONRPCRequest;

async function exchange(server: Server, request: JSONRPCRequest): Promise<Record<string, unknown>> {
    setNegotiatedProtocolVersion(server, MODERN_REVISION);
    const response = await invoke(server, request, { classification: MODERN });
    return (await response.json()) as Record<string, unknown>;
}

/** An extension that gates `tools/call` on a client capability and adds one custom method. */
const gate: ServerExtension = {
    id: EXT_ID,
    setup(ctx) {
        ctx.capability({ exampleData: true });
        ctx.setRequestHandler('gate/status', { params: z.looseObject({}) }, () => ({ armed: true }));
        ctx.use('tools/call', (request, requestCtx, next) => {
            const envelope = requestCtx.mcpReq.envelope as Record<string, Record<string, unknown>> | undefined;
            const extensions = envelope?.[CLIENT_CAPABILITIES_META_KEY]?.['extensions'] as Record<string, unknown> | undefined;
            if (extensions === undefined || !(EXT_ID in extensions)) {
                throw new MissingRequiredClientCapabilityError(
                    { requiredCapabilities: { extensions: { [EXT_ID]: {} } } },
                    'declare the gate'
                );
            }
            return next(request, requestCtx);
        });
    }
};

/** An extension whose `setup` only records that it ran. */
const plain = (id: string, log: string[] = []): ServerExtension => ({ id, setup: () => void log.push(id) });

/** An extension whose middleware on `tools/call` records when it runs. */
const tracing = (id: string, log: string[]): ServerExtension => ({
    id,
    setup(ctx) {
        ctx.use('tools/call', async (request, requestCtx, next) => {
            log.push(`${id} in`);
            const result = await next(request, requestCtx);
            log.push(`${id} out`);
            return result;
        });
    }
});

const echo = (mcp: McpServer) =>
    mcp.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
        content: [{ type: 'text', text }]
    }));

describe('McpServerOptions.extensions', () => {
    it('advertises {} for an extension that sets no capability, and the settings of one that does', () => {
        const mcp = new McpServer(info, { extensions: [plain('com.example/plain'), gate] });
        expect(mcp.server.getCapabilities().extensions).toEqual({ 'com.example/plain': {}, [EXT_ID]: { exampleData: true } });
    });

    it('runs setup in order, handing each extension the McpServer it is set up on', () => {
        const seen: unknown[] = [];
        const probe = (id: string): ServerExtension => ({ id, setup: ctx => void seen.push([id, ctx.mcp]) });
        const mcp = new McpServer(info, { extensions: [probe('com.example/a'), probe('com.example/b')] });
        expect(seen).toEqual([
            ['com.example/a', mcp],
            ['com.example/b', mcp]
        ]);
    });

    it('serves a custom method the extension registered', async () => {
        const mcp = new McpServer(info, { extensions: [gate] });
        const body = await exchange(mcp.server, modernRequest('gate/status'));
        expect(body['result']).toMatchObject({ armed: true });
    });

    it('applies middleware to tools/call, which McpServer registers later: refuses without the capability, passes with it', async () => {
        const mcp = new McpServer(info, { extensions: [gate] });
        echo(mcp);

        const refused = await exchange(mcp.server, modernRequest('tools/call', { name: 'echo', arguments: { text: 'hi' } }));
        expect(refused['error']).toMatchObject({ code: -32_021, message: 'declare the gate' });

        const allowed = await exchange(
            mcp.server,
            modernRequest('tools/call', { name: 'echo', arguments: { text: 'hi' } }, { extensions: { [EXT_ID]: {} } })
        );
        expect(allowed['result']).toMatchObject({ content: [{ type: 'text', text: 'hi' }] });
    });

    it('nests middleware in extensions order, outside middleware the application adds afterwards', async () => {
        const log: string[] = [];
        const mcp = new McpServer(info, { extensions: [tracing('com.example/a', log), tracing('com.example/b', log)] });
        mcp.server.use('tools/call', async (request, requestCtx, next) => {
            log.push('app');
            return next(request, requestCtx);
        });
        echo(mcp);
        await exchange(mcp.server, modernRequest('tools/call', { name: 'echo', arguments: { text: 'hi' } }));
        expect(log).toEqual(['com.example/a in', 'com.example/b in', 'app', 'com.example/b out', 'com.example/a out']);
    });

    it('refuses a custom method that is a core method of any protocol version', () => {
        const claims = (name: string): ServerExtension => ({
            id: 'com.example/core',
            setup: ctx => ctx.setRequestHandler(name, { params: z.looseObject({}) }, () => ({}))
        });
        for (const name of ['tools/list', 'logging/setLevel', 'resources/subscribe', 'tasks/list']) {
            expect(() => new McpServer(info, { extensions: [claims(name)] })).toThrow(
                `Extension "com.example/core" cannot register "${name}": it is a core method; wrap it with use() instead`
            );
        }
    });

    it('refuses a custom method another extension already serves', () => {
        const status = (id: string): ServerExtension => ({
            id,
            setup: ctx => ctx.setRequestHandler('gate/status', { params: z.looseObject({}) }, () => ({ armed: true }))
        });
        expect(() => new McpServer(info, { extensions: [status('com.example/a'), status('com.example/b')] })).toThrow(
            'Extension "com.example/b" cannot register "gate/status": another handler already serves it'
        );
    });

    it('lets an extension register a name 2026-07-28 removed from core, as the Tasks extension does with tasks/get', async () => {
        const tasksLike: ServerExtension = {
            id: 'com.example/tasks-like',
            setup: ctx =>
                ctx.setRequestHandler('tasks/get', { params: z.looseObject({ taskId: z.string() }) }, ({ taskId }) => ({ taskId }))
        };
        const mcp = new McpServer(info, { extensions: [tasksLike] });
        const body = await exchange(mcp.server, modernRequest('tasks/get', { taskId: 't1' }));
        expect(body['result']).toMatchObject({ taskId: 't1' });
    });

    it('refuses a duplicate id before setting anything up', () => {
        const log: string[] = [];
        expect(() => new McpServer(info, { extensions: [plain('com.example/a', log), plain('com.example/a', log)] })).toThrow(
            'Extension "com.example/a" is listed more than once'
        );
        expect(log).toEqual([]);
    });

    it('refuses an object without setup', () => {
        const shapeless = { id: 'com.example/empty' } as unknown as ServerExtension;
        expect(() => new McpServer(info, { extensions: [shapeless] })).toThrow('Extension "com.example/empty" has no setup');
    });

    it('a MissingRequiredClientCapabilityError thrown by a tool handler is a JSON-RPC error, not an isError result', async () => {
        const mcp = new McpServer(info);
        mcp.registerTool('needs-ext', {}, async () => {
            throw new MissingRequiredClientCapabilityError({ requiredCapabilities: { extensions: { [EXT_ID]: {} } } }, 'declare the gate');
        });
        const body = await exchange(mcp.server, modernRequest('tools/call', { name: 'needs-ext', arguments: {} }));
        expect(body['error']).toMatchObject({ code: -32_021, data: { requiredCapabilities: { extensions: { [EXT_ID]: {} } } } });
    });
});

describe('ServerExtensionContext.require', () => {
    const needs = (id: string, extensionId: `${string}/${string}`): ServerExtension => ({ id, setup: ctx => ctx.require(extensionId) });

    it('fails construction when the required extension is missing, naming both', () => {
        expect(() => new McpServer(info, { extensions: [needs('com.example/search', 'com.example/index')] })).toThrow(
            'Extension "com.example/search" requires the "com.example/index" extension, which this server does not install'
        );
    });

    it('accepts the required extension wherever it is listed', () => {
        expect(
            () => new McpServer(info, { extensions: [needs('com.example/search', 'com.example/index'), plain('com.example/index')] })
        ).not.toThrow();
        expect(
            () => new McpServer(info, { extensions: [plain('com.example/index'), needs('com.example/search', 'com.example/index')] })
        ).not.toThrow();
    });
});
