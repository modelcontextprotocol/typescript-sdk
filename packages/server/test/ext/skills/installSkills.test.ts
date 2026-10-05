/**
 * SEP-2640 Skills extension, server side: capability advertisement, the
 * `skills/list` / `skills/get` handlers, pagination, the required -32602 on an
 * unknown skill URI, and the 2026-07-28 wire shape (`resultType` stamped by
 * the era codec, cache hints supplied by the extension).
 */
import type { JSONRPCRequest, MessageClassification } from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    setNegotiatedProtocolVersion,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core-internal';
import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import { SKILLS_EXTENSION_ID } from '@modelcontextprotocol/core/ext/skills';
import { describe, expect, it } from 'vitest';

import { installSkills, type InstallSkillsOptions, type SkillsCacheHint } from '../../../src/ext/skills';
import { invoke } from '../../../src/server/invoke';
import { Server } from '../../../src/server/server';

const MODERN_REVISION = '2026-07-28';
const MODERN: MessageClassification = { era: 'modern', revision: MODERN_REVISION };

const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
    [CLIENT_INFO_META_KEY]: { name: 'skills-test-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

const request = (method: string, params: Record<string, unknown> = {}): JSONRPCRequest =>
    ({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: ENVELOPE } }) as JSONRPCRequest;

const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

const skill = (name: string): Skill => ({
    uri: `skill://${name}/SKILL.md`,
    frontmatter: { name, description: `The ${name} skill.` },
    resources: [{ uri: `skill://${name}/SKILL.md`, digest: digest('a'), size: 64 }]
});

function serverWith(skills: readonly Skill[], options: Omit<InstallSkillsOptions, 'skills'> = {}): Server {
    const server = new Server({ name: 'skills-server', version: '1.0.0' }, { capabilities: { resources: {} } });
    installSkills(server, { skills, ...options });
    return server;
}

async function call(
    server: Server,
    message: JSONRPCRequest,
    classification: MessageClassification = MODERN
): Promise<Record<string, unknown>> {
    setNegotiatedProtocolVersion(server, classification.revision);
    const response = await invoke(server, message, { classification });
    const body = (await response.json()) as Record<string, unknown>;
    return body;
}

const resultOf = (body: Record<string, unknown>) => body['result'] as Record<string, unknown>;
const errorOf = (body: Record<string, unknown>) => body['error'] as { code: number; message: string };

describe('capability negotiation', () => {
    it('advertises the skills extension alongside the caller-declared resources capability', () => {
        const server = serverWith([skill('alpha')]);
        expect(server.getCapabilities()).toMatchObject({
            resources: {},
            extensions: { [SKILLS_EXTENSION_ID]: {} }
        });
    });

    it('rejects a duplicate skill URI at install time', () => {
        const server = new Server({ name: 's', version: '1' }, { capabilities: { resources: {} } });
        expect(() => installSkills(server, { skills: [skill('alpha'), skill('alpha')] })).toThrowError(/duplicate skill URI/);
    });

    it('rejects a non-positive pageSize at install time', () => {
        const server = new Server({ name: 's', version: '1' }, { capabilities: { resources: {} } });
        expect(() => installSkills(server, { skills: [], pageSize: 0 })).toThrowError(RangeError);
    });
});

describe('skills/list', () => {
    it('returns every skill in one page when no pageSize is set', async () => {
        const result = resultOf(await call(serverWith([skill('alpha'), skill('beta')]), request('skills/list')));
        expect((result['skills'] as Skill[]).map(s => s.frontmatter.name)).toEqual(['alpha', 'beta']);
        expect(result['nextCursor']).toBeUndefined();
    });

    it('paginates and never splits a skill entry across pages', async () => {
        const server = serverWith([skill('alpha'), skill('beta'), skill('gamma')], { pageSize: 2 });
        const first = resultOf(await call(server, request('skills/list')));
        expect((first['skills'] as Skill[]).map(s => s.frontmatter.name)).toEqual(['alpha', 'beta']);
        expect(first['nextCursor']).toBe('2');

        const second = resultOf(await call(server, request('skills/list', { cursor: first['nextCursor'] as string })));
        expect((second['skills'] as Skill[]).map(s => s.frontmatter.name)).toEqual(['gamma']);
        expect(second['nextCursor']).toBeUndefined();
    });

    it('rejects an out-of-range or non-numeric cursor with -32602', async () => {
        const server = serverWith([skill('alpha')], { pageSize: 1 });
        expect(errorOf(await call(server, request('skills/list', { cursor: '99' }))).code).toBe(-32_602);
        expect(errorOf(await call(server, request('skills/list', { cursor: 'nope' }))).code).toBe(-32_602);
    });
});

describe.each(['skills/list', 'skills/get'])('%s cache hints on the wire', method => {
    const params = method === 'skills/get' ? { uri: 'skill://alpha/SKILL.md' } : {};
    const payload = method === 'skills/get' ? { skill: skill('alpha') } : { skills: [skill('alpha')] };

    it.each<{ name: string; cacheHint?: SkillsCacheHint; ttlMs: number; cacheScope: string }>([
        { name: 'omitted', ttlMs: 0, cacheScope: 'private' },
        { name: 'empty', cacheHint: {}, ttlMs: 0, cacheScope: 'private' },
        { name: 'TTL only', cacheHint: { ttlMs: 60_000 }, ttlMs: 60_000, cacheScope: 'private' },
        { name: 'scope only', cacheHint: { cacheScope: 'public' }, ttlMs: 0, cacheScope: 'public' },
        { name: 'both', cacheHint: { ttlMs: 60_000, cacheScope: 'public' }, ttlMs: 60_000, cacheScope: 'public' }
    ])('fills modern fields when the hint is $name', async ({ cacheHint, ttlMs, cacheScope }) => {
        const server = serverWith([skill('alpha')], { cacheHint });
        const result = resultOf(await call(server, request(method, params)));
        expect(result).toMatchObject({ ...payload, resultType: 'complete', ttlMs, cacheScope });
    });

    it.each(SUPPORTED_PROTOCOL_VERSIONS)('omits modern fields on %s even with configured hints', async revision => {
        for (const cacheHint of [undefined, { ttlMs: 60_000, cacheScope: 'public' }] as const) {
            const server = serverWith([skill('alpha')], { cacheHint });
            const result = resultOf(await call(server, { jsonrpc: '2.0', id: 1, method, params }, { era: 'legacy', revision }));
            expect(result).toEqual(payload);
        }
    });

    it('does not let modern-looking metadata override the negotiated legacy era', async () => {
        const server = serverWith([skill('alpha')], { cacheHint: { ttlMs: 60_000, cacheScope: 'public' } });
        const result = resultOf(await call(server, request(method, params), { era: 'legacy', revision: '2025-11-25' }));
        expect(result).toEqual(payload);
    });
});

describe('skills/get', () => {
    it('returns the skill named by its SKILL.md URI', async () => {
        const result = resultOf(await call(serverWith([skill('alpha')]), request('skills/get', { uri: 'skill://alpha/SKILL.md' })));
        expect((result['skill'] as Skill).frontmatter.name).toBe('alpha');
    });

    it('answers for a served skill that skills/list does not page in', async () => {
        const server = serverWith([skill('alpha'), skill('beta')], { pageSize: 1 });
        const result = resultOf(await call(server, request('skills/get', { uri: 'skill://beta/SKILL.md' })));
        expect((result['skill'] as Skill).frontmatter.name).toBe('beta');
    });

    it('rejects an unknown skill URI with -32602', async () => {
        const error = errorOf(await call(serverWith([skill('alpha')]), request('skills/get', { uri: 'skill://nope/SKILL.md' })));
        expect(error.code).toBe(-32_602);
        expect(error.message).toContain('skill://nope/SKILL.md');
    });

    it('rejects a skill root URI that is not the SKILL.md URI with -32602', async () => {
        expect(errorOf(await call(serverWith([skill('alpha')]), request('skills/get', { uri: 'skill://alpha' }))).code).toBe(-32_602);
    });

    it('rejects missing params with -32602', async () => {
        expect(errorOf(await call(serverWith([skill('alpha')]), request('skills/get'))).code).toBe(-32_602);
    });
});
