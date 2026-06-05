import { describe, it, expect, vi } from 'vitest';
import type { JSONRPCRequest, JSONRPCResultResponse } from '@modelcontextprotocol/core';
import { BridgeTransport } from '../../src/server/bridgeTransport.js';

describe('BridgeTransport', () => {
    it('start() resolves immediately', async () => {
        const bridge = new BridgeTransport();
        await expect(bridge.start()).resolves.toBeUndefined();
    });

    it('injectIncoming delivers message via onmessage callback', () => {
        const bridge = new BridgeTransport();
        const onmessage = vi.fn();
        bridge.onmessage = onmessage;

        const request: JSONRPCRequest = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'hello' }
        };
        bridge.injectIncoming(request);
        expect(onmessage).toHaveBeenCalledWith(request, undefined);
    });

    it('injectIncoming passes extra info', () => {
        const bridge = new BridgeTransport();
        const onmessage = vi.fn();
        bridge.onmessage = onmessage;

        const request: JSONRPCRequest = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {}
        };
        const extra = { authInfo: { token: 'xyz', clientId: 'test', scopes: [] } };
        bridge.injectIncoming(request, extra);
        expect(onmessage).toHaveBeenCalledWith(request, extra);
    });

    it('send() delivers message via onOutgoing callback', async () => {
        const bridge = new BridgeTransport();
        const onOutgoing = vi.fn();
        bridge.onOutgoing = onOutgoing;

        const response: JSONRPCResultResponse = {
            jsonrpc: '2.0',
            id: 1,
            result: { content: [] }
        };
        await bridge.send(response);
        expect(onOutgoing).toHaveBeenCalledWith(response);
    });

    it('close() fires onclose callback', async () => {
        const bridge = new BridgeTransport();
        const onclose = vi.fn();
        bridge.onclose = onclose;

        await bridge.close();
        expect(onclose).toHaveBeenCalled();
    });

    it('injectIncoming is a no-op when onmessage is not set', () => {
        const bridge = new BridgeTransport();
        bridge.injectIncoming({ jsonrpc: '2.0', id: 1, method: 'test', params: {} });
    });

    it('send is a no-op when onOutgoing is not set', async () => {
        const bridge = new BridgeTransport();
        await bridge.send({ jsonrpc: '2.0', id: 1, result: {} });
    });
});
