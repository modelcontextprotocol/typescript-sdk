import type {
    DispatchContext,
    JSONRPCErrorResponse,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    Result,
    ServerContext
} from '@modelcontextprotocol/core';
import {
    InputRequiredError,
    JSONRPC_VERSION,
    LATEST_PROTOCOL_VERSION,
    META_KEYS,
    ProtocolError,
    ProtocolErrorCode,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';

import { Server } from '../../src/server/server.js';

const STATELESS_VERSION = LATEST_PROTOCOL_VERSION;

function makeServer(): Server {
    return new Server(
        { name: 's', version: '1' },
        { capabilities: { tools: { listChanged: true }, prompts: {}, logging: {} }, instructions: 'hi' }
    );
}

function dispatch(server: Server) {
    return server.statelessHandlers().dispatch;
}

function setHandler(server: Server, method: string, handler: (req: JSONRPCRequest, ctx: ServerContext) => Promise<Result>): void {
    (server.setRequestHandler as (m: string, h: typeof handler) => void)(method, handler);
}

function meta(extra?: Record<string, unknown>): Record<string, unknown> {
    return {
        [META_KEYS.protocolVersion]: STATELESS_VERSION,
        [META_KEYS.clientInfo]: { name: 'c', version: '1' },
        [META_KEYS.clientCapabilities]: {},
        ...extra
    };
}

function req(method: string, params: Record<string, unknown> = {}, id: number | string = 1): JSONRPCRequest {
    return { jsonrpc: JSONRPC_VERSION, id, method, params: { ...params, _meta: meta(params._meta as Record<string, unknown>) } };
}

function ctx(over?: Partial<DispatchContext>): DispatchContext {
    return { notify: () => {}, ...over };
}

function ok(r: JSONRPCResponse | JSONRPCErrorResponse): Result {
    if (!('result' in r)) throw new Error(`expected result, got error ${JSON.stringify(r)}`);
    return r.result;
}

function err(r: JSONRPCResponse | JSONRPCErrorResponse): { code: number; message: string; data?: unknown } {
    if (!('error' in r)) throw new Error(`expected error, got result ${JSON.stringify(r)}`);
    return r.error;
}

describe('Server._dispatchStateless', () => {
    it('handles server/discover via the registered handler', async () => {
        const server = makeServer();
        const r = await dispatch(server)(req('server/discover'), ctx());
        expect(ok(r)).toMatchObject({
            serverInfo: { name: 's', version: '1' },
            capabilities: { tools: { listChanged: true }, prompts: {}, logging: {} },
            instructions: 'hi',
            supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS]
        });
    });

    it('does not add resultType to server/discover', async () => {
        const server = makeServer();
        const r = await dispatch(server)(req('server/discover'), ctx());
        expect(ok(r)).not.toHaveProperty('resultType');
    });

    it('rejects removed methods with -32601', async () => {
        const server = makeServer();
        const r = await dispatch(server)(req('initialize'), ctx());
        expect(err(r).code).toBe(ProtocolErrorCode.MethodNotFound);
    });

    it('rejects unsupported protocol versions', async () => {
        const server = makeServer();
        const r = await dispatch(server)(
            { jsonrpc: JSONRPC_VERSION, id: 1, method: 'tools/list', params: { _meta: { [META_KEYS.protocolVersion]: '1999-01-01' } } },
            ctx()
        );
        expect(err(r).code).toBe(ProtocolErrorCode.InvalidParams);
        expect(err(r).data).toMatchObject({ requested: '1999-01-01' });
    });

    it('fills resultType: complete when handler omits it', async () => {
        const server = makeServer();
        setHandler(server, 'tools/list', async () => ({ tools: [] }));
        const r = await dispatch(server)(req('tools/list'), ctx());
        expect(ok(r).resultType).toBe('complete');
    });

    it('routes ctx.mcpReq.notify via dctx.notify, server-stamps subscriptionId last', async () => {
        const server = makeServer();
        const seen: JSONRPCNotification[] = [];
        setHandler(server, 'prompts/list', async (_, sctx) => {
            await sctx.mcpReq.notify({
                method: 'notifications/progress',
                params: { progress: 1, progressToken: 't', _meta: { [META_KEYS.subscriptionId]: 'handler-override-attempt' } }
            });
            return { prompts: [] };
        });
        await dispatch(server)(req('prompts/list', {}, 42), ctx({ notify: n => seen.push(n) }));
        expect(seen).toHaveLength(1);
        expect((seen[0]!.params!._meta as Record<string, unknown>)[META_KEYS.subscriptionId]).toBe('42');
    });

    it('log gating: drops without _meta.logLevel; emits when level >= threshold', async () => {
        const server = makeServer();
        const seen: JSONRPCNotification[] = [];
        setHandler(server, 'prompts/list', async (_, sctx) => {
            await sctx.mcpReq.log('debug', 'd');
            await sctx.mcpReq.log('error', 'e');
            return { prompts: [] };
        });
        await dispatch(server)(req('prompts/list'), ctx({ notify: n => seen.push(n) }));
        expect(seen).toHaveLength(0);
        await dispatch(server)(req('prompts/list', { _meta: { [META_KEYS.logLevel]: 'warning' } }), ctx({ notify: n => seen.push(n) }));
        expect(seen.map(n => (n.params as { level: string }).level)).toEqual(['error']);
    });

    it('mcpReq.send throws (no push channel)', async () => {
        const server = makeServer();
        let threw = false;
        setHandler(server, 'prompts/list', async (_, sctx) => {
            try {
                await sctx.mcpReq.send({ method: 'roots/list' } as never, {} as never);
            } catch {
                threw = true;
            }
            return { prompts: [] };
        });
        await dispatch(server)(req('prompts/list'), ctx());
        expect(threw).toBe(true);
    });

    it('catches InputRequiredError into resultType: input_required', async () => {
        const server = makeServer();
        setHandler(server, 'prompts/list', async () => {
            throw new InputRequiredError({
                'elicitation/create#0': { method: 'elicitation/create', params: { message: 'q' } } as never
            });
        });
        const r = await dispatch(server)(req('prompts/list', { _meta: { [META_KEYS.clientCapabilities]: { elicitation: {} } } }), ctx());
        expect(ok(r)).toMatchObject({
            resultType: 'input_required',
            inputRequests: { 'elicitation/create#0': { method: 'elicitation/create' } }
        });
    });

    it('cap-gates InputRequiredError with -32003 when client lacks capability', async () => {
        const server = makeServer();
        setHandler(server, 'prompts/list', async () => {
            throw new InputRequiredError({
                'sampling/createMessage#0': { method: 'sampling/createMessage', params: { messages: [] } } as never
            });
        });
        const r = await dispatch(server)(req('prompts/list'), ctx());
        expect(err(r).code).toBe(ProtocolErrorCode.MissingRequiredClientCapability);
        expect(err(r).data).toEqual({ requiredCapabilities: { sampling: {} } });
    });

    it('mrtrOrThrow returns validated cached inputResponses', async () => {
        const server = makeServer();
        setHandler(server, 'prompts/list', async (_, sctx) => {
            const r = await sctx.mcpReq.elicitInput({ message: 'q', requestedSchema: { type: 'object', properties: {} } });
            return { prompts: [{ name: r.action }] };
        });
        const r = await dispatch(server)(
            req('prompts/list', {
                _meta: { [META_KEYS.clientCapabilities]: { elicitation: { form: {} } } },
                inputResponses: { 'elicitation/create#0': { action: 'accept' } }
            }),
            ctx()
        );
        expect((ok(r) as { prompts: Array<{ name: string }> }).prompts[0]?.name).toBe('accept');
    });

    it('passes ProtocolError through with its code/data', async () => {
        const server = makeServer();
        setHandler(server, 'prompts/list', async () => {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'bad', { which: 'x' });
        });
        const r = await dispatch(server)(req('prompts/list'), ctx());
        expect(err(r)).toMatchObject({ code: ProtocolErrorCode.InvalidParams, message: 'bad', data: { which: 'x' } });
    });

    it('threads dctx.authInfo to handler ctx.http.authInfo', async () => {
        const server = makeServer();
        let seen: unknown;
        setHandler(server, 'prompts/list', async (_, sctx) => {
            seen = sctx.http?.authInfo;
            return { prompts: [] };
        });
        await dispatch(server)(req('prompts/list'), ctx({ authInfo: { token: 't', clientId: 'c', scopes: [] } }));
        expect(seen).toMatchObject({ token: 't' });
    });

    it('threads dctx.signal to handler ctx.mcpReq.signal', async () => {
        const server = makeServer();
        const ac = new AbortController();
        let aborted = false;
        setHandler(server, 'prompts/list', async (_, sctx) => {
            sctx.mcpReq.signal.addEventListener('abort', () => {
                aborted = true;
            });
            ac.abort();
            return { prompts: [] };
        });
        await dispatch(server)(req('prompts/list'), ctx({ signal: ac.signal }));
        expect(aborted).toBe(true);
    });

    it('is concurrent-safe on a shared instance', async () => {
        const server = makeServer();
        setHandler(server, 'prompts/list', async (_, sctx) => ({ prompts: [{ name: String(sctx.mcpReq.id) }] }));
        const d = dispatch(server);
        const rs = await Promise.all([1, 2, 3, 4, 5].map(i => d(req('prompts/list', {}, i), ctx())));
        expect(rs.map(r => (ok(r) as { prompts: Array<{ name: string }> }).prompts[0]?.name)).toEqual(['1', '2', '3', '4', '5']);
    });
});
