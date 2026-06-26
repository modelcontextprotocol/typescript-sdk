/**
 * SEP-2133 generic extension helpers — `enableExtension` / `getClientExtension`
 * on `McpServer`. Thin convenience over `registerCapabilities` /
 * `getClientCapabilities`; the helpers are not Apps-specific.
 */
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { McpServer } from '../../src/server/mcp';

const UI = 'io.modelcontextprotocol/ui';

describe('McpServer.enableExtension', () => {
    it('writes ServerCapabilities.extensions[identifier], defaulting settings to {}', () => {
        const server = new McpServer({ name: 's', version: '1.0.0' });
        server.enableExtension(UI);
        server.enableExtension('vendor.example/thing', { mode: 'fast' });
        expect(server.server.getCapabilities().extensions).toEqual({
            [UI]: {},
            'vendor.example/thing': { mode: 'fast' }
        });
    });

    it('throws after connecting (delegates to registerCapabilities)', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' });
        const [, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        expect(() => server.enableExtension(UI)).toThrow(/after connecting/);
        await server.close();
    });
});

describe('McpServer.getClientExtension', () => {
    it('reads ClientCapabilities.extensions[identifier] after a legacy initialize', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);

        // Drive a 2025-era initialize from the client side carrying an
        // `extensions` declaration (open-set; passes through the 2025 codec).
        clientTransport.onmessage = () => {};
        await clientTransport.start();
        await clientTransport.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                clientInfo: { name: 'c', version: '1.0.0' },
                capabilities: { extensions: { [UI]: { maxWidth: 800 } } }
            }
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(server.getClientExtension(UI)).toEqual({ maxWidth: 800 });
        expect(server.getClientExtension('absent/key')).toBeUndefined();
        await server.close();
    });
});
