/**
 * Wire behaviour of the Skills extension, as a client sees it. This suite is
 * the contract for the SEP-3371 version (JSON-RPC middleware instead of a
 * resource template and handlers): it must pass unchanged against it.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { SkillCatalog, SkillSource } from '@modelcontextprotocol/server/ext/skills';
import { memorySkillFiles, skillEntry, SkillsExtension } from '@modelcontextprotocol/server/ext/skills';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

const LEGACY = '2025-11-25';
const MODERN = '2026-07-28';
const EXTENSION = 'io.modelcontextprotocol/skills';
const SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
const Loose = z.looseObject({});

const GIT_SKILL_MD = `---
name: git-workflow
description: Branching and review conventions.
---
# Git workflow
`;
const REVIEW_MD = '# Review\n';
const NOTES_MD = `---
name: notes
description: Team notes.
---
# Notes
`;
const GIT = 'skill://git-workflow/SKILL.md';
const REVIEW = 'skill://git-workflow/references/REVIEW.md';

let catalog: SkillCatalog;
const open: Client[] = [];

beforeAll(async () => {
    catalog = await SkillsExtension.load(
        memorySkillFiles({ 'git-workflow/SKILL.md': GIT_SKILL_MD, 'git-workflow/references/REVIEW.md': REVIEW_MD })
    );
});

afterEach(async () => {
    await Promise.all(open.splice(0).map(client => client.close()));
});

async function connect(revision: string, build: (mcp: McpServer) => void): Promise<Client> {
    const handler = createMcpHandler(() => {
        const mcp = new McpServer({ name: 'skills-wire', version: '1.0.0' });
        build(mcp);
        return mcp;
    });
    const client = new Client(
        { name: 'wire-client', version: '1.0.0' },
        revision === MODERN ? { versionNegotiation: { mode: { pin: MODERN } } } : {}
    );
    await client.connect(
        new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) })
    );
    open.push(client);
    return client;
}

function raw(client: Client, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return client.request({ method, ...(params !== undefined && { params }) }, Loose);
}

async function notesSource(withListing: boolean): Promise<SkillSource> {
    const notes = await skillEntry('notes', { 'SKILL.md': NOTES_MD });
    return {
        list: async () => ({ skills: [notes] }),
        get: async uri => (uri === notes.uri ? notes : undefined),
        read: async uri => (uri === notes.uri ? { text: NOTES_MD, mimeType: 'text/markdown' } : undefined),
        ...(withListing && { listResources: async () => [{ uri: notes.uri, name: 'notes', mimeType: 'text/markdown' }] })
    };
}

describe.each([LEGACY, MODERN])('skills wire behaviour on %s', revision => {
    // A 2026-07-28 result carries the cache fields and, in `_meta`, the server's identity (ResultMetaObject).
    const envelope =
        revision === MODERN ? { _meta: { [SERVER_INFO]: { name: 'skills-wire', version: '1.0.0' } }, ttlMs: 0, cacheScope: 'private' } : {};

    it('declares the extension next to resources', async () => {
        const client = await connect(revision, mcp => catalog.attach(mcp));
        expect(client.getServerCapabilities()).toMatchObject({ resources: {}, extensions: { [EXTENSION]: { directoryRead: true } } });
    });

    it('publishes one resource template', async () => {
        const client = await connect(revision, mcp => catalog.attach(mcp));
        const { resourceTemplates } = await raw(client, 'resources/templates/list');
        expect(resourceTemplates).toEqual([{ name: EXTENSION, uriTemplate: 'skill://{+path}' }]);
    });

    it('lists each SKILL.md in resources/list', async () => {
        const client = await connect(revision, mcp => catalog.attach(mcp));
        const { resources } = await raw(client, 'resources/list');
        expect(resources).toEqual([
            {
                uri: GIT,
                name: 'git-workflow',
                description: 'Branching and review conventions.',
                mimeType: 'text/markdown',
                size: GIT_SKILL_MD.length
            }
        ]);
    });

    it('serves files through resources/read', async () => {
        const client = await connect(revision, mcp => catalog.attach(mcp));
        const { contents } = await raw(client, 'resources/read', { uri: REVIEW });
        expect(contents).toEqual([{ uri: REVIEW, mimeType: 'text/markdown', text: REVIEW_MD }]);
    });

    it('answers skills/list, skills/get and resources/directory/read', async () => {
        const client = await connect(revision, mcp => catalog.attach(mcp));
        expect(await raw(client, 'skills/list')).toEqual({ skills: catalog.entries, ...envelope });
        expect(await raw(client, 'skills/get', { uri: GIT })).toEqual({ skill: catalog.entries[0], ...envelope });
        expect(await raw(client, 'resources/directory/read', { uri: 'skill://git-workflow' })).toEqual({
            resources: [
                { uri: GIT, name: 'SKILL.md', mimeType: 'text/markdown', size: GIT_SKILL_MD.length },
                { uri: 'skill://git-workflow/references', name: 'references', mimeType: 'inode/directory' }
            ],
            ...envelope
        });
    });

    it('uses the agreed error codes', async () => {
        const client = await connect(revision, mcp => catalog.attach(mcp));
        await expect(raw(client, 'resources/read', { uri: 'skill://nope/x.md' })).rejects.toMatchObject({ code: -32_602 });
        await expect(raw(client, 'resources/read', { uri: 'skill://git-workflow' })).rejects.toMatchObject({
            code: -32_602,
            message: expect.stringMatching(/is a directory/)
        });
        await expect(raw(client, 'skills/get', { uri: 'skill://nope/SKILL.md' })).rejects.toMatchObject({ code: -32_602 });
        await expect(raw(client, 'skills/list', { cursor: 'garbage' })).rejects.toMatchObject({ code: -32_602 });
    });

    it('lets an app resource registered first win at its URI (documented: do not do this)', async () => {
        const client = await connect(revision, mcp => {
            mcp.registerResource('override', REVIEW, { mimeType: 'text/plain' }, () => ({ contents: [{ uri: REVIEW, text: 'app wins' }] }));
            catalog.attach(mcp);
        });
        const { contents } = await raw(client, 'resources/read', { uri: REVIEW });
        expect(contents).toEqual([{ uri: REVIEW, text: 'app wins' }]);
        const { resources } = await raw(client, 'resources/list');
        expect((resources as Array<{ uri: string }>).map(resource => resource.uri)).toEqual([REVIEW, GIT]);
    });

    it('lists nothing in resources/list for a source without listResources, and no directoryRead', async () => {
        const source = new SkillsExtension({ source: await notesSource(false) });
        const client = await connect(revision, mcp => source.attach(mcp));
        expect(client.getServerCapabilities()?.extensions).toEqual({ [EXTENSION]: {} });
        const { resources } = await raw(client, 'resources/list');
        expect(resources).toEqual([]);
        const directoryRead = raw(client, 'resources/directory/read', { uri: 'skill://notes' });
        // 2026-07-28 Streamable HTTP answers an unimplemented method with HTTP 404 and a -32601 body; the client transport surfaces a 404 as SdkHttpError.
        await (revision === MODERN
            ? expect(directoryRead).rejects.toMatchObject({ data: { status: 404, text: expect.stringContaining('-32601') } })
            : expect(directoryRead).rejects.toMatchObject({ code: -32_601 }));
    });

    it('lists what listResources returns, and the host verifies source-built skills', async () => {
        const source = new SkillsExtension({ source: await notesSource(true) });
        const client = await connect(revision, mcp => source.attach(mcp));
        const { resources } = await raw(client, 'resources/list');
        expect(resources).toEqual([{ uri: 'skill://notes/SKILL.md', name: 'notes', mimeType: 'text/markdown' }]);
        const skills = new SkillsClient(client);
        const {
            skills: [notes]
        } = await skills.list();
        expect(await skills.read(notes!)).toMatchObject({ verified: true, frontmatter: { name: 'notes' } });
    });

    it('serves a source under another scheme with baseUri', async () => {
        const notes = await skillEntry('notes', { 'SKILL.md': NOTES_MD }, { baseUri: 'github://owner/repo/skills' });
        const source = new SkillsExtension({
            source: {
                list: async () => ({ skills: [notes] }),
                get: async uri => (uri === notes.uri ? notes : undefined),
                read: async uri => (uri === notes.uri ? { text: NOTES_MD } : undefined)
            },
            baseUri: 'github://owner/repo/skills'
        });
        const client = await connect(revision, mcp => source.attach(mcp));
        const { resourceTemplates } = await raw(client, 'resources/templates/list');
        expect(resourceTemplates).toEqual([{ name: EXTENSION, uriTemplate: 'github://owner/repo/skills/{+path}' }]);
        expect(await new SkillsClient(client).read(notes)).toMatchObject({
            uri: 'github://owner/repo/skills/notes/SKILL.md',
            verified: true
        });
    });
});
