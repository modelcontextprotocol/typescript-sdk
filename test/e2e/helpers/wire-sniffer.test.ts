import { LATEST_LEGACY_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { assertWireMessage } from './wire-sniffer';

const req = (method: string, params?: unknown, id = 1) => ({
    jsonrpc: '2.0' as const,
    id,
    method,
    ...(params === undefined ? {} : { params })
});
const notif = (method: string, params?: unknown) => ({ jsonrpc: '2.0' as const, method, ...(params === undefined ? {} : { params }) });
const resp = (result: unknown, id = 1) => ({ jsonrpc: '2.0' as const, id, result });

describe('assertWireMessage', () => {
    it('accepts a valid client initialize request', () => {
        expect(() =>
            assertWireMessage(
                req('initialize', {
                    protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION,
                    capabilities: {},
                    clientInfo: { name: 'c', version: '0' }
                }),
                'client'
            )
        ).not.toThrow();
    });

    it('accepts a valid client tools/list result on the server→client return', () => {
        // server sends the ListToolsResult back
        expect(() => assertWireMessage(resp({ tools: [] }), 'server')).not.toThrow();
    });

    it('accepts a valid client ping and the empty result', () => {
        expect(() => assertWireMessage(req('ping'), 'client')).not.toThrow();
        expect(() => assertWireMessage(resp({}), 'server')).not.toThrow();
    });

    it('rejects a non-JSON-RPC envelope', () => {
        expect(() => assertWireMessage({ jsonrpc: '1.0', id: 1, method: 'ping' }, 'client')).toThrow(/not a JSON-RPC message/);
    });

    it('rejects an unknown method without allowCustomMethods', () => {
        expect(() => assertWireMessage(req('x/custom', { a: 1 }), 'client')).toThrow(/non-spec request method 'x\/custom'/);
    });

    it('accepts an unknown method with allowCustomMethods', () => {
        expect(() => assertWireMessage(req('x/custom', { a: 1 }), 'client', { allowCustomMethods: true })).not.toThrow();
    });

    it('rejects a spec method with malformed params under strict, accepts with strictValidation:false', () => {
        const bad = notif('notifications/progress', { progressToken: 1, progress: 'not-a-number' });
        expect(() => assertWireMessage(bad, 'client')).toThrow(/params do not conform/);
        expect(() => assertWireMessage(bad, 'client', { strictValidation: false })).not.toThrow();
    });

    it('rejects a server-only request sent by the client (direction check)', () => {
        // sampling/createMessage is a Server→Client request; the client must not originate it
        expect(() => assertWireMessage(req('sampling/createMessage', { messages: [], maxTokens: 1 }), 'client')).toThrow(
            /non-spec request method 'sampling\/createMessage'/
        );
    });

    it('accepts that same request when the server sends it', () => {
        expect(() => assertWireMessage(req('sampling/createMessage', { messages: [], maxTokens: 1 }), 'server')).not.toThrow();
    });

    it('rejects an input_required server result unless the cell opted in (modern-era arms only)', () => {
        const inputRequired = resp({
            resultType: 'input_required',
            inputRequests: { ask: { method: 'elicitation/create', params: { mode: 'form', message: 'Name?' } } }
        });
        // Default (legacy-era cells): input_required is not legal wire vocabulary.
        expect(() => assertWireMessage(inputRequired, 'server')).toThrow(/invalid message/);
        // Modern-era arms opt in explicitly.
        expect(() => assertWireMessage(inputRequired, 'server', { allowInputRequiredResults: true })).not.toThrow();
        // The opt-in never applies to client-sent results.
        expect(() => assertWireMessage(inputRequired, 'client', { allowInputRequiredResults: true })).toThrow(/invalid message/);
    });

    it('accepts a JSON-RPC error response for either party', () => {
        const err = { jsonrpc: '2.0' as const, id: 1, error: { code: -32_601, message: 'Method not found' } };
        expect(() => assertWireMessage(err, 'server')).not.toThrow();
        expect(() => assertWireMessage(err, 'client')).not.toThrow();
    });
});
