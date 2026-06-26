/**
 * SEP-2133 generic extension helpers — `enableExtension` / `getServerExtension`
 * on `Client`. Mirrors the server-side helpers in `@modelcontextprotocol/server`.
 */
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client';

const UI = 'io.modelcontextprotocol/ui';

describe('Client.enableExtension / getServerExtension', () => {
    it('writes ClientCapabilities.extensions[identifier] and reads the server mirror after connect', async () => {
        const client = new Client({ name: 'c', version: '1.0.0' });
        client.enableExtension(UI);
        client.enableExtension('vendor.example/thing', { mode: 'fast' });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        // Minimal hand-rolled server end: answer `initialize`, echoing back an
        // `extensions` declaration so `getServerExtension` has something to read.
        let sawClientExtensions: unknown;
        serverTransport.onmessage = msg => {
            if ('method' in msg && msg.method === 'initialize' && 'id' in msg) {
                sawClientExtensions = (msg.params as { capabilities?: { extensions?: unknown } }).capabilities?.extensions;
                void serverTransport.send({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: {
                        protocolVersion: (msg.params as { protocolVersion: string }).protocolVersion,
                        serverInfo: { name: 's', version: '1.0.0' },
                        capabilities: { extensions: { [UI]: { contentTypes: ['text/html'] } } }
                    }
                });
            }
        };
        await serverTransport.start();

        await client.connect(clientTransport);

        expect(sawClientExtensions).toEqual({ [UI]: {}, 'vendor.example/thing': { mode: 'fast' } });
        expect(client.getServerExtension(UI)).toEqual({ contentTypes: ['text/html'] });
        expect(client.getServerExtension('absent/key')).toBeUndefined();

        expect(() => client.enableExtension('late/key')).toThrow(/after connecting/);
        await client.close();
    });
});
