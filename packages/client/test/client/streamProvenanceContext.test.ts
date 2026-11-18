import type { JSONRPCMessage, MessageExtraInfo, Transport } from '@modelcontextprotocol/core-internal';
import { isJSONRPCRequest } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client';

class ScriptedTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
    sent: JSONRPCMessage[] = [];

    async start(): Promise<void> {}

    async close(): Promise<void> {
        this.onclose?.();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        this.sent.push(message);
        if (isJSONRPCRequest(message) && message.method === 'initialize') {
            queueMicrotask(() =>
                this.onmessage?.({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        protocolVersion: '2025-11-25',
                        capabilities: {},
                        serverInfo: { name: 'scripted-server', version: '1.0.0' }
                    }
                })
            );
        }
    }

    emit(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
        this.onmessage?.(message, extra);
    }
}

describe('Streamable HTTP provenance in client request context', () => {
    it('exposes relatedRequestId to the client request handler', async () => {
        const transport = new ScriptedTransport();
        const client = new Client({ name: 'provenance-client', version: '1.0.0' }, { capabilities: { roots: { listChanged: false } } });
        let relatedRequestId: string | number | undefined;

        client.setRequestHandler('roots/list', async (_request, context) => {
            relatedRequestId = context.mcpReq.relatedRequestId;
            return { roots: [] };
        });

        await client.connect(transport);
        transport.emit({ jsonrpc: '2.0', id: 'server-request-1', method: 'roots/list', params: {} }, { relatedRequestId: 'tool-call-1' });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(relatedRequestId).toBe('tool-call-1');
        await client.close();
    });
});
