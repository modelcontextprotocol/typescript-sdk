/**
 * Physical deletions through real dispatch (Q1 increment 2).
 *
 * Era is INSTANCE state: the negotiated protocol version held by the
 * Protocol instance selects the wire codec for everything the connection
 * sends and receives. Legacy is the default (hand-constructed instances and
 * pre-negotiation traffic); modern-era instances get their version set
 * through the package-internal hook (`setNegotiatedProtocolVersion`) — the
 * same channel the modern-era server entry will use at instance binding.
 *
 * Registry membership is the deletion story, and these tests prove it at the
 * protocol funnels, in both directions:
 *
 *  - inbound: `tasks/get` on a modern-era instance gets −32601 BY ABSENCE —
 *    even with a handler registered (a custom handler cannot shadow a
 *    deleted spec method across eras); era-deleted spec notifications are
 *    silently dropped even with a handler registered.
 *  - outbound: an era-mismatched spec method dies locally with
 *    `SdkErrorCode.MethodNotSupportedByProtocolVersion` before anything
 *    reaches the transport.
 *  - the 2026 era requires the per-request envelope (−32602 when missing).
 *  - the stamp seam: 2026-era responses carry `resultType: 'complete'`;
 *    2025-era responses NEVER carry it (the 2025 codec has no stamp code
 *    path — the never-stamp guarantee).
 *  - encode-side deleted-field strictness (Q1-SD3 iii): `execution` is
 *    stripped from tools and `tasks` from capability objects on 2026-era
 *    emissions; both survive untouched on the 2025 era.
 *
 * `MessageExtraInfo.classification` (INJECTED here; the production
 * classifier is the entry/edge's job) no longer selects the era per message:
 * the funnel VALIDATES it against the instance era — a mismatch is an
 * entry/routing error (typed −32022 rejection / notification drop, plus
 * onerror), and unclassified traffic on a legacy instance behaves exactly as
 * before the codec split (the B-2 rule).
 */
import { describe, expect, test } from 'vitest';

import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors';
import type { BaseContext } from '../../src/shared/protocol';
import { Protocol, setNegotiatedProtocolVersion } from '../../src/shared/protocol';
import type { JSONRPCMessage, MessageClassification, Result } from '../../src/types/index';
import { InMemoryTransport } from '../../src/util/inMemory';
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
    /** Out-of-band errors surfaced via the receiver's onerror. */
    errors: Error[];
    flush: () => Promise<void>;
}

interface HarnessOptions {
    /**
     * Marks the instance's era through the package-internal hook (the same
     * channel the modern-era server entry uses at instance binding). Omitted
     * = legacy default, exactly like a hand-constructed instance.
     */
    era?: '2025-11-25' | '2026-07-28';
    setup?: (receiver: TestProtocol) => void;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
    const [peerTx, receiverTx] = InMemoryTransport.createLinkedPair();
    const sent: JSONRPCMessage[] = [];
    peerTx.onmessage = message => void sent.push(message);
    await peerTx.start();

    const receiver = new TestProtocol();
    const errors: Error[] = [];
    receiver.onerror = error => void errors.push(error);
    options.setup?.(receiver);
    if (options.era !== undefined) setNegotiatedProtocolVersion(receiver, options.era);
    await receiver.connect(receiverTx);

    return {
        receiver,
        // Invoke the receiver-side transport callback directly so the test
        // controls MessageExtraInfo (the classification handoff seam).
        deliver: (message, classification) => receiverTx.onmessage?.(message, classification ? ({ classification } as never) : undefined),
        sent,
        errors,
        flush: () => new Promise(resolve => setTimeout(resolve, 10))
    };
}

const errorOf = (msg: JSONRPCMessage | undefined) => (msg as { error?: { code: number; message: string } } | undefined)?.error;
const resultOf = (msg: JSONRPCMessage | undefined) => (msg as { result?: Record<string, unknown> } | undefined)?.result;

describe('inbound era gates — deletions are physical, era is instance state', () => {
    const registerTasksGetHandler = (onRun: () => void) => (receiver: TestProtocol) => {
        // A custom (3-arg) handler deliberately shadowing the deleted
        // spec method: it may serve the 2025 era only.
        receiver.setRequestHandler('tasks/get', { params: z.looseObject({ taskId: z.string() }) }, () => {
            onRun();
            return {} as Result;
        });
    };

    test('a modern-era instance answers tasks/get with −32601 BY ABSENCE even with a handler registered', async () => {
        let handlerRan = false;
        const h = await harness({ era: '2026-07-28', setup: registerTasksGetHandler(() => (handlerRan = true)) });

        // A matching modern classification rides along untouched — the
        // handoff check accepts it; the era gate still answers by absence.
        h.deliver(
            { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId: 't-1', _meta: { ...ENVELOPE } } } as JSONRPCMessage,
            MODERN
        );
        await h.flush();

        expect(handlerRan).toBe(false);
        expect(h.sent).toHaveLength(1);
        expect(errorOf(h.sent[0])).toMatchObject({ code: -32601, message: 'Method not found' });
    });

    test('a legacy-era instance (the default) serves tasks/get with that handler — era is fixed per instance', async () => {
        let handlerRan = false;
        const h = await harness({ setup: registerTasksGetHandler(() => (handlerRan = true)) });

        // Unclassified, hand-wired instance ⇒ legacy default (B-2): exactly
        // the pre-split behavior.
        h.deliver({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId: 't-1' } } as JSONRPCMessage);
        await h.flush();

        expect(handlerRan).toBe(true);
        expect(resultOf(h.sent[0])).toBeDefined();
    });

    test('ping on a modern-era instance is −32601 by absence (the built-in pong cannot cross eras)', async () => {
        const modern = await harness({ era: '2026-07-28' });
        modern.deliver({ jsonrpc: '2.0', id: 3, method: 'ping', params: { _meta: { ...ENVELOPE } } } as JSONRPCMessage, MODERN);
        await modern.flush();
        expect(errorOf(modern.sent[0])).toMatchObject({ code: -32601 });

        // …while a legacy-era instance keeps the automatic pong.
        const legacy = await harness();
        legacy.deliver({ jsonrpc: '2.0', id: 4, method: 'ping' } as JSONRPCMessage);
        await legacy.flush();
        expect(resultOf(legacy.sent[0])).toEqual({});
    });

    test('a spec notification the modern era deleted is dropped even with a handler', async () => {
        let delivered = 0;
        const registerHandler = (receiver: TestProtocol) => {
            receiver.setNotificationHandler('notifications/tasks/status', { params: z.looseObject({}) }, () => {
                delivered += 1;
            });
        };

        const modern = await harness({ era: '2026-07-28', setup: registerHandler });
        modern.deliver(
            { jsonrpc: '2.0', method: 'notifications/tasks/status', params: { taskId: 't', status: 'working' } } as JSONRPCMessage,
            MODERN
        );
        await modern.flush();
        expect(delivered).toBe(0);

        // Legacy-era instance: delivered.
        const legacy = await harness({ setup: registerHandler });
        legacy.deliver({
            jsonrpc: '2.0',
            method: 'notifications/tasks/status',
            params: { taskId: 't', status: 'working' }
        } as JSONRPCMessage);
        await legacy.flush();
        expect(delivered).toBe(1);
    });

    test('out-of-universe custom methods stay era-blind (consumer-owned)', async () => {
        let served = 0;
        const registerHandler = (receiver: TestProtocol) => {
            receiver.setRequestHandler('acme/anything', { params: z.looseObject({}) }, () => {
                served += 1;
                return {} as Result;
            });
        };

        // Served on a modern-era instance (envelope present, as 2026 requires)…
        const modern = await harness({ era: '2026-07-28', setup: registerHandler });
        modern.deliver({ jsonrpc: '2.0', id: 5, method: 'acme/anything', params: { _meta: { ...ENVELOPE } } } as JSONRPCMessage, MODERN);
        // …and on a legacy-era instance, bare: the era gate never blocks
        // methods outside the spec universe on either era.
        const legacy = await harness({ setup: registerHandler });
        legacy.deliver({ jsonrpc: '2.0', id: 6, method: 'acme/anything', params: {} } as JSONRPCMessage);

        await modern.flush();
        await legacy.flush();
        expect(served).toBe(2);
    });
});

describe('2026-era envelope requiredness at dispatch', () => {
    test('a modern-era request without the envelope is −32602 naming the requirement', async () => {
        const h = await harness({
            era: '2026-07-28',
            setup: receiver => {
                receiver.setRequestHandler('tools/list', () => ({ tools: [] }));
            }
        });

        h.deliver({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } as JSONRPCMessage, MODERN);
        await h.flush();

        const error = errorOf(h.sent[0]);
        expect(error?.code).toBe(-32602);
        expect(error?.message).toContain('_meta envelope');
    });

    test('a modern-era request with a valid envelope is served (handler sees the 2025 shape)', async () => {
        const h = await harness({
            era: '2026-07-28',
            setup: receiver => {
                receiver.setRequestHandler('tools/list', () => ({ tools: [] }));
            }
        });

        h.deliver({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: { ...ENVELOPE } } } as JSONRPCMessage, MODERN);
        await h.flush();

        expect(resultOf(h.sent[0])).toMatchObject({ tools: [] });
    });

    test('the 2025 era never requires an envelope', async () => {
        const h = await harness({
            setup: receiver => {
                receiver.setRequestHandler('tools/list', () => ({ tools: [] }));
            }
        });

        h.deliver({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} } as JSONRPCMessage);
        await h.flush();
        expect(resultOf(h.sent[0])).toMatchObject({ tools: [] });
    });

    test('−32601 outranks the missing envelope: unknown/era-deleted/unserved methods answer method-not-found', async () => {
        // Method existence outranks parameter validity (the canonical
        // precedence table for the full inbound validation ladder arrives
        // with the validation-ladder milestone; this pins the
        // −32601-over-−32602 rule on the modern leg). All three −32601
        // producers win over the envelope −32602:
        const h = await harness({ era: '2026-07-28' });

        // (a) out-of-universe method, no handler registered;
        h.deliver({ jsonrpc: '2.0', id: 4, method: 'acme/no-such-method', params: {} } as JSONRPCMessage, MODERN);
        // (b) spec method deleted from the era (the era gate runs first);
        h.deliver({ jsonrpc: '2.0', id: 5, method: 'tasks/get', params: { taskId: 't-1' } } as JSONRPCMessage, MODERN);
        // (c) spec method IN era but with no handler registered.
        h.deliver({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} } as JSONRPCMessage, MODERN);
        await h.flush();

        expect(h.sent).toHaveLength(3);
        for (const message of h.sent) {
            expect(errorOf(message)).toMatchObject({ code: -32601, message: 'Method not found' });
        }
    });
});

describe('the stamp seam and the never-stamp guarantee', () => {
    test('2026-era responses are stamped resultType: complete', async () => {
        const h = await harness({
            era: '2026-07-28',
            setup: receiver => {
                receiver.setRequestHandler('tools/list', () => ({ tools: [] }));
            }
        });

        h.deliver({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { ...ENVELOPE } } } as JSONRPCMessage, MODERN);
        await h.flush();

        expect(resultOf(h.sent[0])).toMatchObject({ resultType: 'complete' });
    });

    test('2025-era responses NEVER carry resultType (no stamp code path exists)', async () => {
        const h = await harness({
            setup: receiver => {
                receiver.setRequestHandler('tools/list', () => ({ tools: [] }));
            }
        });

        h.deliver({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } as JSONRPCMessage);
        await h.flush();

        const result = resultOf(h.sent[0]);
        expect(result).toBeDefined();
        expect(result && 'resultType' in result).toBe(false);
    });

    test('the 2025 codec encodeResult is the identity (same reference, nothing added)', async () => {
        const { rev2025Codec } = await import('../../src/wire/rev2025-11-25/codec');
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
        const h = await harness({
            era: '2026-07-28',
            setup: receiver => {
                receiver.setRequestHandler('tools/list', (() => ({ tools: [TOOL_WITH_EXECUTION] })) as never);
            }
        });

        h.deliver({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { ...ENVELOPE } } } as JSONRPCMessage, MODERN);
        await h.flush();

        const tools = resultOf(h.sent[0])?.tools as Array<Record<string, unknown>>;
        expect(tools[0]).toMatchObject({ name: 'legacy-tool' });
        expect('execution' in tools[0]!).toBe(false);
    });

    test('the same handler emits execution untouched on the 2025 era (era-invisible handlers)', async () => {
        const h = await harness({
            setup: receiver => {
                receiver.setRequestHandler('tools/list', (() => ({ tools: [TOOL_WITH_EXECUTION] })) as never);
            }
        });

        h.deliver({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } as JSONRPCMessage);
        await h.flush();

        const tools = resultOf(h.sent[0])?.tools as Array<Record<string, unknown>>;
        expect(tools[0]).toMatchObject({ name: 'legacy-tool', execution: { taskSupport: 'optional' } });
    });

    test('capabilities.tasks is stripped from 2026-era capability-carrying emissions (server/discover)', async () => {
        const h = await harness({
            era: '2026-07-28',
            setup: receiver => {
                receiver.setRequestHandler(
                    'server/discover' as never,
                    (() => ({
                        ttlMs: 0,
                        cacheScope: 'private',
                        supportedVersions: ['2026-07-28'],
                        capabilities: { tools: {}, tasks: { list: {} } }
                    })) as never
                );
            }
        });

        h.deliver({ jsonrpc: '2.0', id: 3, method: 'server/discover', params: { _meta: { ...ENVELOPE } } } as JSONRPCMessage, MODERN);
        await h.flush();

        const result = resultOf(h.sent[0]);
        expect(result).toMatchObject({ resultType: 'complete', capabilities: { tools: {} } });
        expect('tasks' in (result?.capabilities as Record<string, unknown>)).toBe(false);
    });
});

describe('the edge→instance handoff — classification is validated, never an era switch', () => {
    test('a modern-classified request on a legacy-era instance is an entry/routing error: typed −32022, handler never runs', async () => {
        let handlerRan = false;
        const h = await harness({
            setup: receiver => {
                receiver.setRequestHandler('tools/list', () => {
                    handlerRan = true;
                    return { tools: [] };
                });
            }
        });

        h.deliver({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { ...ENVELOPE } } } as JSONRPCMessage, MODERN);
        await h.flush();

        expect(handlerRan).toBe(false);
        expect(h.sent).toHaveLength(1);
        const error = errorOf(h.sent[0]);
        expect(error?.code).toBe(-32022);
        expect(error?.message).toContain('Unsupported protocol version');
        // Surfaced out of band too: the mismatch is the entry's bug, not the peer's.
        expect(h.errors.some(e => e.message.includes('Era mismatch'))).toBe(true);
    });

    test('a legacy-classified request on a modern-era instance is rejected the same way', async () => {
        const h = await harness({
            era: '2026-07-28',
            setup: receiver => {
                receiver.setRequestHandler('tools/list', () => ({ tools: [] }));
            }
        });

        h.deliver({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } as JSONRPCMessage, {
            era: 'legacy',
            revision: '2025-11-25'
        });
        await h.flush();

        expect(errorOf(h.sent[0])).toMatchObject({ code: -32022 });
        expect(h.errors.some(e => e.message.includes('Era mismatch'))).toBe(true);
    });

    test('the rejection’s data.requested names the exact revision the classification carried, not just the era label', async () => {
        const h = await harness({
            era: '2026-07-28',
            setup: receiver => {
                receiver.setRequestHandler('tools/list', () => ({ tools: [] }));
            }
        });

        h.deliver({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} } as JSONRPCMessage, {
            era: 'legacy',
            revision: '2025-06-18'
        });
        await h.flush();

        const error = errorOf(h.sent[0]) as { code: number; data?: { requested?: string } } | undefined;
        expect(error?.code).toBe(-32022);
        expect(error?.data?.requested).toBe('2025-06-18');
    });

    test('a modern-classified notification on a legacy-era instance is dropped, with onerror', async () => {
        let delivered = 0;
        const h = await harness({
            setup: receiver => {
                receiver.setNotificationHandler('notifications/progress', () => {
                    delivered += 1;
                });
            }
        });

        h.deliver(
            { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 1 } } as JSONRPCMessage,
            MODERN
        );
        await h.flush();

        expect(delivered).toBe(0);
        expect(h.sent).toHaveLength(0);
        expect(h.errors.some(e => e.message.includes('Era mismatch'))).toBe(true);
    });

    test('a matching classification rides along untouched (and unclassified legacy traffic is byte-identical — B-2)', async () => {
        const h = await harness({
            setup: receiver => {
                receiver.setRequestHandler('tools/list', () => ({ tools: [] }));
            }
        });

        // Matching legacy classification.
        h.deliver({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} } as JSONRPCMessage, { era: 'legacy' });
        // Unclassified (the hand-wired transport posture).
        h.deliver({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} } as JSONRPCMessage);
        await h.flush();

        expect(h.sent).toHaveLength(2);
        expect(resultOf(h.sent[0])).toMatchObject({ tools: [] });
        expect(resultOf(h.sent[1])).toMatchObject({ tools: [] });
        expect(h.errors).toHaveLength(0);
    });
});

describe('outbound era gates — typed local error before the transport', () => {
    test('a 2026-era instance cannot send 2025-only spec methods', async () => {
        const h = await harness({ era: '2026-07-28' });

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

    test('a legacy-era instance cannot send server/discover', async () => {
        const h = await harness({ era: '2025-11-25' });

        expect(() => h.receiver.request({ method: 'server/discover' } as never)).toThrow(SdkError);
        try {
            h.receiver.request({ method: 'server/discover' } as never);
        } catch (error) {
            expect((error as SdkError).code).toBe(SdkErrorCode.MethodNotSupportedByProtocolVersion);
        }
        expect(h.sent).toHaveLength(0);
    });

    test('outbound era-mismatched spec notifications die locally too', async () => {
        const h = await harness({ era: '2026-07-28' });

        await expect(h.receiver.notification({ method: 'notifications/roots/list_changed' })).rejects.toMatchObject({
            code: SdkErrorCode.MethodNotSupportedByProtocolVersion
        });
        expect(h.sent).toHaveLength(0);
    });

    test('_requestWithSchema applies the same outbound era gate: an explicit schema never smuggles a deleted method', async () => {
        const h = await harness({ era: '2026-07-28' });
        const requestWithSchema = (
            h.receiver as unknown as {
                _requestWithSchema: (request: { method: string }, schema: unknown) => Promise<unknown>;
            }
        )._requestWithSchema.bind(h.receiver);

        expect(() => requestWithSchema({ method: 'ping' }, z.object({}))).toThrow(SdkError);
        try {
            requestWithSchema({ method: 'ping' }, z.object({}));
        } catch (error) {
            expect((error as SdkError).code).toBe(SdkErrorCode.MethodNotSupportedByProtocolVersion);
            expect((error as SdkError).data).toMatchObject({ method: 'ping', era: '2026-07-28' });
        }
        expect(h.sent).toHaveLength(0);
    });

    test('pre-negotiation bootstrap pins still route initialize to the 2025 era', async () => {
        // An instance with NO negotiated version may always send the legacy
        // handshake; setting a modern version afterwards closes it (the pin
        // applies only while the negotiated version is unset — a negotiated
        // session never re-routes onto the other era).
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

        const h2 = await harness({ era: '2026-07-28' });
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
        const { rev2026Codec } = await import('../../src/wire/rev2026-07-28/codec');
        // resultType present-and-complete but the body is task-shaped: the
        // wire-exact parse requires content — loud invalid, never {content: []}.
        const decoded = rev2026Codec.decodeResult('tools/call', {
            resultType: 'complete',
            task: { taskId: 't-1', status: 'working' }
        });
        expect(decoded.kind).toBe('invalid');
    });

    test('2025 era: a bare task-shaped body fails the wire-seam schema — the content default cannot mask it', async () => {
        const { rev2025Codec } = await import('../../src/wire/rev2025-11-25/codec');
        const decoded = rev2025Codec.decodeResult('tools/call', { task: { taskId: 't-1', status: 'working' } });
        // Decode passes bodies without resultType through (explicit-schema
        // task interop must work); the wire-seam schema does the refusing.
        expect(decoded.kind).toBe('complete');
        // The wire-seam schema rejects even a fully conforming
        // CreateTaskResult on the plain path (typed INVALID_RESULT); task
        // interop is the explicit-schema overload only.
        const { getResultSchema } = await import('../../src/wire/rev2025-11-25/registry');
        const wireSeam = getResultSchema('tools/call');
        expect(
            wireSeam!.safeParse({
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
        // While a plain content-less tool result still defaults:
        expect(wireSeam!.safeParse({ structuredContent: { ok: true } }).success).toBe(true);
    });
});
