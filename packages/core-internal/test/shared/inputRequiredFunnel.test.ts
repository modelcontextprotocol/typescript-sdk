/**
 * Protocol-layer seams of the multi-round-trip flow (M4.1):
 *
 * - the manual path: `allowInputRequired: true` hands the discriminated
 *   input-required value back to the caller (the primitive the auto driver is
 *   layered over), discriminated raw and BEFORE any consumer schema runs;
 * - the inbound retry-material partition: only BARE inputResponses entries
 *   surface to handlers; wrapped `{method, result}` entries are dropped into
 *   `ctx.mcpReq.droppedInputResponseKeys` (T1/D-059).
 */
import { describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

import type { BaseContext } from '../../src/shared/protocol.js';
import { Protocol, setNegotiatedProtocolVersion } from '../../src/shared/protocol.js';
import type { JSONRPCRequest } from '../../src/types/index.js';
import { isInputRequiredResult } from '../../src/types/guards.js';
import { InMemoryTransport } from '../../src/util/inMemory.js';
import { rev2026Codec } from '../../src/wire/rev2026-07-28/codec.js';

class TestProtocol extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

const INPUT_REQUIRED_BODY = {
    resultType: 'input_required',
    inputRequests: { 'elicit-1': { method: 'elicitation/create', params: { mode: 'form', message: 'Name?' } } },
    requestState: 'opaque-state'
};

async function wireWithRawResult(rawResult: unknown): Promise<TestProtocol> {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    serverTx.onmessage = message => {
        const request = message as JSONRPCRequest;
        void serverTx.send({ jsonrpc: '2.0', id: request.id, result: rawResult } as Parameters<typeof serverTx.send>[0]);
    };
    await serverTx.start();
    const protocol = new TestProtocol();
    await protocol.connect(clientTx);
    setNegotiatedProtocolVersion(protocol, '2026-07-28');
    return protocol;
}

describe('manual mode (allowInputRequired)', () => {
    test('hands the discriminated input-required value back to the caller', async () => {
        const protocol = await wireWithRawResult(INPUT_REQUIRED_BODY);

        const result = await protocol.request(
            { method: 'tools/call', params: { name: 'echo', arguments: {} } },
            {
                allowInputRequired: true
            }
        );

        expect(isInputRequiredResult(result)).toBe(true);
        expect(result).toEqual({
            resultType: 'input_required',
            inputRequests: INPUT_REQUIRED_BODY.inputRequests,
            requestState: 'opaque-state'
        });

        await protocol.close();
    });

    test('discrimination happens on the raw body, before the consumer-provided result schema runs', async () => {
        const protocol = await wireWithRawResult(INPUT_REQUIRED_BODY);

        let schemaInvoked = false;
        const poisonedSchema = z.unknown().transform(value => {
            schemaInvoked = true;
            return value;
        });

        const result = await protocol.request({ method: 'tools/call', params: { name: 'echo' } }, poisonedSchema, {
            allowInputRequired: true
        });
        expect(isInputRequiredResult(result)).toBe(true);
        expect(schemaInvoked, 'the consumer schema must never see the input_required body').toBe(false);

        await protocol.close();
    });

    test('without the opt-in (and without a driver) the typed local error is unchanged', async () => {
        const protocol = await wireWithRawResult(INPUT_REQUIRED_BODY);
        await expect(protocol.request({ method: 'tools/call', params: { name: 'echo' } })).rejects.toMatchObject({
            code: 'UNSUPPORTED_RESULT_TYPE',
            data: { resultType: 'input_required', method: 'tools/call' }
        });
        await protocol.close();
    });

    test('an input_required carrying neither inputRequests nor requestState fails fast as an invalid result, even with the opt-in', async () => {
        const protocol = await wireWithRawResult({ resultType: 'input_required' });
        await expect(
            protocol.request({ method: 'tools/call', params: { name: 'echo', arguments: {} } }, { allowInputRequired: true })
        ).rejects.toMatchObject({
            code: 'INVALID_RESULT',
            data: { method: 'tools/call', violation: 'input-required-missing-both' }
        });
        await protocol.close();
    });
});

describe('era gate (in-band vocabulary grants no registry membership)', () => {
    test('the demoted methods are absent from the 2026-07-28 wire-request registry even though their in-band schemas exist', () => {
        for (const method of ['elicitation/create', 'sampling/createMessage', 'roots/list']) {
            expect(rev2026Codec.inputRequestSchema(method), method).toBeDefined();
            // A peer sending one of these as a wire request on the 2026 era
            // still answers −32601 by absence — the in-band fallback used for
            // embedded dispatch must never grant wire-request membership.
            expect(rev2026Codec.hasRequestMethod(method), method).toBe(false);
        }
    });
});

describe('inbound retry material (T1/D-059)', () => {
    test('bare entries surface on ctx.mcpReq.inputResponses; wrapped entries are dropped into droppedInputResponseKeys', async () => {
        const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
        const receiver = new TestProtocol();
        const seen: Array<BaseContext['mcpReq']> = [];
        receiver.setRequestHandler('tools/call', (_request, ctx) => {
            seen.push(ctx.mcpReq);
            return { content: [] };
        });
        await receiver.connect(serverTx);
        await clientTx.start();

        const responses = new Promise<void>(resolve => {
            clientTx.onmessage = () => resolve();
        });
        await clientTx.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name: 'deploy',
                arguments: {},
                inputResponses: {
                    bare: { action: 'accept', content: { ok: true } },
                    wrapped: { method: 'elicitation/create', result: { action: 'accept' } },
                    'not-an-object': 42
                },
                requestState: 'echoed-back'
            }
        } as Parameters<typeof clientTx.send>[0]);
        await responses;

        expect(seen).toHaveLength(1);
        const mcpReq = seen[0]!;
        expect(mcpReq.inputResponses).toEqual({ bare: { action: 'accept', content: { ok: true } } });
        expect(mcpReq.droppedInputResponseKeys?.sort()).toEqual(['not-an-object', 'wrapped']);
        expect(mcpReq.requestState).toBe('echoed-back');
        // The handler-visible params never carry the lifted retry material.
        await receiver.close();
        await clientTx.close();
    });
});
