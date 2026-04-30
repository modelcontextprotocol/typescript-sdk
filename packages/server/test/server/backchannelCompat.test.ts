import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/core';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { BackchannelCompat } from '../../src/server/backchannelCompat.js';

describe('BackchannelCompat', () => {
    let bc: BackchannelCompat;
    let written: JSONRPCMessage[];
    const writeSSE = (msg: JSONRPCMessage): boolean => {
        written.push(msg);
        return true;
    };

    beforeEach(() => {
        bc = new BackchannelCompat();
        written = [];
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('makeEnvSend writes outbound request and resolves on handleResponse', async () => {
        const send = bc.makeEnvSend('s1', writeSSE);
        const p = send({ method: 'elicitation/create', params: { message: 'hi' } });

        expect(written).toHaveLength(1);
        const wire = written[0] as JSONRPCRequest;
        expect(wire.method).toBe('elicitation/create');
        expect(typeof wire.id).toBe('number');

        const claimed = bc.handleResponse('s1', { jsonrpc: '2.0', id: wire.id, result: { action: 'accept' } });
        expect(claimed).toBe(true);
        await expect(p).resolves.toEqual({ action: 'accept' });
    });

    test('handleResponse routes error response to rejection', async () => {
        const send = bc.makeEnvSend('s1', writeSSE);
        const p = send({ method: 'sampling/createMessage' });
        const wire = written[0] as JSONRPCRequest;

        bc.handleResponse('s1', { jsonrpc: '2.0', id: wire.id, error: { code: -32_000, message: 'nope' } });
        await expect(p).rejects.toThrow('nope');
    });

    test('handleResponse returns false for unknown session/id', () => {
        expect(bc.handleResponse('unknown', { jsonrpc: '2.0', id: 99, result: {} })).toBe(false);
    });

    test('per-session correlation: same id on different sessions does not collide', async () => {
        const sendA = bc.makeEnvSend('A', writeSSE);
        const sendB = bc.makeEnvSend('B', writeSSE);
        const pA = sendA({ method: 'x' });
        const pB = sendB({ method: 'x' });
        const wA = written[0] as JSONRPCRequest;
        const wB = written[1] as JSONRPCRequest;

        bc.handleResponse('B', { jsonrpc: '2.0', id: wB.id, result: { from: 'B' } });
        await expect(pB).resolves.toEqual({ from: 'B' });
        bc.handleResponse('A', { jsonrpc: '2.0', id: wA.id, result: { from: 'A' } });
        await expect(pA).resolves.toEqual({ from: 'A' });
    });

    test('timeout rejects with RequestTimeout', async () => {
        const send = bc.makeEnvSend('s1', writeSSE);
        const p = send({ method: 'x' }, { timeout: 100 });
        const caught = p.catch(e => e);

        vi.advanceTimersByTime(101);
        const e = await caught;
        expect(e).toBeInstanceOf(SdkError);
        expect((e as SdkError).code).toBe(SdkErrorCode.RequestTimeout);
        expect(bc.handleResponse('s1', { jsonrpc: '2.0', id: (written[0] as JSONRPCRequest).id, result: {} })).toBe(false);
    });

    test('abort writes notifications/cancelled then rejects and cleans up', async () => {
        const ctrl = new AbortController();
        const send = bc.makeEnvSend('s1', writeSSE);
        const p = send({ method: 'x' }, { signal: ctrl.signal });
        const caught = p.catch(e => e);
        const wireId = (written[0] as JSONRPCRequest).id;

        ctrl.abort(new Error('cancelled'));
        const e = await caught;
        expect(e).toBeInstanceOf(Error);
        expect((e as Error).message).toBe('cancelled');
        expect(written[1]).toMatchObject({ method: 'notifications/cancelled', params: { requestId: wireId } });
        expect(bc.handleResponse('s1', { jsonrpc: '2.0', id: wireId, result: {} })).toBe(false);
    });

    test('pre-aborted signal rejects immediately without writing', async () => {
        const ctrl = new AbortController();
        ctrl.abort(new Error('already'));
        const send = bc.makeEnvSend('s1', writeSSE);
        await expect(send({ method: 'x' }, { signal: ctrl.signal })).rejects.toThrow('already');
        expect(written).toHaveLength(0);
    });

    test('writeSSE returning false rejects with SendFailed', async () => {
        const send = bc.makeEnvSend('s1', () => false);
        const e = await send({ method: 'x' }).catch(err => err);
        expect(e).toBeInstanceOf(SdkError);
        expect((e as SdkError).code).toBe(SdkErrorCode.SendFailed);
    });

    test('closeSession rejects all pending', async () => {
        const send = bc.makeEnvSend('s1', writeSSE);
        const p1 = send({ method: 'a' }).catch(e => e);
        const p2 = send({ method: 'b' }).catch(e => e);

        bc.closeSession('s1');
        expect((await p1).code).toBe(SdkErrorCode.ConnectionClosed);
        expect((await p2).code).toBe(SdkErrorCode.ConnectionClosed);
    });
});
