import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as z from 'zod/v4';

import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors.js';
import type { BaseContext } from '../../src/shared/protocol.js';
import { Protocol } from '../../src/shared/protocol.js';
import { ProtocolError, ProtocolErrorCode } from '../../src/types/index.js';
import { InMemoryTransport } from '../../src/util/inMemory.js';

class TestProtocol extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected assertTaskCapability(): void {}
    protected assertTaskHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

async function linkedPair(): Promise<[TestProtocol, TestProtocol]> {
    const a = new TestProtocol();
    const b = new TestProtocol();
    const [ta, tb] = InMemoryTransport.createLinkedPair();
    await Promise.all([a.connect(ta), b.connect(tb)]);
    return [a, b];
}

const SearchParams = z.object({ query: z.string(), limit: z.number().optional() });
const SearchResult = z.object({ hits: z.array(z.string()), total: z.number() });
const StatusParams = z.object({ status: z.enum(['idle', 'busy']) });

describe('custom request handlers', () => {
    let client: TestProtocol;
    let server: TestProtocol;

    beforeEach(async () => {
        [client, server] = await linkedPair();
    });

    test('happy path: typed params and result', async () => {
        server.setCustomRequestHandler('acme/search', SearchParams, params => {
            return { hits: [`result:${params.query}`], total: 1 };
        });

        const result = await client.sendCustomRequest('acme/search', { query: 'widgets', limit: 5 }, SearchResult);
        expect(result.hits).toEqual(['result:widgets']);
        expect(result.total).toBe(1);
    });

    test('handler receives full context (signal, mcpReq id)', async () => {
        let received: BaseContext | undefined;
        server.setCustomRequestHandler('acme/ctx', z.object({}), (_params, ctx) => {
            received = ctx;
            return {};
        });

        await client.sendCustomRequest('acme/ctx', {}, z.object({}));
        expect(received).toBeDefined();
        expect(received?.mcpReq.signal).toBeInstanceOf(AbortSignal);
        expect(received?.mcpReq.id).toBeDefined();
        expect(received?.mcpReq.method).toBe('acme/ctx');
    });

    test('invalid params -> InvalidParams ProtocolError', async () => {
        server.setCustomRequestHandler('acme/search', SearchParams, () => ({ hits: [], total: 0 }));

        await expect(client.sendCustomRequest('acme/search', { query: 123 }, SearchResult)).rejects.toSatisfy(
            (e: unknown) => e instanceof ProtocolError && e.code === ProtocolErrorCode.InvalidParams
        );
    });

    test('collision guard: throws on standard request method', () => {
        expect(() => server.setCustomRequestHandler('ping', z.object({}), () => ({}))).toThrow(/standard MCP request method/);
        expect(() => server.setCustomRequestHandler('tools/call', z.object({}), () => ({}))).toThrow(/standard MCP request method/);
        expect(() => server.removeCustomRequestHandler('tools/list')).toThrow(/standard MCP request method/);
    });

    test('collision guard: does NOT trigger on Object.prototype keys', () => {
        for (const m of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
            expect(() => server.setCustomRequestHandler(m, z.object({}), () => ({}))).not.toThrow();
            expect(() => server.setCustomNotificationHandler(m, z.object({}), () => {})).not.toThrow();
        }
    });

    test('removeCustomRequestHandler -> subsequent request fails MethodNotFound', async () => {
        server.setCustomRequestHandler('acme/search', SearchParams, () => ({ hits: [], total: 0 }));
        await client.sendCustomRequest('acme/search', { query: 'x' }, SearchResult);

        server.removeCustomRequestHandler('acme/search');
        await expect(client.sendCustomRequest('acme/search', { query: 'x' }, SearchResult)).rejects.toSatisfy(
            (e: unknown) => e instanceof ProtocolError && e.code === ProtocolErrorCode.MethodNotFound
        );
    });

    test('double-register -> last wins', async () => {
        server.setCustomRequestHandler('acme/v', z.object({}), () => ({ v: 1 }));
        server.setCustomRequestHandler('acme/v', z.object({}), () => ({ v: 2 }));
        const result = await client.sendCustomRequest('acme/v', {}, z.object({ v: z.number() }));
        expect(result.v).toBe(2);
    });
});

describe('custom notification handlers', () => {
    let client: TestProtocol;
    let server: TestProtocol;

    beforeEach(async () => {
        [client, server] = await linkedPair();
    });

    test('handler invoked with typed params', async () => {
        const received: string[] = [];
        client.setCustomNotificationHandler('acme/status', StatusParams, params => {
            received.push(params.status);
        });

        await server.sendCustomNotification('acme/status', { status: 'busy' });
        await server.sendCustomNotification('acme/status', { status: 'idle' });
        await vi.waitFor(() => expect(received).toEqual(['busy', 'idle']));
    });

    test('collision guard: throws on standard notification method', () => {
        expect(() => client.setCustomNotificationHandler('notifications/cancelled', z.object({}), () => {})).toThrow(
            /standard MCP notification method/
        );
        expect(() => client.setCustomNotificationHandler('notifications/progress', z.object({}), () => {})).toThrow(
            /standard MCP notification method/
        );
        expect(() => client.removeCustomNotificationHandler('notifications/initialized')).toThrow(/standard MCP notification method/);
    });

    test('removeCustomNotificationHandler -> subsequent notifications not delivered', async () => {
        const handler = vi.fn();
        client.setCustomNotificationHandler('acme/status', StatusParams, handler);
        await server.sendCustomNotification('acme/status', { status: 'busy' });
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

        client.removeCustomNotificationHandler('acme/status');
        await server.sendCustomNotification('acme/status', { status: 'idle' });
        // Give the event loop a tick; handler should not be called again.
        await new Promise(r => setTimeout(r, 10));
        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('invalid params -> handler not invoked, error surfaced via onerror', async () => {
        const handler = vi.fn();
        const errors: Error[] = [];
        client.setCustomNotificationHandler('acme/status', StatusParams, handler);
        client.onerror = e => errors.push(e);

        await server.sendCustomNotification('acme/status', { status: 'unknown' });
        await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
        expect(handler).not.toHaveBeenCalled();
    });
});

describe('sendCustomRequest', () => {
    test('not connected -> rejects', async () => {
        const proto = new TestProtocol();
        await expect(proto.sendCustomRequest('acme/x', {}, z.object({}))).rejects.toThrow(/Not connected/);
    });

    test('undefined params accepted', async () => {
        const [client, server] = await linkedPair();
        server.setCustomRequestHandler('acme/noargs', z.undefined().or(z.object({})), () => ({ ok: true }));
        const result = await client.sendCustomRequest('acme/noargs', undefined, z.object({ ok: z.boolean() }));
        expect(result.ok).toBe(true);
    });

    test('result validated against resultSchema', async () => {
        const [client, server] = await linkedPair();
        server.setCustomRequestHandler('acme/badresult', z.object({}), () => ({ hits: 'not-an-array', total: 0 }));
        await expect(client.sendCustomRequest('acme/badresult', {}, SearchResult)).rejects.toThrow();
    });
});

describe('sendCustomNotification', () => {
    test('not connected -> throws SdkError NotConnected', async () => {
        const proto = new TestProtocol();
        await expect(proto.sendCustomNotification('acme/x', {})).rejects.toSatisfy(
            (e: unknown) => e instanceof SdkError && e.code === SdkErrorCode.NotConnected
        );
    });

    test('delivered to peer with no handler -> no error thrown on sender', async () => {
        const [client, server] = await linkedPair();
        const errors: Error[] = [];
        client.onerror = e => errors.push(e);
        await expect(server.sendCustomNotification('acme/unhandled', { x: 1 })).resolves.toBeUndefined();
    });
});
