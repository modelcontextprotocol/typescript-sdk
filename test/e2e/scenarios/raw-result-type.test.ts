/**
 * Raw-first result discrimination through the full client path.
 *
 * A raw relay server (no SDK Server involved) answers tools/call with an
 * `input_required` body — the 2026-era multi-round-trip shape. The full
 * client stack (Client → protocol funnel → transport) must surface the
 * discriminated kind as a typed local error and never mask it into an
 * empty-content success (the tools/call result schema defaults `content` to
 * `[]`, which would otherwise swallow the body whole).
 */
import { Client, SdkError, SdkErrorCode, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { JSONRPCRequest } from '@modelcontextprotocol/server';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { expect } from 'vitest';

import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

const INPUT_REQUIRED_BODY = {
    resultType: 'input_required',
    inputRequests: {
        'elicit-1': {
            method: 'elicitation/create',
            params: { mode: 'form', message: 'What is your name?', requestedSchema: { type: 'object', properties: {} } }
        }
    },
    requestState: 'opaque-state'
};

function initializeResult(requestedVersion: string) {
    return {
        protocolVersion: requestedVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'raw-input-required-server', version: '0' }
    };
}

/** Route a raw request to the relay's hand-built response body. */
function respondTo(request: JSONRPCRequest): unknown {
    if (request.method === 'initialize') {
        const requested = (request.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? LATEST_PROTOCOL_VERSION;
        return initializeResult(requested);
    }
    if (request.method === 'tools/call') return INPUT_REQUIRED_BODY;
    return {};
}

async function connectInMemory(client: Client): Promise<void> {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    serverTx.onmessage = message => {
        const request = message as JSONRPCRequest;
        if (request.id === undefined) return; // notifications need no answer
        void serverTx.send({ jsonrpc: '2.0', id: request.id, result: respondTo(request) } as Parameters<typeof serverTx.send>[0]);
    };
    await serverTx.start();
    await client.connect(clientTx);
}

async function connectStreamableHttp(client: Client): Promise<void> {
    // A hand HTTP handler (no SDK server): JSON responses, 202 for notifications.
    const fetchHandler = async (input: URL | string, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init);
        if (request.method !== 'POST') return new Response(null, { status: 405 });
        const body = (await request.json()) as JSONRPCRequest | JSONRPCRequest[];
        const message = Array.isArray(body) ? body[0] : body;
        if (message?.id === undefined) return new Response(null, { status: 202 });
        return Response.json({ jsonrpc: '2.0', id: message.id, result: respondTo(message) });
    };
    await client.connect(new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), { fetch: fetchHandler }));
}

verifies('typescript:client:raw-result-type-first', async ({ transport }: TestArgs) => {
    const client = new Client({ name: 'raw-result-type-client', version: '0' });
    await (transport === 'inMemory' ? connectInMemory(client) : connectStreamableHttp(client));

    try {
        const outcome = await client.callTool({ name: 'anything', arguments: {} }).then(
            result => ({ resolved: result as unknown }),
            error => ({ rejected: error as unknown })
        );

        // Never an empty-content success.
        expect('resolved' in outcome, `must not resolve: ${JSON.stringify(outcome)}`).toBe(false);
        const rejection = (outcome as { rejected: unknown }).rejected;
        expect(rejection).toBeInstanceOf(SdkError);
        const typed = rejection as SdkError;
        expect(typed.code).toBe(SdkErrorCode.UnsupportedResultType);
        expect(typed.data).toMatchObject({ resultType: 'input_required', method: 'tools/call' });
    } finally {
        await client.close();
    }
});
