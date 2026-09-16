/**
 * Caller-supplied result schemas that still model the 2026 wire envelope
 * (resultType: "complete") must accept a spec-conforming payload after
 * decodeResult lifts/strips the discriminator. This is the skills/directory
 * path used by the Inspector (SEP-2640): client.request(method, Modern*Schema).
 *
 * @see https://github.com/modelcontextprotocol/typescript-sdk/issues/2789
 */
import { describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

import type { BaseContext } from '../../src/shared/protocol';
import { Protocol, setNegotiatedProtocolVersion } from '../../src/shared/protocol';
import type { JSONRPCRequest } from '../../src/types/index';
import { InMemoryTransport } from '../../src/util/inMemory';

class TestProtocol extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

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

const SkillEntrySchema = z.looseObject({
    uri: z.string(),
    frontmatter: z.looseObject({
        name: z.string().optional(),
        description: z.string().optional()
    }),
    resources: z.union([z.literal('dynamic'), z.array(z.looseObject({ uri: z.string() }))])
});

/** Mirrors Inspector ModernListSkillsResultSchema (wire envelope + list page). */
const ModernListSkillsResultSchema = z.looseObject({
    skills: z.array(SkillEntrySchema),
    nextCursor: z.string().optional(),
    resultType: z.literal('complete'),
    ttlMs: z.int().min(0),
    cacheScope: z.enum(['public', 'private'])
});

/** Mirrors Inspector ModernGetSkillEnvelopeSchema. */
const ModernGetSkillEnvelopeSchema = z.looseObject({
    skill: SkillEntrySchema,
    resultType: z.literal('complete')
});

/** Mirrors Inspector ModernDirectoryReadResultSchema. */
const ModernDirectoryReadResultSchema = z.looseObject({
    resources: z.array(z.object({ uri: z.string(), name: z.string() })),
    nextCursor: z.string().optional(),
    resultType: z.literal('complete')
});

const SAMPLE_SKILL = {
    uri: 'skill://example/demo',
    frontmatter: { name: 'demo', description: 'A demo skill' },
    resources: 'dynamic' as const
};

describe('caller schemas that require resultType after decodeResult lift (#2789)', () => {
    test('skills/list accepts a spec-conforming resultType: "complete" payload', async () => {
        const protocol = await wireWithRawResult({
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private',
            skills: [SAMPLE_SKILL]
        });

        const result = await protocol.request({ method: 'skills/list' }, ModernListSkillsResultSchema);
        expect(result.skills).toEqual([SAMPLE_SKILL]);
        expect(result.ttlMs).toBe(0);
        expect(result.cacheScope).toBe('private');

        await protocol.close();
    });

    test('skills/get accepts a spec-conforming resultType: "complete" payload', async () => {
        const protocol = await wireWithRawResult({
            resultType: 'complete',
            skill: SAMPLE_SKILL
        });

        const result = await protocol.request({ method: 'skills/get', params: { uri: SAMPLE_SKILL.uri } }, ModernGetSkillEnvelopeSchema);
        expect(result.skill).toEqual(SAMPLE_SKILL);

        await protocol.close();
    });

    test('resources/directory/read accepts a spec-conforming resultType: "complete" payload', async () => {
        const child = { uri: 'file://project/src', name: 'src' };
        const protocol = await wireWithRawResult({
            resultType: 'complete',
            resources: [child]
        });

        const result = await protocol.request(
            { method: 'resources/directory/read', params: { uri: 'file://project' } },
            ModernDirectoryReadResultSchema
        );
        expect(result.resources).toEqual([child]);

        await protocol.close();
    });

    test('a payload that is actually invalid still fails after the discriminator is restored', async () => {
        const protocol = await wireWithRawResult({
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private'
            // skills is required
        });

        await expect(protocol.request({ method: 'skills/list' }, ModernListSkillsResultSchema)).rejects.toThrow(
            /Invalid result for skills\/list/
        );

        await protocol.close();
    });
});
