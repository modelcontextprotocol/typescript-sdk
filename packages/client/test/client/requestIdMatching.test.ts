import type { JSONRPCRequest } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client';

const initializeResult = {
    protocolVersion: '2025-11-25',
    capabilities: {},
    serverInfo: { name: 'id-matching-peer', version: '1.0.0' }
};

async function startHandshake() {
    const client = new Client({ name: 'id-matching-client', version: '1.0.0' });
    const [clientTransport, peerTransport] = InMemoryTransport.createLinkedPair();
    const errors: Error[] = [];
    const progress: unknown[] = [];
    client.onerror = error => errors.push(error);
    let resolveRequest!: (request: JSONRPCRequest) => void;
    const requestReceived = new Promise<JSONRPCRequest>(resolve => {
        resolveRequest = resolve;
    });
    peerTransport.onmessage = message => {
        if ('method' in message && message.method === 'initialize' && 'id' in message) {
            resolveRequest(message);
        }
    };
    await peerTransport.start();
    let settled = false;
    const connected = client.connect(clientTransport, { onprogress: value => progress.push(value) });
    void connected.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        }
    );
    const request = await requestReceived;
    expect(request.id).toBe(0);
    return { client, peerTransport, connected, request, errors, progress, isSettled: () => settled };
}

describe('request identifier matching', () => {
    for (const kind of ['result', 'error'] as const) {
        it.each(['', ' ', '0', '0.0', '0x0', 'unrelated', 999])(`ignores an unmatched ${kind} response with id %j`, async id => {
            const state = await startHandshake();
            try {
                await state.peerTransport.send(
                    kind === 'result'
                        ? { jsonrpc: '2.0', id, result: initializeResult }
                        : { jsonrpc: '2.0', id, error: { code: -32603, message: 'Unrelated request failed' } }
                );
                await setImmediate();
                expect(state.isSettled()).toBe(false);
                expect(state.errors).toHaveLength(1);
                expect(state.errors[0]!.message).toContain('unknown message ID');

                await state.peerTransport.send({ jsonrpc: '2.0', id: state.request.id, result: initializeResult });
                await expect(state.connected).resolves.toBeUndefined();
            } finally {
                await state.client.close();
            }
        });
    }

    it.each(['', ' ', '0', '0.0', '0x0', 'unrelated', 999])('ignores an unmatched progress token %j', async progressToken => {
        const state = await startHandshake();
        try {
            await state.peerTransport.send({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: { progressToken, progress: 1 }
            });
            await setImmediate();
            expect(state.progress).toEqual([]);
            expect(state.errors).toHaveLength(1);
            expect(state.errors[0]!.message).toContain('unknown token');
            expect(state.isSettled()).toBe(false);

            await state.peerTransport.send({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: { progressToken: state.request.id, progress: 2 }
            });
            await setImmediate();
            expect(state.progress).toEqual([{ progress: 2 }]);
            await state.peerTransport.send({ jsonrpc: '2.0', id: state.request.id, result: initializeResult });
            await expect(state.connected).resolves.toBeUndefined();
        } finally {
            await state.client.close();
        }
    });

    it('ignores an error response without an identifier', async () => {
        const state = await startHandshake();
        try {
            await state.peerTransport.send({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
            await setImmediate();
            expect(state.isSettled()).toBe(false);
            expect(state.errors).toHaveLength(1);
            expect(state.errors[0]!.message).toContain('unknown message ID');
            await state.peerTransport.send({ jsonrpc: '2.0', id: state.request.id, result: initializeResult });
            await expect(state.connected).resolves.toBeUndefined();
        } finally {
            await state.client.close();
        }
    });

    it('accepts a result with the matching numeric identifier', async () => {
        const state = await startHandshake();
        try {
            await state.peerTransport.send({ jsonrpc: '2.0', id: state.request.id, result: initializeResult });
            await expect(state.connected).resolves.toBeUndefined();
            expect(state.errors).toEqual([]);
        } finally {
            await state.client.close();
        }
    });

    it('rejects an error with the matching numeric identifier', async () => {
        const state = await startHandshake();
        try {
            await state.peerTransport.send({
                jsonrpc: '2.0',
                id: state.request.id,
                error: { code: -32603, message: 'Initialization failed' }
            });
            await expect(state.connected).rejects.toThrow('Initialization failed');
            expect(state.errors).toEqual([]);
        } finally {
            await state.client.close();
        }
    });
});
