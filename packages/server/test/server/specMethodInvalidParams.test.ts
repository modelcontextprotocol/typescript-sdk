import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { describe, expect, test } from 'vitest';

import { Server } from '../../src/server/server';

/**
 * Spec-method requests with schema-invalid params are the caller's error:
 * they answer -32602 Invalid params, not -32603 Internal error.
 * (modelcontextprotocol/typescript-sdk#2284 — the Zod parse used to throw
 * out of the handler and the funnel surfaced it as an internal error.)
 */
describe('spec-method invalid params surface', () => {
    test('logging/setLevel with an invalid level answers -32602 Invalid params', async () => {
        const [peerTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const server = new Server({ name: 'test server', version: '1.0.0' }, { capabilities: { logging: {} } });
        server.setRequestHandler('logging/setLevel', async () => ({}));
        await server.connect(serverTransport);

        const responses: Array<{ id?: number; error?: { code: number; message: string } }> = [];
        peerTransport.onmessage = message => void responses.push(message as (typeof responses)[number]);
        await peerTransport.start();

        await peerTransport.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'client', version: '1.0.0' } }
        } as never);
        await new Promise(resolve => setTimeout(resolve, 25));
        await peerTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);
        await new Promise(resolve => setTimeout(resolve, 25));

        await peerTransport.send({ jsonrpc: '2.0', id: 2, method: 'logging/setLevel', params: { level: 'not-a-level' } } as never);
        await new Promise(resolve => setTimeout(resolve, 50));

        const response = responses.find(message => message.id === 2);
        expect(response?.error).toBeDefined();
        expect(response?.error?.code).toBe(-32602);
        expect(response?.error?.message).toContain('Invalid params for logging/setLevel');

        await server.close();
    });
});

