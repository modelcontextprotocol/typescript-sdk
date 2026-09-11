/**
 * Client.request() must accept spec-conforming 2026-era results for the
 * SEP-2640 extension methods. The Inspector drives these as
 * `client.request(method, Modern*Schema)` — schemas that still require
 * `resultType: "complete"` after the codec has lifted/stripped that field.
 *
 * @see https://github.com/modelcontextprotocol/typescript-sdk/issues/2789
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { isJSONRPCRequest } from '@modelcontextprotocol/core-internal';
import { describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

import { Client } from '../../src/client/client';

const MODERN = '2026-07-28';

class ScriptedTransport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    sessionId?: string;

    constructor(private readonly results: Record<string, Record<string, unknown>>) {}

    async start(): Promise<void> {}
    async close(): Promise<void> {
        this.onclose?.();
    }
    async send(message: JSONRPCMessage): Promise<void> {
        if (!isJSONRPCRequest(message)) return;
        const result =
            message.method === 'server/discover'
                ? {
                      resultType: 'complete',
                      supportedVersions: [MODERN],
                      capabilities: {
                          resources: {},
                          extensions: { 'io.modelcontextprotocol/skills': { directoryRead: true } }
                      },
                      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'repro-server', version: '1.0.0' } }
                  }
                : this.results[message.method];
        if (result === undefined) return;
        queueMicrotask(() => {
            this.onmessage?.({ jsonrpc: '2.0', id: message.id, result });
        });
    }
    setProtocolVersion(_version: string): void {}
}

const SkillEntrySchema = z.looseObject({
    uri: z.string(),
    frontmatter: z.looseObject({
        name: z.string().optional(),
        description: z.string().optional()
    }),
    resources: z.union([z.literal('dynamic'), z.array(z.looseObject({ uri: z.string() }))])
});

const ModernListSkillsResultSchema = z.looseObject({
    skills: z.array(SkillEntrySchema),
    nextCursor: z.string().optional(),
    resultType: z.literal('complete'),
    ttlMs: z.int().min(0),
    cacheScope: z.enum(['public', 'private'])
});

const ModernGetSkillEnvelopeSchema = z.looseObject({
    skill: SkillEntrySchema,
    resultType: z.literal('complete')
});

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

async function connectClient(results: Record<string, Record<string, unknown>>): Promise<Client> {
    const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(new ScriptedTransport(results));
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
    return client;
}

describe('Client.request() skills/directory results with resultType: "complete" (#2789)', () => {
    test('skills/list accepts a spec-conforming complete result', async () => {
        const client = await connectClient({
            'skills/list': {
                resultType: 'complete',
                ttlMs: 0,
                cacheScope: 'private',
                skills: [SAMPLE_SKILL]
            }
        });

        const result = await client.request({ method: 'skills/list' }, ModernListSkillsResultSchema);
        expect(result.skills).toEqual([SAMPLE_SKILL]);
        expect(result.ttlMs).toBe(0);
        expect(result.cacheScope).toBe('private');

        await client.close();
    });

    test('skills/get accepts a spec-conforming complete result', async () => {
        const client = await connectClient({
            'skills/get': {
                resultType: 'complete',
                skill: SAMPLE_SKILL
            }
        });

        const result = await client.request({ method: 'skills/get', params: { uri: SAMPLE_SKILL.uri } }, ModernGetSkillEnvelopeSchema);
        expect(result.skill).toEqual(SAMPLE_SKILL);

        await client.close();
    });

    test('resources/directory/read accepts a spec-conforming complete result', async () => {
        const child = { uri: 'file://project/src', name: 'src' };
        const client = await connectClient({
            'resources/directory/read': {
                resultType: 'complete',
                resources: [child]
            }
        });

        const result = await client.request(
            { method: 'resources/directory/read', params: { uri: 'file://project' } },
            ModernDirectoryReadResultSchema
        );
        expect(result.resources).toEqual([child]);

        await client.close();
    });
});
