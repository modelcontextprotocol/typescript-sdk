/**
 * Raw-first result discrimination through the full client path — ERA-SCOPED
 * (Q1 increment 2: V-1 lives in the era codec's decodeResult, and the
 * postures are ruled per era by Q1-SD3).
 *
 * A raw relay server (no SDK Server involved) answers tools/call with hand
 * built bodies. The negotiated protocol version selects the wire era:
 *
 *  - Negotiated 2026-07-28: `resultType` is the REQUIRED discriminator. An
 *    `input_required` body surfaces the discriminated kind as a typed local
 *    error (the multi-round-trip driver consumes it when it lands); an
 *    ABSENT `resultType` is a spec violation surfaced as a typed error
 *    naming it.
 *  - Negotiated legacy (2025 era): `resultType` is FOREIGN vocabulary —
 *    strip-on-lift (Q1-SD3 ii; a deliberate, ledgered change from the
 *    pre-split era-blind rejection — changeset: codec-split-wire-break). The
 *    stripped body then fails the (default-free) result schema loudly
 *    because it has no content.
 *
 * Either way the V-1 invariant holds: never an empty-content success.
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

/** A complete-looking body that omits the (2026-required) resultType. */
const ABSENT_RESULT_TYPE_BODY = { content: [{ type: 'text', text: 'looks complete' }] };

function initializeResult(requestedVersion: string) {
    return {
        protocolVersion: requestedVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'raw-input-required-server', version: '0' }
    };
}

function makeResponder(toolCallBody: unknown) {
    return function respondTo(request: JSONRPCRequest): unknown {
        if (request.method === 'initialize') {
            const requested = (request.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? LATEST_PROTOCOL_VERSION;
            return initializeResult(requested);
        }
        if (request.method === 'tools/call') return toolCallBody;
        return {};
    };
}

async function connectInMemory(client: Client, toolCallBody: unknown): Promise<void> {
    const respondTo = makeResponder(toolCallBody);
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    serverTx.onmessage = message => {
        const request = message as JSONRPCRequest;
        if (request.id === undefined) return; // notifications need no answer
        void serverTx.send({ jsonrpc: '2.0', id: request.id, result: respondTo(request) } as Parameters<typeof serverTx.send>[0]);
    };
    await serverTx.start();
    await client.connect(clientTx);
}

async function connectStreamableHttp(client: Client, toolCallBody: unknown): Promise<void> {
    const respondTo = makeResponder(toolCallBody);
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

async function callToolOutcome(client: Client): Promise<{ resolved: unknown } | { rejected: unknown }> {
    return client.callTool({ name: 'anything', arguments: {} }).then(
        result => ({ resolved: result as unknown }),
        error => ({ rejected: error as unknown })
    );
}

verifies('typescript:client:raw-result-type-first', async ({ transport }: TestArgs) => {
    // ---- Legacy negotiation (the relay echoes the client's default offer,
    // so this connection negotiates a legacy version → 2025 era). ----
    {
        const client = new Client({ name: 'raw-result-type-client', version: '0' });
        await (transport === 'inMemory'
            ? connectInMemory(client, INPUT_REQUIRED_BODY)
            : connectStreamableHttp(client, INPUT_REQUIRED_BODY));

        try {
            const outcome = await callToolOutcome(client);
            // Strip-on-lift (Q1-SD3 ii, ledgered): the foreign resultType is
            // dropped; the body has no content, so validation fails LOUDLY.
            // Never an empty-content success.
            expect('resolved' in outcome, `must not resolve: ${JSON.stringify(outcome)}`).toBe(false);
            const rejection = (outcome as { rejected: unknown }).rejected;
            expect(rejection).toBeInstanceOf(SdkError);
            expect((rejection as SdkError).code).toBe(SdkErrorCode.InvalidResult);
        } finally {
            await client.close();
        }
    }

    // ---- Modern negotiation: the client opts into the draft revision, the
    // relay echoes it back → 2026 era → V-1 discrimination in the codec. ----
    {
        const client = new Client({ name: 'raw-result-type-client', version: '0' }, { supportedProtocolVersions: ['2026-07-28'] });
        await (transport === 'inMemory'
            ? connectInMemory(client, INPUT_REQUIRED_BODY)
            : connectStreamableHttp(client, INPUT_REQUIRED_BODY));

        try {
            const outcome = await callToolOutcome(client);
            expect('resolved' in outcome, `must not resolve: ${JSON.stringify(outcome)}`).toBe(false);
            const rejection = (outcome as { rejected: unknown }).rejected;
            expect(rejection).toBeInstanceOf(SdkError);
            const typed = rejection as SdkError;
            expect(typed.code).toBe(SdkErrorCode.UnsupportedResultType);
            expect(typed.data).toMatchObject({ resultType: 'input_required', method: 'tools/call' });
        } finally {
            await client.close();
        }
    }

    // ---- Modern negotiation, absent resultType: the spec violation is
    // surfaced as a typed error naming it (Q1-SD3 i — the absent⇒complete
    // bridge applies only to earlier-revision servers). ----
    {
        const client = new Client({ name: 'raw-result-type-client', version: '0' }, { supportedProtocolVersions: ['2026-07-28'] });
        await (transport === 'inMemory'
            ? connectInMemory(client, ABSENT_RESULT_TYPE_BODY)
            : connectStreamableHttp(client, ABSENT_RESULT_TYPE_BODY));

        try {
            const outcome = await callToolOutcome(client);
            expect('resolved' in outcome, `must not resolve: ${JSON.stringify(outcome)}`).toBe(false);
            const rejection = (outcome as { rejected: unknown }).rejected;
            expect(rejection).toBeInstanceOf(SdkError);
            const typed = rejection as SdkError;
            expect(typed.code).toBe(SdkErrorCode.InvalidResult);
            expect(String(typed.message)).toContain('missing required resultType');
        } finally {
            await client.close();
        }
    }
});
