import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import { SKILLS_EXTENSION_ID } from '@modelcontextprotocol/core/ext/skills';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';

import { Client } from '../../../src/client/client';
import { SkillsClient } from '../../../src/ext/skills/index';
import { CAPABILITIES, namedSkill, PDF_ROOT } from './fixtures';
import type { Call, Handler } from './scripted';
import { RpcError, scriptedClient, skillsHandlers } from './scripted';

const NO_DIRECTORIES = { resources: {}, extensions: { [SKILLS_EXTENSION_ID]: {} } };
const DIGEST = `sha256:${'0'.repeat(64)}`;

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
        const handlers: Record<string, Handler> = { 'skills/list': () => ({ skills: [alpha, misnamed, escaping, { uri: 42 }, alpha] }) };
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
        const { client } = await scriptedClient(CAPABILITIES, { 'skills/list': () => ({ skills: [alpha, alpha, beta] }) });
        await expect(new SkillsClient(client).list()).rejects.toMatchObject({
            code: SdkErrorCode.InvalidResult,
            data: {
                invalid: [expect.objectContaining({ index: 0, uri: alpha!.uri }), expect.objectContaining({ index: 1, uri: alpha!.uri })]
            }
        });
    });

    it('throws on a malformed response', async () => {
        const { client } = await scriptedClient(CAPABILITIES, { 'skills/list': () => ({ skills: 'nope' }) });
        await expect(new SkillsClient(client).list()).rejects.toThrow(/skills\/list/);
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
            'skills/list': () => ({ skills: [wire] }),
            'skills/get': () => ({ skill: wire })
        });
        const skills = new SkillsClient(client, { skipInvalid: true });
        expect(await skills.list()).toEqual({
            skills: [],
            invalid: [{ index: 0, uri: alpha!.uri, reason: expect.stringContaining('__proto__') }]
        });
        await expect(skills.get(alpha!.uri)).rejects.toMatchObject({ code: SdkErrorCode.InvalidResult });
    });

    it('ends the walk on a page with the same items and cursor as the one before, as Client does', async () => {
        const [alpha] = await threeSkills();
        const { client, calls } = await scriptedClient(CAPABILITIES, { 'skills/list': () => ({ skills: [alpha], nextCursor: 'same' }) });
        expect(await new SkillsClient(client).list()).toEqual({ skills: [alpha], invalid: [] });
        expect(methodCalls(calls, 'skills/list')).toHaveLength(2);
    });

    it('throws ListPaginationExceeded on cursors that cycle, as Client does', async () => {
        const entries = await threeSkills();
        const cycling: Handler = params => {
            const at = params['cursor'] === 'A' ? 1 : params['cursor'] === 'B' ? 2 : 0;
            return { skills: [entries[at]], nextCursor: at === 1 ? 'B' : 'A' };
        };
        const { client, calls } = await scriptedClient(CAPABILITIES, { 'skills/list': cycling }, { listMaxPages: 5 });
        await expect(new SkillsClient(client).list()).rejects.toMatchObject({ code: SdkErrorCode.ListPaginationExceeded });
        expect(methodCalls(calls, 'skills/list')).toHaveLength(5);
    });

    it('gives up after listMaxPages on endless pagination', async () => {
        const endless: Handler = params => ({ skills: [], nextCursor: String(Number(params['cursor'] ?? 0) + 1) });
        const { client, calls } = await scriptedClient(CAPABILITIES, { 'skills/list': endless }, { listMaxPages: 5 });
        const error = await new SkillsClient(client).list().catch((error: unknown) => error);
        expect(error).toBeInstanceOf(SdkError);
        expect(error).toMatchObject({ code: SdkErrorCode.ListPaginationExceeded });
        expect(methodCalls(calls, 'skills/list')).toHaveLength(5);
    });
});

describe('SkillsClient.get', () => {
    it('returns the entry', async () => {
        const [alpha] = await threeSkills();
        const { client } = await scriptedClient(CAPABILITIES, skillsHandlers([alpha!], new Map()));
        expect(await new SkillsClient(client).get(alpha!.uri)).toEqual(alpha);
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
        const other = await scriptedClient(CAPABILITIES, { 'skills/get': () => ({ skill: beta }) });
        await expect(new SkillsClient(other.client).get(alpha!.uri)).rejects.toMatchObject({ code: SdkErrorCode.InvalidResult });
        const invalid = { ...alpha!, frontmatter: { ...alpha!.frontmatter, name: 'Not Valid' } };
        const broken = await scriptedClient(CAPABILITIES, { 'skills/get': () => ({ skill: invalid }) });
        await expect(new SkillsClient(broken.client).get(alpha!.uri)).rejects.toMatchObject({ code: SdkErrorCode.InvalidResult });
    });
});

describe('SkillsClient.readDirectory', () => {
    const references = { uri: `${PDF_ROOT}/references`, name: 'references', mimeType: 'inode/directory' };
    const manifest = { uri: `${PDF_ROOT}/SKILL.md`, name: 'SKILL.md', mimeType: 'text/markdown', size: 10 };

    it('walks every page', async () => {
        const pages: Handler = params =>
            params['cursor'] === undefined
                ? { resources: [manifest], nextCursor: 'p2', ttlMs: 0, cacheScope: 'private' }
                : { resources: [references], ttlMs: 0, cacheScope: 'private' };
        const { client, calls } = await scriptedClient(CAPABILITIES, { 'resources/directory/read': pages });
        expect(await new SkillsClient(client).readDirectory(PDF_ROOT)).toEqual([manifest, references]);
        expect(methodCalls(calls, 'resources/directory/read').map(call => call.params['uri'])).toEqual([PDF_ROOT, PDF_ROOT]);
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
