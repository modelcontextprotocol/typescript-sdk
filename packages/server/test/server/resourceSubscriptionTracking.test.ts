import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '../../src/index';
import { errorOf, legacyInitialize, resultOf, wireLegacy } from './legacyShimHarness';

const subscribeRequest = (id: number, uri: string) => ({ jsonrpc: '2.0', id, method: 'resources/subscribe', params: { uri } }) as const;
const unsubscribeRequest = (id: number, uri: string) => ({ jsonrpc: '2.0', id, method: 'resources/unsubscribe', params: { uri } }) as const;

describe('trackResourceSubscriptions', () => {
    it('a declared resources.subscribe capability auto-installs tracking at connect', async () => {
        // Declaring the capability is the whole opt-in: connect() installs the
        // SDK's subscribe/unsubscribe handlers when nothing else claimed them.
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { resources: { subscribe: true } } });
        const wire = await wireLegacy(server);
        await wire.request(legacyInitialize(1));

        const subscribed = await wire.request(subscribeRequest(2, 'demo://a'));
        expect(resultOf(subscribed)).toEqual({});
        expect([...server.resourceSubscriptions]).toEqual(['demo://a']);

        const unsubscribed = await wire.request(unsubscribeRequest(3, 'demo://a'));
        expect(resultOf(unsubscribed)).toEqual({});
        expect(server.resourceSubscriptions.size).toBe(0);

        await server.close();
    });

    it('baseline: no capability and no explicit call leaves resources/subscribe method-not-found', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' });
        const wire = await wireLegacy(server);
        await wire.request(legacyInitialize(1));

        const response = await wire.request(subscribeRequest(2, 'demo://a'));
        expect(errorOf(response)).toEqual({ code: -32601, message: 'Method not found' });
        expect(server.resourceSubscriptions.size).toBe(0);

        await server.close();
    });

    it('a hand-registered resources/subscribe handler wins over the automatic install', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { resources: { subscribe: true } } });
        const manualUris: string[] = [];
        server.server.setRequestHandler('resources/subscribe', request => {
            manualUris.push(request.params.uri);
            return {};
        });

        const wire = await wireLegacy(server);
        await wire.request(legacyInitialize(1));

        const subscribed = await wire.request(subscribeRequest(2, 'demo://a'));
        expect(resultOf(subscribed)).toEqual({});
        expect(manualUris).toEqual(['demo://a']);
        // The SDK's tracking stayed out of the way entirely.
        expect(server.resourceSubscriptions.size).toBe(0);
        // The automatic install skips as a pair: the sibling verb keeps its
        // pre-existing behavior instead of getting half of the SDK's pair.
        expect(errorOf(await wire.request(unsubscribeRequest(3, 'demo://a'))).code).toBe(-32601);

        await server.close();
    });

    it('auto-tracking also serves low-level servers that answer list/read themselves', async () => {
        // The explicit call refuses this posture (it installs the registry-backed
        // list/read handlers); the automatic arm only adds the subscribe pair, so
        // declaring the capability is enough for hand-rolled resource servers.
        const server = new McpServer({ name: 's', version: '1.0.0' });
        server.server.registerCapabilities({ resources: { subscribe: true } });
        server.server.setRequestHandler('resources/list', () => ({ resources: [] }));

        const wire = await wireLegacy(server);
        await wire.request(legacyInitialize(1));

        const subscribed = await wire.request(subscribeRequest(2, 'demo://a'));
        expect(resultOf(subscribed)).toEqual({});
        expect([...server.resourceSubscriptions]).toEqual(['demo://a']);

        await server.close();
    });

    it('records subscribed URIs and removes them on unsubscribe', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' });
        server.trackResourceSubscriptions();
        const wire = await wireLegacy(server);
        await wire.request(legacyInitialize(1));

        const subscribed = await wire.request(subscribeRequest(2, 'demo://a'));
        expect(resultOf(subscribed)).toEqual({});
        expect([...server.resourceSubscriptions]).toEqual(['demo://a']);

        await wire.request(subscribeRequest(3, 'demo://b'));
        expect([...server.resourceSubscriptions].sort()).toEqual(['demo://a', 'demo://b']);

        const unsubscribed = await wire.request(unsubscribeRequest(4, 'demo://a'));
        expect(resultOf(unsubscribed)).toEqual({});
        expect([...server.resourceSubscriptions]).toEqual(['demo://b']);

        await server.close();
    });

    it('onSubscribe veto propagates as the handler error and leaves the set unchanged', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' });
        server.trackResourceSubscriptions({
            onSubscribe: uri => {
                if (uri.startsWith('secret://')) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Subscriptions to ${uri} are refused`);
                }
            }
        });
        const wire = await wireLegacy(server);
        await wire.request(legacyInitialize(1));

        const refused = await wire.request(subscribeRequest(2, 'secret://a'));
        expect(errorOf(refused).code).toBe(ProtocolErrorCode.InvalidParams);
        expect(errorOf(refused).message).toContain('Subscriptions to secret://a are refused');
        expect(server.resourceSubscriptions.size).toBe(0);

        // The veto is per-URI: a URI the hook allows is still recorded.
        const allowed = await wire.request(subscribeRequest(3, 'demo://a'));
        expect(resultOf(allowed)).toEqual({});
        expect([...server.resourceSubscriptions]).toEqual(['demo://a']);

        await server.close();
    });

    it('onUnsubscribe veto keeps the subscription in place', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' });
        server.trackResourceSubscriptions({
            onUnsubscribe: () => {
                throw new Error('unsubscribe refused');
            }
        });
        const wire = await wireLegacy(server);
        await wire.request(legacyInitialize(1));

        await wire.request(subscribeRequest(2, 'demo://a'));
        expect([...server.resourceSubscriptions]).toEqual(['demo://a']);

        const refused = await wire.request(unsubscribeRequest(3, 'demo://a'));
        expect(errorOf(refused).message).toContain('unsubscribe refused');
        expect([...server.resourceSubscriptions]).toEqual(['demo://a']);

        await server.close();
    });

    it('sendResourceUpdated facade delivers notifications/resources/updated with the uri', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' });
        server.trackResourceSubscriptions();
        const wire = await wireLegacy(server);
        await wire.request(legacyInitialize(1));

        await wire.request(subscribeRequest(2, 'demo://a'));
        await server.sendResourceUpdated({ uri: 'demo://a' });

        await vi.waitFor(() => expect(wire.notifications.some(n => n.method === 'notifications/resources/updated')).toBe(true));
        const notification = wire.notifications.find(n => n.method === 'notifications/resources/updated');
        expect(notification?.params?.uri).toBe('demo://a');

        await server.close();
    });

    it('a request cancelled during the onSubscribe hook does not record the subscription', async () => {
        let releaseHook!: () => void;
        const hookGate = new Promise<void>(resolve => (releaseHook = resolve));
        let hookSignal: AbortSignal | undefined;

        const server = new McpServer({ name: 's', version: '1.0.0' });
        server.trackResourceSubscriptions({
            onSubscribe: async (_uri, ctx) => {
                hookSignal = ctx.mcpReq.signal;
                await hookGate;
            }
        });
        const wire = await wireLegacy(server);
        await wire.request(legacyInitialize(1));

        // The response of a cancelled request is suppressed, so do not await it.
        void wire.request(subscribeRequest(2, 'demo://a'));
        await vi.waitFor(() => expect(hookSignal).toBeDefined());

        await wire.notifyFromPeer({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'test' } });
        await vi.waitFor(() => expect(hookSignal?.aborted).toBe(true));

        // Only now does the hook return — the handler resumes on an already-
        // aborted request and must leave the set unchanged.
        releaseHook();
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(server.resourceSubscriptions.size).toBe(0);

        await server.close();
    });

    it('calling trackResourceSubscriptions twice throws via the duplicate-handler guard', () => {
        const server = new McpServer({ name: 's', version: '1.0.0' });
        server.trackResourceSubscriptions();
        expect(() => server.trackResourceSubscriptions()).toThrow(
            'A request handler for resources/subscribe already exists, which would be overridden'
        );
    });

    it('declares the resources.subscribe capability, merged with existing resources bits', async () => {
        // No resources capability declared anywhere: tracking declares it (and
        // installs the resource handlers a declared capability requires).
        const bare = new McpServer({ name: 's', version: '1.0.0' });
        bare.trackResourceSubscriptions();
        expect(bare.server.getCapabilities().resources?.subscribe).toBe(true);

        // Previously declared bits survive the merge and reach the client on initialize.
        const declared = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { resources: { listChanged: true } } });
        declared.trackResourceSubscriptions();
        expect(declared.server.getCapabilities().resources).toEqual({ listChanged: true, subscribe: true });

        const wire = await wireLegacy(declared);
        const initialized = resultOf(await wire.request(legacyInitialize(1))) as {
            capabilities?: { resources?: Record<string, unknown> };
        };
        expect(initialized.capabilities?.resources).toEqual({ listChanged: true, subscribe: true });

        await declared.close();
    });

    it('throws when called after connecting (capabilities are fixed at connect time)', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' });
        await wireLegacy(server);

        expect(() => server.trackResourceSubscriptions()).toThrow('Cannot register capabilities after connecting to transport');

        await server.close();
    });

    it('throws without declaring the capability when low-level resource handlers are already installed', async () => {
        // A server answering resources/list at the low level conflicts with the
        // registry-backed handlers this method installs; the throw must leave no
        // trace — advertising resources.subscribe with no subscribe handler would
        // be the worst of both worlds.
        const server = new McpServer({ name: 's', version: '1.0.0' });
        server.server.registerCapabilities({ resources: {} });
        server.server.setRequestHandler('resources/list', () => ({ resources: [] }));

        expect(() => server.trackResourceSubscriptions()).toThrow('A request handler for resources/list already exists');
        expect(server.server.getCapabilities().resources?.subscribe).toBeUndefined();

        const wire = await wireLegacy(server);
        await wire.request(legacyInitialize(1));
        expect(errorOf(await wire.request(subscribeRequest(2, 'demo://a'))).code).toBe(-32601);

        await server.close();
    });

    it('reconnect is idempotent: no duplicate-handler throw, and the set resets each connect', async () => {
        // Auto path: the first connect installs the handlers; the second finds
        // them already installed and only clears the connection-scoped set.
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { resources: { subscribe: true } } });

        const first = await wireLegacy(server);
        await first.request(legacyInitialize(1));
        await first.request(subscribeRequest(2, 'demo://a'));
        expect([...server.resourceSubscriptions]).toEqual(['demo://a']);
        await first.close();

        // Reconnecting the same instance serves a NEW client; the previous
        // client's subscriptions must not survive into the new connection.
        const second = await wireLegacy(server);
        await second.request(legacyInitialize(1));
        expect(server.resourceSubscriptions.size).toBe(0);

        // The surviving handlers still work on the new connection.
        await second.request(subscribeRequest(2, 'demo://b'));
        expect([...server.resourceSubscriptions]).toEqual(['demo://b']);

        await server.close();
    });
});
