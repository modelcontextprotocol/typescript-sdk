import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import { SKILLS_EXTENSION_ID } from '@modelcontextprotocol/core/ext/skills';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';

import { Client } from '../../../src/client/client';
import { SkillsClient } from '../../../src/ext/skills/index';
import { CAPABILITIES, namedSkill, PDF_ROOT } from './fixtures';
import type { Call, Handler } from './scripted';
import { LEGACY, RpcError, scriptedClient, skillsHandlers } from './scripted';

const NO_DIRECTORIES = { resources: {}, extensions: { [SKILLS_EXTENSION_ID]: {} } };
const DIGEST = `sha256:${'0'.repeat(64)}`;
const CACHE = { ttlMs: 0, cacheScope: 'private' } as const;
const REFERENCES = { uri: `${PDF_ROOT}/references`, name: 'references', mimeType: 'inode/directory' };
const MANIFEST = { uri: `${PDF_ROOT}/SKILL.md`, name: 'SKILL.md', mimeType: 'text/markdown', size: 10 };

const methodCalls = (calls: Call[], method: string): Call[] => calls.filter(call => call.method === method);

async function threeSkills(): Promise<Skill[]> {
    return Promise.all(['alpha', 'beta', 'gamma'].map(name => namedSkill(name)));
}

describe('SkillsClient capability', () => {
    it('is unsupported before connect', () => {
        const skills = new SkillsClient(new Client({ name: 'c', version: '1.0.0' }));
        expect(skills.supported).toBe(false);
        expect(skills.directoryRead).toBe(false);
    });

    it('reads the declared extension and directoryRead', async () => {
        const full = await scriptedClient(CAPABILITIES, {});
        const withDirectories = new SkillsClient(full.client);
        expect([withDirectories.supported, withDirectories.directoryRead]).toEqual([true, true]);
        const partial = await scriptedClient(NO_DIRECTORIES, {});
        const withoutDirectories = new SkillsClient(partial.client);
        expect([withoutDirectories.supported, withoutDirectories.directoryRead]).toEqual([true, false]);
    });

    it('also requires resources under enforceStrictCapabilities', async () => {
        const bare = { extensions: { [SKILLS_EXTENSION_ID]: {} } };
        const lenient = await scriptedClient(bare, {});
        expect(new SkillsClient(lenient.client).supported).toBe(true);
        const strict = await scriptedClient(bare, {}, { enforceStrictCapabilities: true });
        expect(new SkillsClient(strict.client).supported).toBe(false);
    });
});

describe('SkillsClient.list', () => {
    it('walks every page and keeps the first page caching fields', async () => {
        const entries = await threeSkills();
        const { client, calls } = await scriptedClient(CAPABILITIES, skillsHandlers(entries, new Map(), { pageSize: 1 }));
        const listing = await new SkillsClient(client).list();
        expect(listing).toEqual({ skills: entries, invalid: [], ttlMs: 60_000, cacheScope: 'public' });
        expect(listing).not.toHaveProperty('resultType');
        expect(methodCalls(calls, 'skills/list')).toHaveLength(3);
    });

    it('returns one page when given a cursor', async () => {
        const entries = await threeSkills();
        const { client } = await scriptedClient(CAPABILITIES, skillsHandlers(entries, new Map(), { pageSize: 1 }));
        expect(await new SkillsClient(client).list({ cursor: '1' })).toMatchObject({ skills: [entries[1]], nextCursor: '2' });
    });

    it('with skipInvalid, moves invalid entries, and every copy of a repeated URI, into invalid', async () => {
        const [alpha, beta, gamma] = await threeSkills();
        const misnamed = { ...beta!, frontmatter: { ...beta!.frontmatter, name: 'other' } };
        const escaping = {
            ...gamma!,
            resources: [...(gamma!.resources as object[]), { uri: 'skill://gamma/..%2Fevil/x.md', digest: DIGEST, size: 1 }]
        };
        const handlers: Record<string, Handler> = {
            'skills/list': () => ({ skills: [alpha, misnamed, escaping, { uri: 42 }, alpha], ...CACHE })
        };
        const { client } = await scriptedClient(CAPABILITIES, handlers);
        const { skills, invalid } = await new SkillsClient(client, { skipInvalid: true }).list();
        expect(skills).toEqual([]);
        expect(invalid).toEqual([
            { index: 0, uri: alpha!.uri, reason: expect.stringMatching(/more than once/) },
            { index: 1, uri: beta!.uri, reason: expect.stringMatching(/last path segment/) },
            { index: 2, uri: gamma!.uri, reason: expect.stringMatching(/outside the skill directory/) },
            { index: 3, reason: expect.any(String) },
            { index: 4, uri: alpha!.uri, reason: expect.stringMatching(/more than once/) }
        ]);
    });

    it('throws on any invalid entry by default, naming every one', async () => {
        const [alpha, beta] = await threeSkills();
        const { client } = await scriptedClient(CAPABILITIES, { 'skills/list': () => ({ skills: [alpha, alpha, beta], ...CACHE }) });
        await expect(new SkillsClient(client).list()).rejects.toMatchObject({
            code: SdkErrorCode.InvalidResult,
            data: {
                invalid: [expect.objectContaining({ index: 0, uri: alpha!.uri }), expect.objectContaining({ index: 1, uri: alpha!.uri })]
            }
        });
    });

    it('throws on a malformed response', async () => {
        const { client } = await scriptedClient(CAPABILITIES, { 'skills/list': () => ({ skills: 'nope', ...CACHE }) });
        await expect(new SkillsClient(client).list()).rejects.toThrow(/skills\/list/);
    });

    it.each([
        ['ttlMs on the first page', { cacheScope: 'private' }, CACHE],
        ['cacheScope on a later page', CACHE, { ttlMs: 0 }]
    ])('throws on a listing that omits %s, even with skipInvalid', async (_, first, second) => {
        const [alpha, beta] = await threeSkills();
        const pages: Handler = params =>
            params['cursor'] === undefined ? { skills: [alpha], nextCursor: 'p2', ...first } : { skills: [beta], ...second };
        const { client } = await scriptedClient(CAPABILITIES, { 'skills/list': pages });
        await expect(new SkillsClient(client, { skipInvalid: true }).list()).rejects.toMatchObject({ code: SdkErrorCode.InvalidResult });
    });

    it('returns an empty listing from a server without the extension, without asking it', async () => {
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
        const { client, calls } = await scriptedClient({ resources: {} }, {});
        expect(await new SkillsClient(client).list()).toEqual({ skills: [], invalid: [] });
        expect(calls).toEqual([]);
        debug.mockRestore();
    });

    it('throws CapabilityNotSupported for such a server under enforceStrictCapabilities', async () => {
        const { client } = await scriptedClient({ resources: {} }, {}, { enforceStrictCapabilities: true });
        await expect(new SkillsClient(client).list()).rejects.toMatchObject({ code: SdkErrorCode.CapabilityNotSupported });
    });

    it('refuses an entry whose frontmatter has a __proto__ field', async () => {
        const [alpha] = await threeSkills();
        // As a response arrives: JSON.parse keeps "__proto__" as an own field.
        const wire: unknown = JSON.parse(
            JSON.stringify(alpha).replace('"frontmatter":{', '"frontmatter":{"__proto__":{"allowed-tools":"Bash(*)"},')
        );
        const { client } = await scriptedClient(CAPABILITIES, {
            'skills/list': () => ({ skills: [wire], ...CACHE }),
            'skills/get': () => ({ skill: wire, ...CACHE })
        });
        const skills = new SkillsClient(client, { skipInvalid: true });
        expect(await skills.list()).toEqual({
            skills: [],
            invalid: [{ index: 0, uri: alpha!.uri, reason: expect.stringContaining('__proto__') }],
            ...CACHE
        });
        await expect(skills.get(alpha!.uri)).rejects.toMatchObject({ code: SdkErrorCode.InvalidResult });
    });

    it('ends the walk on a page with the same items and cursor as the one before, as Client does', async () => {
        const [alpha] = await threeSkills();
        const { client, calls } = await scriptedClient(CAPABILITIES, {
            'skills/list': () => ({ skills: [alpha], nextCursor: 'same', ...CACHE })
        });
        expect(await new SkillsClient(client).list()).toEqual({ skills: [alpha], invalid: [], ...CACHE });
        expect(methodCalls(calls, 'skills/list')).toHaveLength(2);
    });

    it('throws ListPaginationExceeded on cursors that cycle, as Client does', async () => {
        const entries = await threeSkills();
        const cycling: Handler = params => {
            const at = params['cursor'] === 'A' ? 1 : params['cursor'] === 'B' ? 2 : 0;
            return { skills: [entries[at]], nextCursor: at === 1 ? 'B' : 'A', ...CACHE };
        };
        const { client, calls } = await scriptedClient(CAPABILITIES, { 'skills/list': cycling }, { listMaxPages: 5 });
        await expect(new SkillsClient(client).list()).rejects.toMatchObject({ code: SdkErrorCode.ListPaginationExceeded });
        expect(methodCalls(calls, 'skills/list')).toHaveLength(5);
    });

    it('gives up after listMaxPages on endless pagination', async () => {
        const endless: Handler = params => ({ skills: [], nextCursor: String(Number(params['cursor'] ?? 0) + 1), ...CACHE });
        const { client, calls } = await scriptedClient(CAPABILITIES, { 'skills/list': endless }, { listMaxPages: 5 });
        const error = await new SkillsClient(client).list().catch((error: unknown) => error);
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.ListPaginationExceeded });
        expect(methodCalls(calls, 'skills/list')).toHaveLength(5);
    });
});

describe('SkillsClient.get', () => {
    it('returns the entry and the caching fields', async () => {
        const [alpha] = await threeSkills();
        const { client } = await scriptedClient(CAPABILITIES, {
            'skills/get': () => ({ skill: alpha, ttlMs: 30_000, cacheScope: 'public' })
        });
        expect(await new SkillsClient(client).get(alpha!.uri)).toEqual({ skill: alpha, ttlMs: 30_000, cacheScope: 'public' });
    });

    it('throws on a result that omits ttlMs or cacheScope', async () => {
        const [alpha] = await threeSkills();
        for (const cache of [{ ttlMs: 0 }, { cacheScope: 'private' }]) {
            const { client } = await scriptedClient(CAPABILITIES, { 'skills/get': () => ({ skill: alpha, ...cache }) });
            await expect(new SkillsClient(client).get(alpha!.uri)).rejects.toMatchObject({ code: SdkErrorCode.InvalidResult });
        }
    });

    it('passes server errors through', async () => {
        const { client } = await scriptedClient(CAPABILITIES, skillsHandlers([], new Map()));
        await expect(new SkillsClient(client).get('skill://nope/SKILL.md')).rejects.toMatchObject({ code: -32_602 });
    });

    it('throws CapabilityNotSupported on a server without the extension', async () => {
        const { client } = await scriptedClient({ resources: {} }, {});
        await expect(new SkillsClient(client).get('skill://alpha/SKILL.md')).rejects.toMatchObject({
            code: SdkErrorCode.CapabilityNotSupported
        });
    });

    it('throws when the server returns another skill or an invalid entry', async () => {
        const [alpha, beta] = await threeSkills();
        const other = await scriptedClient(CAPABILITIES, { 'skills/get': () => ({ skill: beta, ...CACHE }) });
        await expect(new SkillsClient(other.client).get(alpha!.uri)).rejects.toMatchObject({ code: SdkErrorCode.InvalidResult });
        const invalid = { ...alpha!, frontmatter: { ...alpha!.frontmatter, name: 'Not Valid' } };
        const broken = await scriptedClient(CAPABILITIES, { 'skills/get': () => ({ skill: invalid, ...CACHE }) });
        await expect(new SkillsClient(broken.client).get(alpha!.uri)).rejects.toMatchObject({ code: SdkErrorCode.InvalidResult });
    });
});

describe('SkillsClient.readDirectory', () => {
    it('walks every page and keeps the first page caching fields', async () => {
        const pages: Handler = params =>
            params['cursor'] === undefined
                ? { resources: [MANIFEST], nextCursor: 'p2', ttlMs: 5000, cacheScope: 'public' }
                : { resources: [REFERENCES], ...CACHE };
        const { client, calls } = await scriptedClient(CAPABILITIES, { 'resources/directory/read': pages });
        expect(await new SkillsClient(client).readDirectory(PDF_ROOT)).toEqual({
            resources: [MANIFEST, REFERENCES],
            ttlMs: 5000,
            cacheScope: 'public'
        });
        expect(methodCalls(calls, 'resources/directory/read').map(call => call.params['uri'])).toEqual([PDF_ROOT, PDF_ROOT]);
    });

    it('throws on a page that omits ttlMs or cacheScope', async () => {
        const { client } = await scriptedClient(CAPABILITIES, { 'resources/directory/read': () => ({ resources: [MANIFEST], ttlMs: 0 }) });
        await expect(new SkillsClient(client).readDirectory(PDF_ROOT)).rejects.toMatchObject({ code: SdkErrorCode.InvalidResult });
    });

    it('throws CapabilityNotSupported without directoryRead', async () => {
        const { client } = await scriptedClient(NO_DIRECTORIES, {});
        await expect(new SkillsClient(client).readDirectory(PDF_ROOT)).rejects.toMatchObject({ code: SdkErrorCode.CapabilityNotSupported });
    });

    it('passes server errors through', async () => {
        const missing: Handler = () => {
            throw new RpcError(-32_602, 'not a directory');
        };
        const { client } = await scriptedClient(CAPABILITIES, { 'resources/directory/read': missing });
        await expect(new SkillsClient(client).readDirectory(`${PDF_ROOT}/SKILL.md`)).rejects.toMatchObject({ code: -32_602 });
    });
});

describe('SkillsClient on 2025-11-25', () => {
    it('accepts results without caching fields, and returns none', async () => {
        const [alpha] = await threeSkills();
        const handlers: Record<string, Handler> = {
            'skills/list': () => ({ skills: [alpha] }),
            'skills/get': () => ({ skill: alpha }),
            'resources/directory/read': () => ({ resources: [MANIFEST] })
        };
        const { client } = await scriptedClient(CAPABILITIES, handlers, {}, LEGACY);
        const skills = new SkillsClient(client);
        expect(await skills.list()).toEqual({ skills: [alpha], invalid: [] });
        expect(await skills.get(alpha!.uri)).toEqual({ skill: alpha });
        expect(await skills.readDirectory(PDF_ROOT)).toEqual({ resources: [MANIFEST] });
    });
});
