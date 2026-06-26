/**
 * Runtime/typed result-map alignment.
 *
 * `getResultSchema`'s typed overload asserts `z.ZodType<ResultTypeMap[M]>`,
 * so the runtime map must not be looser than the typed map: no task-result
 * union members on `tools/call` / `sampling/createMessage` /
 * `elicitation/create` (ResultTypeMap types them plain), and no `tasks/*`
 * entries at all (the task methods are 2025-11-25 wire vocabulary outside
 * `RequestMethod`).
 *
 * The behavioral consequence for a generic `request()` caller facing a
 * 2025-era task server: a `CreateTaskResult` body can no longer parse via a
 * union member and surface mis-typed (a `CreateTaskResult` typed as
 * `CreateMessageResult`/`ElicitResult`). Where the method's result schema
 * rejects the body it now fails as a typed invalid-result error. This client
 * cannot drive tasks; a typed error is the correct surface, not a result
 * whose static type lies.
 */
import { describe, expect, test } from 'vitest';

import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors';
import type { BaseContext } from '../../src/shared/protocol';
import { Protocol } from '../../src/shared/protocol';
import { InMemoryTransport } from '../../src/util/inMemory';
import type { JSONRPCRequest } from '../../src/types/index';
// Post-relocation home (Q1 increment-2 step 1): the runtime registries live
// behind the per-era wire-codec interface now.
import { getResultSchema } from '../../src/wire/rev2025-11-25/registry';

class TestProtocol extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

/** A well-formed 2025-11-25 `CreateTaskResult` body. */
const CREATE_TASK_RESULT_BODY = {
    task: {
        taskId: 'task-1',
        status: 'working',
        ttl: 60_000,
        createdAt: '2025-11-25T00:00:00Z',
        lastUpdatedAt: '2025-11-25T00:00:00Z',
        pollInterval: 500
    }
};

/** Wire a protocol whose peer answers every request with the given raw result body. */
async function wireWithRawResult(rawResult: unknown): Promise<TestProtocol> {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    serverTx.onmessage = message => {
        const request = message as JSONRPCRequest;
        void serverTx.send({ jsonrpc: '2.0', id: request.id, result: rawResult } as Parameters<typeof serverTx.send>[0]);
    };
    await serverTx.start();
    const protocol = new TestProtocol();
    await protocol.connect(clientTx);
    return protocol;
}

describe('task-shaped result bodies against the narrowed runtime map', () => {
    test('sampling/createMessage: a CreateTaskResult body is a typed invalid-result error, not a mis-typed success', async () => {
        // Before the narrowing, the union member parsed this body and handed
        // it back TYPED as CreateMessageResult — a result whose static type
        // lies. Now it fails the (plain) result schema locally.
        const protocol = await wireWithRawResult(CREATE_TASK_RESULT_BODY);

        const outcome = await protocol.request({ method: 'sampling/createMessage', params: { messages: [], maxTokens: 1 } }).then(
            result => ({ resolved: result as unknown }),
            error => ({ rejected: error as unknown })
        );

        expect('resolved' in outcome, 'must not resolve as a success').toBe(false);
        const rejection = (outcome as { rejected: unknown }).rejected;
        expect(rejection).toBeInstanceOf(SdkError);
        expect((rejection as SdkError).code).toBe(SdkErrorCode.InvalidResult);

        await protocol.close();
    });

    test('elicitation/create: a CreateTaskResult body is a typed invalid-result error, not a mis-typed success', async () => {
        const protocol = await wireWithRawResult(CREATE_TASK_RESULT_BODY);

        const rejection = await protocol
            .request({ method: 'elicitation/create', params: { mode: 'form', message: 'Name?', requestedSchema: { type: 'object' } } })
            .catch((error: unknown) => error);
        expect(rejection).toBeInstanceOf(SdkError);
        expect((rejection as SdkError).code).toBe(SdkErrorCode.InvalidResult);

        await protocol.close();
    });

    test('tools/call: a CreateTaskResult body is now a typed invalid-result error too (content-default removal flip)', async () => {
        // FLIPPED PIN (Q1 increment 2, ledgered with the content-default
        // removal — changeset: codec-split-wire-break). The previous "Honest
        // pin, not an endorsement" recorded that CallToolResultSchema's
        // content.default([]) swallowed ANY object — including a task body —
        // as a content-empty success, which made the old union member
        // unreachable and the map narrowing observationally invisible for
        // tools/call. With `content` now REQUIRED at the wire boundary the
        // masking surface is gone: a task body has no `content`, fails the
        // plain schema, and surfaces as the same typed invalid-result error
        // as sampling/elicit. The result-schema-strictness question the old
        // pin deferred is hereby resolved: loud rejection.
        const protocol = await wireWithRawResult(CREATE_TASK_RESULT_BODY);

        const rejection = await protocol
            .request({ method: 'tools/call', params: { name: 'echo', arguments: {} } })
            .catch((error: unknown) => error);
        expect(rejection).toBeInstanceOf(SdkError);
        expect((rejection as SdkError).code).toBe(SdkErrorCode.InvalidResult);

        await protocol.close();
    });
});

describe('tasks/* entries are gone from the runtime result map', () => {
    test('getResultSchema returns undefined for every task method', () => {
        for (const method of ['tasks/get', 'tasks/result', 'tasks/list', 'tasks/cancel']) {
            expect(getResultSchema(method), method).toBeUndefined();
        }
    });

    test('a generic request() for a task method demands an explicit schema', async () => {
        // The typed overload already excluded task methods; the runtime map
        // entries were typed-unreachable leftovers. Without them, the
        // explicit-schema overload is the one (intentional) interop path.
        const protocol = await wireWithRawResult({});

        expect(() => protocol.request({ method: 'tasks/get', params: { taskId: 't-1' } } as never)).toThrow(
            /'tasks\/get' is not a spec method; pass a result schema/
        );

        await protocol.close();
    });
});
