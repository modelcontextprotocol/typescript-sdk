/**
 * The stamping suppression suite: what is NEVER stamped.
 *
 *  S1 — legacy-classified traffic is never stamped (structural: the 2025-era
 *       codec has no stamp or cache code path; encode is the identity).
 *  S2 — input_required results never carry cache fields.
 *  S3 — results of non-cacheable operations are never given cache fields; the
 *       cacheable-operation list is closed.
 *  S4 — era-removed (2025-only) methods are never stamped: they have no
 *       2026-era registry entry, so they can never reach the 2026 encode
 *       seam, and their 2025-era responses are byte-untouched.
 *  S5 — stamping is response-side only: requests emitted by a 2026-era sender
 *       carry none of the result vocabulary.
 *  S6 — error responses are never stamped.
 *
 * Carve-out (documented leak note): cache fields AUTHORED BY THE CONSUMER on a
 * 2025-era result pass through unchanged — the suite asserts the absence of
 * SDK-stamped vocabulary only, because stripping consumer-authored fields
 * would change deployed 2025-era behavior for no gain.
 *
 * Together with the 2025 codec identity pin, this suite is the evidence that
 * this change produces zero 2025-era wire deltas.
 */
import { describe, expect, test } from 'vitest';

import type { BaseContext } from '../../src/shared/protocol';
import { Protocol, setNegotiatedProtocolVersion } from '../../src/shared/protocol';
import { attachCacheHintFallback, CACHEABLE_RESULT_METHODS } from '../../src/shared/resultCacheHints';
import type { JSONRPCMessage, MessageClassification, Result } from '../../src/types/index';
import { InMemoryTransport } from '../../src/util/inMemory';
import { rev2025Codec } from '../../src/wire/rev2025-11-25/codec';
import { rev2026Codec } from '../../src/wire/rev2026-07-28/codec';

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
    'io.modelcontextprotocol/clientInfo': { name: 'suppression-client', version: '0.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {}
};

/** The SDK-stamped result vocabulary the 2025 era must never gain. */
const STAMPED_VOCABULARY = ['resultType', 'ttlMs', 'cacheScope'] as const;

interface Harness {
    receiver: TestProtocol;
    deliver: (message: JSONRPCMessage, classification?: MessageClassification) => void;
    sent: JSONRPCMessage[];
    flush: () => Promise<void>;
}

async function harness(options: { era?: '2026-07-28'; setup?: (receiver: TestProtocol) => void } = {}): Promise<Harness> {
    const [peerTx, receiverTx] = InMemoryTransport.createLinkedPair();
    const sent: JSONRPCMessage[] = [];
    peerTx.onmessage = message => void sent.push(message);
    await peerTx.start();

    const receiver = new TestProtocol();
    receiver.onerror = () => {};
    options.setup?.(receiver);
    if (options.era !== undefined) setNegotiatedProtocolVersion(receiver, options.era);
    await receiver.connect(receiverTx);

    return {
        receiver,
        deliver: (message, classification) => receiverTx.onmessage?.(message, classification ? ({ classification } as never) : undefined),
        sent,
        flush: () => new Promise(resolve => setTimeout(resolve, 10))
    };
}

const resultOf = (msg: JSONRPCMessage | undefined) => (msg as { result?: Record<string, unknown> } | undefined)?.result;
const errorOf = (msg: JSONRPCMessage | undefined) => (msg as { error?: { code: number; data?: unknown } } | undefined)?.error;

function expectNoStampedVocabulary(value: unknown): void {
    const json = JSON.stringify(value);
    for (const key of STAMPED_VOCABULARY) {
        expect(json).not.toContain(`"${key}"`);
    }
}

describe('S1 — legacy-classified traffic is never stamped', () => {
    test('the 2025 codec encode is the identity for every cacheable operation, even with a configured hint attached', () => {
        for (const method of CACHEABLE_RESULT_METHODS) {
            const plain = { items: [] } as unknown as Result;
            expect(rev2025Codec.encodeResult(method, plain)).toBe(plain);

            const withHint = attachCacheHintFallback({ items: [] } as unknown as Result, { ttlMs: 60_000, cacheScope: 'public' });
            const encoded = rev2025Codec.encodeResult(method, withHint);
            expect(encoded).toBe(withHint);
            expectNoStampedVocabulary(encoded);
        }
    });

    test('a 2025-era (unclassified) tools/list exchange carries none of the stamped vocabulary', async () => {
        const h = await harness({
            setup: receiver => {
                receiver.setRequestHandler('tools/list', () => ({ tools: [] }));
            }
        });
        h.deliver({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } as JSONRPCMessage);
        await h.flush();
        expect(resultOf(h.sent[0])).toEqual({ tools: [] });
        expectNoStampedVocabulary(h.sent[0]);
    });
});

describe('S2 — input_required results never carry cache fields', () => {
    test('an input_required resources/read result on the 2026 era is emitted without ttlMs/cacheScope', async () => {
        const h = await harness({
            era: '2026-07-28',
            setup: receiver => {
                receiver.setRequestHandler('resources/read', (() => ({ resultType: 'input_required', inputRequests: {} })) as never);
            }
        });
        h.deliver(
            { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'test://a', _meta: { ...ENVELOPE } } } as JSONRPCMessage,
            MODERN
        );
        await h.flush();
        const result = resultOf(h.sent[0]);
        expect(result?.['resultType']).toBe('input_required');
        expect(result !== undefined && 'ttlMs' in result).toBe(false);
        expect(result !== undefined && 'cacheScope' in result).toBe(false);
    });
});

describe('S3 — non-cacheable operations are never filled', () => {
    test('the cacheable-operation list is closed (six operations; call/get/complete results are excluded)', () => {
        expect([...CACHEABLE_RESULT_METHODS].sort()).toEqual(
            ['prompts/list', 'resources/list', 'resources/read', 'resources/templates/list', 'server/discover', 'tools/list'].sort()
        );
        expect(CACHEABLE_RESULT_METHODS).not.toContain('tools/call');
        expect(CACHEABLE_RESULT_METHODS).not.toContain('prompts/get');
        expect(CACHEABLE_RESULT_METHODS).not.toContain('completion/complete');
    });

    test('a 2026-era tools/call result is stamped but never given cache fields', async () => {
        const h = await harness({
            era: '2026-07-28',
            setup: receiver => {
                receiver.setRequestHandler('tools/call', () => ({ content: [] }));
            }
        });
        h.deliver(
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't', arguments: {}, _meta: { ...ENVELOPE } } } as JSONRPCMessage,
            MODERN
        );
        await h.flush();
        const result = resultOf(h.sent[0]);
        expect(result?.['resultType']).toBe('complete');
        expect(result !== undefined && 'ttlMs' in result).toBe(false);
        expect(result !== undefined && 'cacheScope' in result).toBe(false);
    });
});

describe('S4 — era-removed (2025-only) methods are never stamped', () => {
    const LEGACY_ONLY_EMPTY_RESULT_CARRIERS = ['ping', 'logging/setLevel', 'resources/subscribe', 'resources/unsubscribe'] as const;

    test('the 2026-era registry has no entry for the 2025-only EmptyResult carriers (they can never reach the 2026 encode seam)', () => {
        for (const method of [...LEGACY_ONLY_EMPTY_RESULT_CARRIERS, 'initialize']) {
            expect(rev2026Codec.hasRequestMethod(method)).toBe(false);
        }
    });

    test('a 2025-era ping answer (EmptyResult) carries none of the stamped vocabulary', async () => {
        const h = await harness({
            setup: receiver => {
                receiver.setRequestHandler('ping', () => ({}));
            }
        });
        h.deliver({ jsonrpc: '2.0', id: 1, method: 'ping' } as JSONRPCMessage);
        await h.flush();
        expect(resultOf(h.sent[0])).toEqual({});
        expectNoStampedVocabulary(h.sent[0]);
    });

    test('a 2026-era instance answers an era-removed method with method-not-found and no stamped vocabulary', async () => {
        const h = await harness({
            era: '2026-07-28',
            setup: receiver => {
                receiver.setRequestHandler('ping', () => ({}));
            }
        });
        h.deliver({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { ...ENVELOPE } } } as JSONRPCMessage, MODERN);
        await h.flush();
        expect(errorOf(h.sent[0])?.code).toBe(-32_601);
        expectNoStampedVocabulary(h.sent[0]);
    });
});

describe('S5 — stamping is response-side only', () => {
    test('a request emitted by a 2026-era sender carries none of the result vocabulary', async () => {
        const [peerTx, senderTx] = InMemoryTransport.createLinkedPair();
        const requests: JSONRPCMessage[] = [];
        peerTx.onmessage = message => {
            requests.push(message);
            const request = message as { id?: number | string; method?: string };
            if (request.id !== undefined && request.method === 'server/discover') {
                void peerTx.send({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: {
                        resultType: 'complete',
                        ttlMs: 0,
                        cacheScope: 'private',
                        supportedVersions: ['2026-07-28'],
                        capabilities: {},
                        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'peer', version: '0.0.0' } }
                    }
                } as JSONRPCMessage);
            }
        };
        await peerTx.start();

        const sender = new TestProtocol();
        setNegotiatedProtocolVersion(sender, '2026-07-28');
        await sender.connect(senderTx);

        await sender.request({ method: 'server/discover' });

        expect(requests).toHaveLength(1);
        expectNoStampedVocabulary(requests[0]);
        await sender.close();
    });
});

describe('S6 — error responses are never stamped', () => {
    test('a handler-thrown error on the 2026 era is emitted without any result vocabulary', async () => {
        const h = await harness({
            era: '2026-07-28',
            setup: receiver => {
                receiver.setRequestHandler('tools/list', () => {
                    throw Object.assign(new Error('nope'), { code: -32_602 });
                });
            }
        });
        h.deliver({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { ...ENVELOPE } } } as JSONRPCMessage, MODERN);
        await h.flush();
        expect(errorOf(h.sent[0])?.code).toBe(-32_602);
        expectNoStampedVocabulary(h.sent[0]);
    });
});

describe('the consumer-authored carve-out (documented leak note)', () => {
    test('cache fields authored by a consumer handler on the 2025 era pass through unchanged — only SDK-stamped vocabulary is asserted absent', async () => {
        const h = await harness({
            setup: receiver => {
                receiver.setRequestHandler('tools/list', (() => ({ tools: [], ttlMs: 5_000, cacheScope: 'public' })) as never);
            }
        });
        h.deliver({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } as JSONRPCMessage);
        await h.flush();
        const result = resultOf(h.sent[0]);
        // Pass-through, byte-for-byte what the handler authored: stripping it
        // would change deployed 2025-era behavior. The negative-vocabulary
        // assertions in this suite therefore target SDK-stamped values only.
        expect(result).toEqual({ tools: [], ttlMs: 5_000, cacheScope: 'public' });
        expect(result !== undefined && 'resultType' in result).toBe(false);
    });
});
