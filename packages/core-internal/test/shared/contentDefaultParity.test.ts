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
 * v1 parse-parity for `CallToolResult.content` on the legacy era: deployed
 * servers omit `content` alongside `structuredContent`, and SDK v1 accepted
 * that for years. The result resolves with `content: []` instead of failing
 * the whole call — while task vocabulary without content stays a loud error
 * (the T6 guard lives in the codec, not the schema).
 */
describe('CallToolResult content default (v1 parity)', () => {
    async function respondWith(body: Record<string, unknown>) {
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
            return await protocol.request({ method: 'tools/call', params: { name: 'echo', arguments: {} } });
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

    it('a task-shaped body without content still fails loudly (T6 guard)', async () => {
        await expect(respondWith({ task: { taskId: 't-1', status: 'working' } })).rejects.toBeInstanceOf(SdkError);
    });
});
