import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client';
import type { Transport } from '../../src/index';

const INIT_RESULT = {
    protocolVersion: '2025-11-25',
    capabilities: { tools: {} },
    serverInfo: { name: 's', version: '1' }
};

function terminated404(): SdkHttpError {
    return new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Error POSTing to endpoint: session not found', {
        status: 404,
        statusText: 'Not Found',
        sessionTerminated: true
    });
}

class ScriptedTransport implements Transport {
    onmessage?: (message: JSONRPCMessage) => void;
    onerror?: (error: Error) => void;
    onclose?: () => void;
    sent: JSONRPCMessage[] = [];
    constructor(private readonly script: (message: JSONRPCMessage, t: ScriptedTransport) => void) {}
    async start(): Promise<void> {}
    async close(): Promise<void> {
        this.onclose?.();
    }
    async send(message: JSONRPCMessage): Promise<void> {
        this.sent.push(message);
        this.script(message, this);
    }
    reply(message: JSONRPCMessage): void {
        queueMicrotask(() => this.onmessage?.(message));
    }
}

function isRequest(m: JSONRPCMessage): m is JSONRPCMessage & { id: number | string; method: string } {
    return 'method' in m && 'id' in m;
}

function echoScript(opts: { failNthToolCall?: number[]; failReinit?: boolean }) {
    let toolCalls = 0;
    let initCount = 0;
    return (message: JSONRPCMessage, t: ScriptedTransport) => {
        if (!isRequest(message)) return;
        if (message.method === 'initialize') {
            initCount++;
            if (opts.failReinit && initCount > 1) {
                throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'unavailable', { status: 500 });
            }
            t.reply({ jsonrpc: '2.0', id: message.id, result: INIT_RESULT });
            return;
        }
        if (message.method === 'tools/call') {
            toolCalls++;
            if (opts.failNthToolCall?.includes(toolCalls)) throw terminated404();
            t.reply({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } });
            return;
        }
        if (message.method === 'tools/list') {
            toolCalls++;
            if (opts.failNthToolCall?.includes(toolCalls)) throw terminated404();
            t.reply({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
        }
    };
}

describe('session re-initialization after a terminated-session 404', () => {
    it('re-initializes and retries the failed request once', async () => {
        const transport = new ScriptedTransport(echoScript({ failNthToolCall: [1] }));
        const client = new Client({ name: 'c', version: '0' }, {});
        await client.connect(transport);

        const result = await client.callTool({ name: 'echo', arguments: {} });
        expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);

        const methods = transport.sent.filter(isRequest).map(m => m.method);
        expect(methods).toEqual(['initialize', 'tools/call', 'initialize', 'tools/call']);
        await client.close();
    });

    it('deduplicates concurrent recoveries into one handshake', async () => {
        const transport = new ScriptedTransport(echoScript({ failNthToolCall: [1, 2] }));
        const client = new Client({ name: 'c', version: '0' }, {});
        await client.connect(transport);

        const [a, b] = await Promise.all([
            client.callTool({ name: 'echo', arguments: {} }),
            client.callTool({ name: 'echo', arguments: {} })
        ]);
        expect(a.content).toEqual([{ type: 'text', text: 'ok' }]);
        expect(b.content).toEqual([{ type: 'text', text: 'ok' }]);

        const inits = transport.sent.filter(isRequest).filter(m => m.method === 'initialize');
        expect(inits).toHaveLength(2);
        await client.close();
    });

    it('surfaces the original 404 when re-establishment fails, reporting the handshake error via onerror', async () => {
        const transport = new ScriptedTransport(echoScript({ failNthToolCall: [1], failReinit: true }));
        const client = new Client({ name: 'c', version: '0' }, {});
        const reported: Error[] = [];
        client.onerror = e => void reported.push(e);
        await client.connect(transport);

        const rejection = await client.callTool({ name: 'echo', arguments: {} }).catch((e: unknown) => e);
        expect(rejection).toBeInstanceOf(SdkHttpError);
        expect((rejection as SdkHttpError).data.status).toBe(404);
        expect(reported.some(e => e instanceof SdkHttpError && e.data.status === 500)).toBe(true);
    });

    it('does not retry pagination continuations', async () => {
        const transport = new ScriptedTransport(echoScript({ failNthToolCall: [1] }));
        const client = new Client({ name: 'c', version: '0' }, {});
        await client.connect(transport);

        const rejection = await client.request({ method: 'tools/list', params: { cursor: 'stale' } }).catch((e: unknown) => e);
        expect(rejection).toBeInstanceOf(SdkHttpError);
        const methods = transport.sent.filter(isRequest).map(m => m.method);
        expect(methods).toEqual(['initialize', 'tools/list']);
        await client.close();
    });
});
