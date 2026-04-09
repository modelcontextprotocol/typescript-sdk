import { InMemoryTransport, type JSONRPCMessage, SdkError, SdkErrorCode } from '@modelcontextprotocol/core';
import { describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

import { Client } from '../../src/client/client.js';

/**
 * These tests exercise the `Client.extension()` factory and the client side of the
 * `capabilities.extensions` round-trip via `initialize`. The `ExtensionHandle` class itself is
 * unit-tested in `@modelcontextprotocol/core/test/shared/extensionHandle.test.ts`.
 */

interface RawServerHarness {
    serverSide: InMemoryTransport;
    capturedInitParams: Promise<Record<string, unknown>>;
}

function rawServer(serverCapabilities: Record<string, unknown> = {}): RawServerHarness {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    let resolveInit: (p: Record<string, unknown>) => void;
    const capturedInitParams = new Promise<Record<string, unknown>>(r => {
        resolveInit = r;
    });
    serverSide.onmessage = (msg: JSONRPCMessage) => {
        if ('method' in msg && msg.method === 'initialize' && 'id' in msg) {
            resolveInit((msg.params ?? {}) as Record<string, unknown>);
            void serverSide.send({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                    protocolVersion: '2025-11-25',
                    capabilities: serverCapabilities,
                    serverInfo: { name: 'raw-server', version: '0.0.0' }
                }
            });
        }
    };
    void serverSide.start();
    // Expose clientSide via the harness's serverSide.peer for the test to connect to.
    return { serverSide: clientSide, capturedInitParams };
}

describe('Client.extension()', () => {
    test('merges settings into capabilities.extensions and advertises them in initialize request', async () => {
        const client = new Client({ name: 'c', version: '1.0.0' }, { capabilities: {} });
        client.extension('io.example/ui', { contentTypes: ['text/html'] });
        client.extension('com.acme/widgets', { v: 2 });

        const harness = rawServer();
        await client.connect(harness.serverSide);
        const initParams = await harness.capturedInitParams;

        const caps = initParams.capabilities as Record<string, unknown>;
        expect(caps.extensions).toEqual({
            'io.example/ui': { contentTypes: ['text/html'] },
            'com.acme/widgets': { v: 2 }
        });
    });

    test('throws AlreadyConnected after connect()', async () => {
        const client = new Client({ name: 'c', version: '1.0.0' });
        const harness = rawServer();
        await client.connect(harness.serverSide);

        expect(() => client.extension('io.example/ui', {})).toThrow(SdkError);
        try {
            client.extension('io.example/ui', {});
            expect.fail('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(SdkError);
            expect((e as SdkError).code).toBe(SdkErrorCode.AlreadyConnected);
        }
    });

    test('throws on duplicate extension id', () => {
        const client = new Client({ name: 'c', version: '1.0.0' });
        client.extension('io.example/ui', { v: 1 });
        expect(() => client.extension('io.example/ui', { v: 2 })).toThrow(/already registered/);
        expect(() => client.extension('com.other/thing', {})).not.toThrow();
    });

    test("getPeerSettings() reads the server's capabilities.extensions[id] from initialize result", async () => {
        const PeerSchema = z.object({ availableDisplayModes: z.array(z.string()) });
        const client = new Client({ name: 'c', version: '1.0.0' });
        const handle = client.extension('io.example/ui', { clientSide: true }, { peerSchema: PeerSchema });

        expect(handle.getPeerSettings()).toBeUndefined();

        const harness = rawServer({
            extensions: { 'io.example/ui': { availableDisplayModes: ['inline', 'fullscreen'] } }
        });
        await client.connect(harness.serverSide);

        expect(handle.getPeerSettings()).toEqual({ availableDisplayModes: ['inline', 'fullscreen'] });
    });

    test('getPeerSettings() reflects reconnect to a different server', async () => {
        const client = new Client({ name: 'c', version: '1.0.0' });
        const handle = client.extension('io.example/ui', {});

        const harnessA = rawServer({ extensions: { 'io.example/ui': { v: 1 } } });
        await client.connect(harnessA.serverSide);
        expect(handle.getPeerSettings()).toEqual({ v: 1 });

        await client.close();

        const harnessB = rawServer({ extensions: { 'io.example/ui': { v: 2 } } });
        await client.connect(harnessB.serverSide);
        expect(handle.getPeerSettings()).toEqual({ v: 2 });
    });
});
