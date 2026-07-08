import { describe, expect, it } from 'vitest';

import { SdkError } from '../../src/errors/sdkErrors';
import type { BaseContext } from '../../src/shared/protocol';
import { Protocol } from '../../src/shared/protocol';
import type { JSONRPCRequest } from '../../src/types/index';
import { isJSONRPCRequest } from '../../src/types/index';
import { InMemoryTransport } from '../../src/util/inMemory';

class TestProtocolImpl extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

/**
 * v1 parse-parity for `CallToolResult.content` on the legacy era: absent
 * content defaults to []; another result family's content-less body still
 * fails loudly via the registry wire-seam schema.
 */
describe('CallToolResult content default (v1 parity)', () => {
    async function respondWith(body: Record<string, unknown>, resultSchema?: Parameters<Protocol<BaseContext>['request']>[1]) {
        const protocol = new TestProtocolImpl();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        serverTransport.onmessage = message => {
            if (isJSONRPCRequest(message)) {
                void serverTransport.send({
                    jsonrpc: '2.0',
                    id: (message as JSONRPCRequest).id,
                    result: body
                });
            }
        };
        await serverTransport.start();
        await protocol.connect(clientTransport);
        try {
            return resultSchema === undefined
                ? await protocol.request({ method: 'tools/call', params: { name: 'echo', arguments: {} } })
                : await protocol.request({ method: 'tools/call', params: { name: 'echo', arguments: {} } }, resultSchema);
        } finally {
            await protocol.close().catch(() => {});
        }
    }

    it('a structured-only result resolves with content: []', async () => {
        const result = (await respondWith({ structuredContent: { ok: true } })) as {
            content: unknown;
            structuredContent: unknown;
        };
        expect(result.content).toEqual([]);
        expect(result.structuredContent).toEqual({ ok: true });
    });

    it('an entirely empty result resolves with content: []', async () => {
        const result = (await respondWith({})) as { content: unknown };
        expect(result.content).toEqual([]);
    });

    it('a task-shaped body without content still fails loudly (wire-seam guard)', async () => {
        await expect(respondWith({ task: { taskId: 't-1', status: 'working' } })).rejects.toBeInstanceOf(SdkError);
    });

    it('task interop via an explicit result schema still works — the guard never touches that overload', async () => {
        const { CreateTaskResultSchema } = await import('../../src/wire/rev2025-11-25/schemas');
        const body = {
            task: {
                taskId: '786af6b0-2779-48ed-9cc1-b8a8a25b8a86',
                status: 'working',
                createdAt: '2025-11-25T10:30:00Z',
                lastUpdatedAt: '2025-11-25T10:30:05Z',
                ttl: 60000,
                pollInterval: 5000
            }
        };
        const result = (await respondWith(body, CreateTaskResultSchema)) as { task: { taskId: string } };
        expect(result.task.taskId).toBe('786af6b0-2779-48ed-9cc1-b8a8a25b8a86');
    });

    it('explicit-schema task interop resolves even when the body also stamps a foreign resultType', async () => {
        const { CreateTaskResultSchema } = await import('../../src/wire/rev2025-11-25/schemas');
        const body = {
            resultType: 'complete',
            task: {
                taskId: '786af6b0-2779-48ed-9cc1-b8a8a25b8a86',
                status: 'working',
                createdAt: '2025-11-25T10:30:00Z',
                lastUpdatedAt: '2025-11-25T10:30:05Z',
                ttl: 60000,
                pollInterval: 5000
            }
        };
        const result = (await respondWith(body, CreateTaskResultSchema)) as { task: { taskId: string } };
        expect(result.task.taskId).toBe('786af6b0-2779-48ed-9cc1-b8a8a25b8a86');
    });

    it('an input_required-shaped body without content still fails loudly (wire-seam guard)', async () => {
        await expect(respondWith({ inputRequests: { r1: { method: 'elicitation/create' } } })).rejects.toBeInstanceOf(SdkError);
        await expect(respondWith({ requestState: 'opaque-token' })).rejects.toBeInstanceOf(SdkError);
    });
});
