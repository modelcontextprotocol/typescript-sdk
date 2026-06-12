/**
 * Physical deletions through real dispatch (Q1 increment 2).
 *
 * Registry membership is the deletion story, and these tests prove it at the
 * protocol funnels, in both directions:
 *
 *  - inbound: a 2026-classified `tasks/get` gets −32601 BY ABSENCE — even
 *    with a handler registered (a custom handler cannot shadow a deleted
 *    spec method across eras); era-mismatched spec notifications are
 *    silently dropped even with a handler registered.
 *  - outbound: an era-mismatched spec method dies locally with
 *    `SdkErrorCode.MethodNotSupportedByProtocolVersion` before anything
 *    reaches the transport.
 *  - the 2026 era requires the per-request envelope (−32602 when missing).
 *  - the stamp seam: 2026-classified responses carry `resultType:
 *    'complete'`; 2025-era responses NEVER carry it (the 2025 codec has no
 *    stamp code path — the never-stamp guarantee).
 *  - encode-side deleted-field strictness (Q1-SD3 iii): `execution` is
 *    stripped from tools and `tasks` from capability objects on 2026-era
 *    emissions; both survive untouched on the 2025 era.
 *
 * Classification is INJECTED via MessageExtraInfo (this layer only consumes
 * it; the production classifier is the entry/edge's job).
 */
import { describe, expect, test } from 'vitest';

import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors.js';
import type { BaseContext } from '../../src/shared/protocol.js';
import { Protocol } from '../../src/shared/protocol.js';
import type { JSONRPCMessage, MessageClassification, Result } from '../../src/types/index.js';
import { InMemoryTransport } from '../../src/util/inMemory.js';
import { bindWireVersion } from '../../src/wire/codec.js';
import * as z from 'zod/v4';

class TestProtocol extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

const MODERN: MessageClassification = { era: 'modern', revision: '2026-07-28' };

const ENVELOPE = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'era-client', version: '0.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {}
};

interface Harness {
    receiver: TestProtocol;
    /** Deliver a raw message to the receiver, optionally classified. */
    deliver: (message: JSONRPCMessage, classification?: MessageClassification) => void;
    /** Messages the receiver sent back (responses, notifications). */
    sent: JSONRPCMessage[];
    flush: () => Promise<void>;
}

async function harness(setup?: (receiver: TestProtocol) => void): Promise<Harness> {
    const [peerTx, receiverTx] = InMemoryTransport.createLinkedPair();
    const sent: JSONRPCMessage[] = [];
    peerTx.onmessage = message => void sent.push(message);
    await peerTx.start();

    const receiver = new TestProtocol();
    setup?.(receiver);
    await receiver.connect(receiverTx);

    return {
        receiver,
        // Invoke the receiver-side transport callback directly so the test
        // controls MessageExtraInfo (the classification consumption seam).
        deliver: (message, classification) => receiverTx.onmessage?.(message, classification ? ({ classification } as never) : undefined),
        sent,
        flush: () => new Promise(resolve => setTimeout(resolve, 10))
    };
}

const errorOf = (msg: JSONRPCMessage | undefined) => (msg as { error?: { code: number; message: string } } | undefined)?.error;
const resultOf = (msg: JSONRPCMessage | undefined) => (msg as { result?: Record<string, unknown> } | undefined)?.result;

describe('inbound era gates — deletions are physical', () => {
    test('2026-classified tasks/get is −32601 BY ABSENCE even with a handler registered', async () => {
        let handlerRan = false;
        const h = await harness(receiver => {
            // A custom (3-arg) handler deliberately shadowing the deleted
            // spec method: it may serve the 2025 era only.
            receiver.setRequestHandler('tasks/get', { params: z.looseObject({ taskId: z.string() }) }, () => {
                handlerRan = true;
                return {} as Result;
            });
        });

        h.deliver(
            { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId: 't-1', _meta: { ...ENVELOPE } } } as JSONRPCMessage,
            MODERN
        );
        await h.flush();

        expect(handlerRan).toBe(false);
        expect(h.sent).toHaveLength(1);
        expect(errorOf(h.sent[0])).toMatchObject({ code: -32601, message: 'Method not found' });
    });

    test('the SAME instance serves legacy tasks/get with that handler (per-request era truth)', async () => {
        let handlerRan = false;
        const h = await harness(receiver => {
            receiver.setRequestHandler('tasks/get', { params: z.looseObject({ taskId: z.string() }) }, () => {
                handlerRan = true;
                return {} as Result;
            });
        });

        // Unclassified ⇒ legacy (Q2 default posture).
        h.deliver({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId: 't-1' } } as JSONRPCMessage);
        await h.flush();

        expect(handlerRan).toBe(true);
        expect(resultOf(h.sent[0])).toBeDefined();
    });

    test('2026-classified ping is −32601 by absence (the built-in pong cannot cross eras)', async () => {
        const h = await harness();
        h.deliver({ jsonrpc: '2.0', id: 3, method: 'ping', params: { _meta: { ...ENVELOPE } } } as JSONRPCMessage, MODERN);
        await h.flush();
        expect(errorOf(h.sent[0])).toMatchObject({ code: -32601 });

        // …while the 2025 era keeps the automatic pong.
        h.deliver({ jsonrpc: '2.0', id: 4, method: 'ping' } as JSONRPCMessage);
        await h.flush();
        expect(resultOf(h.sent[1])).toEqual({});
    });

    test('a 2026-classified spec notification that the era deleted is dropped even with a handler', async () => {
        let delivered = 0;
        const h = await harness(receiver => {
            receiver.setNotificationHandler('notifications/tasks/status', { params: z.looseObject({}) }, () => {
                delivered += 1;
            });
        });

        h.deliver(
            { jsonrpc: '2.0', method: 'notifications/tasks/status', params: { taskId: 't', status: 'working' } } as JSONRPCMessage,
            MODERN
        );
        await h.flush();
        expect(delivered).toBe(0);

        // Legacy leg: delivered.
        h.deliver({ jsonrpc: '2.0', method: 'notifications/tasks/status', params: { taskId: 't', status: 'working' } } as JSONRPCMessage);
        await h.flush();
        expect(delivered).toBe(1);
    });

    test('out-of-universe custom methods stay era-blind (consumer-owned)', async () => {
        let served = 0;
        const h = await harness(receiver => {
            receiver.setRequestHandler('acme/anything', { params: z.looseObject({}) }, () => {
                served += 1;
                return {} as Result;
            });
        });

        h.deliver({ jsonrpc: '2.0', id: 5, method: 'acme/anything', params: { _meta: { ...ENVELOPE } } } as JSONRPCMessage, MODERN);
        h.deliver({ jsonrpc: '2.0', id: 6, method: 'acme/anything', params: {} } as JSONRPCMessage);
        await h.flush();
        expect(served).toBe(2);
    });
});

describe('2026-era envelope requiredness at dispatch', () => {
    test('a modern-classified request without the envelope is −32602 naming the requirement', async () => {
        const h = await harness(receiver => {
            receiver.setRequestHandler('tools/list', () => ({ tools: [] }));
        });

        h.deliver({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } as JSONRPCMessage, MODERN);
        await h.flush();

        const error = errorOf(h.sent[0]);
        expect(error?.code).toBe(-32602);
        expect(error?.message).toContain('_meta envelope');
    });

    test('a modern-classified request with a valid envelope is served (handler sees the 2025 shape)', async () => {
        const h = await harness(receiver => {
            receiver.setRequestHandler('tools/list', () => ({ tools: [] }));
        });

        h.deliver({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: { ...ENVELOPE } } } as JSONRPCMessage, MODERN);
        await h.flush();

        expect(resultOf(h.sent[0])).toMatchObject({ tools: [] });
    });

    test('the 2025 era never requires an envelope', async () => {
        const h = await harness(receiver => {
            receiver.setRequestHandler('tools/list', () => ({ tools: [] }));
        });

        h.deliver({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} } as JSONRPCMessage);
        await h.flush();
        expect(resultOf(h.sent[0])).toMatchObject({ tools: [] });
    });
});

describe('the stamp seam and the never-stamp guarantee', () => {
    test('2026-classified responses are stamped resultType: complete', async () => {
        const h = await harness(receiver => {
            receiver.setRequestHandler('tools/list', () => ({ tools: [] }));
        });

        h.deliver({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { ...ENVELOPE } } } as JSONRPCMessage, MODERN);
        await h.flush();

        expect(resultOf(h.sent[0])).toMatchObject({ resultType: 'complete' });
    });

    test('2025-era responses NEVER carry resultType (no stamp code path exists)', async () => {
        const h = await harness(receiver => {
            receiver.setRequestHandler('tools/list', () => ({ tools: [] }));
        });

        h.deliver({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } as JSONRPCMessage);
        await h.flush();

        const result = resultOf(h.sent[0]);
        expect(result).toBeDefined();
        expect(result && 'resultType' in result).toBe(false);
    });

    test('the 2025 codec encodeResult is the identity (same reference, nothing added)', async () => {
        const { rev2025Codec } = await import('../../src/wire/rev2025-11-25/codec.js');
        const result = { content: [{ type: 'text', text: 'x' }] } as unknown as Result;
        expect(rev2025Codec.encodeResult('tools/call', result)).toBe(result);
    });
});

describe('encode-side deleted-field strictness (Q1-SD3 iii)', () => {
    const TOOL_WITH_EXECUTION = {
        name: 'legacy-tool',
        inputSchema: { type: 'object' },
        execution: { taskSupport: 'optional' }
    };

    test('execution.taskSupport is stripped from 2026-era tools/list emissions', async () => {
        const h = await harness(receiver => {
            receiver.setRequestHandler('tools/list', (() => ({ tools: [TOOL_WITH_EXECUTION] })) as never);
        });

        h.deliver({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { ...ENVELOPE } } } as JSONRPCMessage, MODERN);
        await h.flush();

        const tools = resultOf(h.sent[0])?.tools as Array<Record<string, unknown>>;
        expect(tools[0]).toMatchObject({ name: 'legacy-tool' });
        expect('execution' in tools[0]!).toBe(false);
    });

    test('the same handler emits execution untouched on the 2025 era (era-invisible handlers)', async () => {
        const h = await harness(receiver => {
            receiver.setRequestHandler('tools/list', (() => ({ tools: [TOOL_WITH_EXECUTION] })) as never);
        });

        h.deliver({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } as JSONRPCMessage);
        await h.flush();

        const tools = resultOf(h.sent[0])?.tools as Array<Record<string, unknown>>;
        expect(tools[0]).toMatchObject({ name: 'legacy-tool', execution: { taskSupport: 'optional' } });
    });

    test('capabilities.tasks is stripped from 2026-era capability-carrying emissions (server/discover)', async () => {
        const h = await harness(receiver => {
            receiver.setRequestHandler(
                'server/discover' as never,
                (() => ({
                    ttlMs: 0,
                    cacheScope: 'private',
                    supportedVersions: ['2026-07-28'],
                    capabilities: { tools: {}, tasks: { list: {} } },
                    serverInfo: { name: 's', version: '0' }
                })) as never
            );
        });

        h.deliver({ jsonrpc: '2.0', id: 3, method: 'server/discover', params: { _meta: { ...ENVELOPE } } } as JSONRPCMessage, MODERN);
        await h.flush();

        const result = resultOf(h.sent[0]);
        expect(result).toMatchObject({ resultType: 'complete', capabilities: { tools: {} } });
        expect('tasks' in (result?.capabilities as Record<string, unknown>)).toBe(false);
    });
});

describe('outbound era gates — typed local error before the transport', () => {
    test('a 2026-bound instance cannot send 2025-only spec methods', async () => {
        const h = await harness();
        bindWireVersion(h.receiver, '2026-07-28');

        for (const method of ['tasks/get', 'ping', 'logging/setLevel', 'resources/subscribe']) {
            const attempt = () => h.receiver.request({ method } as never);
            expect(attempt, method).toThrow(SdkError);
            try {
                attempt();
            } catch (error) {
                expect((error as SdkError).code, method).toBe(SdkErrorCode.MethodNotSupportedByProtocolVersion);
                expect((error as SdkError).data, method).toMatchObject({ method, era: '2026-07-28' });
            }
        }
        // Nothing reached the transport.
        expect(h.sent).toHaveLength(0);
    });

    test('a legacy-bound instance cannot send server/discover', async () => {
        const h = await harness();
        bindWireVersion(h.receiver, '2025-11-25');

        expect(() => h.receiver.request({ method: 'server/discover' } as never)).toThrow(SdkError);
        try {
            h.receiver.request({ method: 'server/discover' } as never);
        } catch (error) {
            expect((error as SdkError).code).toBe(SdkErrorCode.MethodNotSupportedByProtocolVersion);
        }
        expect(h.sent).toHaveLength(0);
    });

    test('outbound era-mismatched spec notifications die locally too', async () => {
        const h = await harness();
        bindWireVersion(h.receiver, '2026-07-28');

        await expect(h.receiver.notification({ method: 'notifications/roots/list_changed' })).rejects.toMatchObject({
            code: SdkErrorCode.MethodNotSupportedByProtocolVersion
        });
        expect(h.sent).toHaveLength(0);
    });

    test('pre-negotiation bootstrap pins still route initialize to the 2025 era', async () => {
        // An UNBOUND instance may always send the legacy handshake; binding a
        // modern version afterwards closes it (the pin is pre-negotiation
        // only — a negotiated session never re-routes onto the other era).
        const h = await harness();
        const pending = h.receiver.request({
            method: 'initialize',
            params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '0' } }
        });
        pending.catch(() => undefined); // unanswered; we only assert the send happened
        await h.flush();
        // The handshake reached the wire (sent[] captures the peer's inbox).
        expect(h.sent).toHaveLength(1);
        expect((h.sent[0] as { method?: string }).method).toBe('initialize');
        await h.receiver.close();

        const h2 = await harness();
        bindWireVersion(h2.receiver, '2026-07-28');
        expect(() =>
            h2.receiver.request({
                method: 'initialize',
                params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '0' } }
            })
        ).toThrow(SdkError);
    });
});

describe('T6 width-leak killed at both roots', () => {
    test('2026 era: a task-shaped tools/call body can never parse as an empty success', async () => {
        const { rev2026Codec } = await import('../../src/wire/rev2026-07-28/codec.js');
        // resultType present-and-complete but the body is task-shaped: the
        // wire-exact parse requires content — loud invalid, never {content: []}.
        const decoded = rev2026Codec.decodeResult('tools/call', {
            resultType: 'complete',
            task: { taskId: 't-1', status: 'working' }
        });
        expect(decoded.kind).toBe('invalid');
    });

    test('2025 era: with the content default gone, a bare task-shaped body fails the plain schema loudly', async () => {
        const { rev2025Codec } = await import('../../src/wire/rev2025-11-25/codec.js');
        const { CallToolResultSchema } = await import('../../src/types/schemas.js');
        const decoded = rev2025Codec.decodeResult('tools/call', { task: { taskId: 't-1', status: 'working' } });
        expect(decoded.kind).toBe('complete');
        if (decoded.kind === 'complete') {
            // The plain schema (which IS the registry entry — the result map
            // is aligned to the typed map, no task-widened union): no
            // default([]) means no silent {content: []} masking.
            expect(CallToolResultSchema.safeParse(decoded.result).success).toBe(false);
        }
        // The GENERIC path agrees: the registry serves the same plain schema,
        // so even a fully conforming CreateTaskResult body is a loud schema
        // failure (surfaced as a typed INVALID_RESULT — see
        // test/shared/typedMapAlignment.test.ts). Task interop is the
        // explicit-schema overload, never a silent union member.
        const { getResultSchema } = await import('../../src/wire/rev2025-11-25/registry.js');
        const plain = getResultSchema('tools/call');
        expect(plain).toBe(CallToolResultSchema);
        expect(
            plain!.safeParse({
                task: {
                    taskId: '786af6b0-2779-48ed-9cc1-b8a8a25b8a86',
                    status: 'working',
                    createdAt: '2025-11-25T10:30:00Z',
                    lastUpdatedAt: '2025-11-25T10:30:05Z',
                    ttl: 60000,
                    pollInterval: 5000
                }
            }).success
        ).toBe(false);
    });
});
