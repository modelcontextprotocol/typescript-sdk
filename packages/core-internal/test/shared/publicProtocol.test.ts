/**
 * Behavior-surface pin: the `Protocol` base class is public API.
 *
 * Consumers that run their own JSON-RPC protocol on the SDK engine (e.g. the
 * MCP Apps SDK's `ui/initialize` handshake over postMessage) extend `Protocol`
 * directly instead of `Client`/`Server`, because the role classes force the
 * MCP `initialize` handshake onto channels whose deployed peers do not speak
 * it. This pins the two properties that contract depends on:
 *
 *   1. `Protocol` and `mergeCapabilities` are exported from the curated
 *      public barrel (and therefore from the client and server package roots).
 *   2. A `Protocol` subclass pair can connect and exchange a custom method
 *      without any MCP `initialize` appearing on the wire.
 */
import { describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

import type { BaseContext } from '../../src/exports/public/index';
import { InMemoryTransport, mergeCapabilities, Protocol } from '../../src/exports/public/index';
import type { JSONRPCMessage } from '../../src/types/types';

class TestProtocol extends Protocol<BaseContext> {
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
}

describe('public Protocol class', () => {
    test('Protocol and mergeCapabilities are exported from the public barrel', () => {
        expect(typeof Protocol).toBe('function');
        expect(typeof mergeCapabilities).toBe('function');
    });

    test('a Protocol subclass exchanges custom methods with no initialize on the wire', async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        // Capture BOTH directions: the accepting side must be as silent as the
        // requesting side — deployed peers understand nothing but the custom
        // methods.
        const sentByA: string[] = [];
        const sentByB: string[] = [];
        const captureSends = (transport: InMemoryTransport, into: string[]) => {
            const originalSend = transport.send.bind(transport);
            transport.send = async (message: JSONRPCMessage, options) => {
                if ('method' in message) into.push(message.method);
                return originalSend(message, options);
            };
        };
        captureSends(clientTransport, sentByA);
        captureSends(serverTransport, sentByB);

        const a = new TestProtocol();
        const b = new TestProtocol();
        b.setRequestHandler('acme/echo', { params: z.object({ value: z.string() }) }, params => ({
            echoed: params.value
        }));

        await b.connect(serverTransport);
        await a.connect(clientTransport);
        const result = await a.request({ method: 'acme/echo', params: { value: 'hi' } }, z.object({ echoed: z.string() }));

        expect(result).toEqual({ echoed: 'hi' });
        expect(sentByA).toEqual(['acme/echo']);
        expect(sentByB).toEqual([]);
    });
});
