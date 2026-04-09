import { InMemoryTransport, type JSONRPCMessage, SdkError, SdkErrorCode } from '@modelcontextprotocol/core';
import { describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

import { Server } from '../../src/server/server.js';

/**
 * These tests exercise the `Server.extension()` factory and the server side of the
 * `capabilities.extensions` round-trip via `initialize`. The `ExtensionHandle` class itself is
 * unit-tested in `@modelcontextprotocol/core/test/shared/extensionHandle.test.ts`.
 */

async function rawInitialize(
    clientSide: InMemoryTransport,
    clientCapabilities: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
        clientSide.onmessage = (msg: JSONRPCMessage) => {
            if ('id' in msg && msg.id === 1) {
                if ('result' in msg) resolve(msg.result as Record<string, unknown>);
                else if ('error' in msg) reject(new Error(JSON.stringify(msg.error)));
            }
        };
    });
    await clientSide.start();
    await clientSide.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2025-11-25',
            capabilities: clientCapabilities,
            clientInfo: { name: 'raw-client', version: '0.0.0' }
        }
    });
    return result;
}

describe('Server.extension()', () => {
    test('merges settings into capabilities.extensions and advertises them in initialize result', async () => {
        const server = new Server({ name: 's', version: '1.0.0' }, { capabilities: {} });
        server.extension('io.example/ui', { contentTypes: ['text/html'] });
        server.extension('com.acme/widgets', { v: 2 });

        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        const result = await rawInitialize(clientSide);

        const caps = result.capabilities as Record<string, unknown>;
        expect(caps.extensions).toEqual({
            'io.example/ui': { contentTypes: ['text/html'] },
            'com.acme/widgets': { v: 2 }
        });
    });

    test('throws AlreadyConnected after connect()', async () => {
        const server = new Server({ name: 's', version: '1.0.0' });
        const [, serverSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);

        expect(() => server.extension('io.example/ui', {})).toThrow(SdkError);
        try {
            server.extension('io.example/ui', {});
            expect.fail('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(SdkError);
            expect((e as SdkError).code).toBe(SdkErrorCode.AlreadyConnected);
        }
    });

    test("getPeerSettings() reads the client's capabilities.extensions[id] after initialize", async () => {
        const PeerSchema = z.object({ availableDisplayModes: z.array(z.string()) });
        const server = new Server({ name: 's', version: '1.0.0' });
        const handle = server.extension('io.example/ui', { hostSide: true }, { peerSchema: PeerSchema });

        expect(handle.getPeerSettings()).toBeUndefined();

        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        await rawInitialize(clientSide, {
            extensions: { 'io.example/ui': { availableDisplayModes: ['inline', 'fullscreen'] } }
        });

        expect(handle.getPeerSettings()).toEqual({ availableDisplayModes: ['inline', 'fullscreen'] });
    });

    test('handle.setRequestHandler can be called after connect()', async () => {
        const server = new Server({ name: 's', version: '1.0.0' });
        const handle = server.extension('io.example/ui', {});
        const [, serverSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);

        expect(() => handle.setRequestHandler('ui/late', z.object({}), () => ({}))).not.toThrow();
    });
});
