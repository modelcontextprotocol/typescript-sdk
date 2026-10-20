import { createHash } from 'node:crypto';

import type { Skill, SkillResourceEntry } from '@modelcontextprotocol/core/ext/skills';
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';

import type { SkillCatalogOptions, SkillWarning } from '../../../src/ext/skills/index';
import { memorySkillFiles, SkillCatalogError, SkillsExtension } from '../../../src/ext/skills/index';
import { ESCALATION, fixtureFiles, GIT, GIT_SKILL_MD, LOGO, PNG, PURCHASE_ORDER, REFUNDS, REFUNDS_SKILL_MD, REMBOURSE } from './fixtures';
import { errorOf, LEGACY, newServer, resultOf } from './harness';

async function loaded(options: SkillCatalogOptions = {}) {
    const files = fixtureFiles();
    const warnings: SkillWarning[] = [];
    const catalog = await SkillsExtension.load(memorySkillFiles(files), { onWarning: warning => warnings.push(warning), ...options });
    const mcp = newServer();
    catalog.attach(mcp);
    return { catalog, mcp, warnings, files };
}

const skillUris = (result: Record<string, unknown>): string[] => (result['skills'] as Skill[]).map(skill => skill.uri);
const firstContent = (result: Record<string, unknown>): Record<string, unknown> | undefined =>
    (result['contents'] as Array<Record<string, unknown>>)[0];
const NEW_SKILL = `---
name: aaa
description: Sorts first.
---
`;

describe('SkillCatalog serving', () => {
    it('loads every skill sorted by URI and declares directoryRead with the skill:// template', async () => {
        const { catalog, mcp } = await loaded();
        expect(catalog.entries.map(skill => skill.uri)).toEqual([REFUNDS, ESCALATION, GIT]);
        expect(mcp.server.getCapabilities().extensions).toEqual({ 'io.modelcontextprotocol/skills': { directoryRead: true } });
        expect(await resultOf(mcp, 'resources/templates/list')).toMatchObject({
            resourceTemplates: [{ name: 'io.modelcontextprotocol/skills', uriTemplate: 'skill://{+path}' }]
        });
    });

    it('serves files under a prefix that needs strict encoding in the authority', async () => {
        const { catalog, mcp } = await loaded({ prefix: 'acme:prod' });
        const git = 'skill://acme%3Aprod/git-workflow/SKILL.md';
        expect(catalog.entries.map(skill => skill.uri)).toContain(git);
        expect(catalog.entries).toHaveLength(3);
        const review = new URL('references/REVIEW.md', git).href;
        expect(await resultOf(mcp, 'resources/read', { uri: review })).toMatchObject({ contents: [{ uri: review, text: '# Review\n' }] });
    });

    it('lists only SKILL.md resources in resources/list', async () => {
        const { mcp } = await loaded();
        expect(await resultOf(mcp, 'resources/list')).toMatchObject({
            resources: [
                { uri: REFUNDS, name: 'refunds', mimeType: 'text/markdown' },
                { uri: ESCALATION, name: 'escalation', mimeType: 'text/markdown' },
                { uri: GIT, name: 'git-workflow', mimeType: 'text/markdown' }
            ]
        });
    });

    it('pages skills/list with position cursors that survive a reload', async () => {
        const { mcp, catalog, files } = await loaded({ pageSize: 2 });
        const first = await resultOf(mcp, 'skills/list');
        expect(skillUris(first)).toEqual([REFUNDS, ESCALATION]);
        files['aaa/SKILL.md'] = NEW_SKILL;
        await catalog.reload();
        const second = await resultOf(mcp, 'skills/list', { cursor: first['nextCursor'] });
        expect(skillUris(second)).toEqual([GIT]);
        expect(second).not.toHaveProperty('nextCursor');
    });

    it('rejects bad cursors and bad page sizes, and serves one page with Infinity', async () => {
        const paged = await loaded();
        expect(await errorOf(paged.mcp, 'skills/list', { cursor: 'garbage' })).toMatchObject({ code: -32_602 });
        await expect(SkillsExtension.load(memorySkillFiles(fixtureFiles()), { pageSize: 0 })).rejects.toThrow(RangeError);
        const unpaged = await loaded({ pageSize: Number.POSITIVE_INFINITY });
        expect(skillUris(await resultOf(unpaged.mcp, 'skills/list'))).toHaveLength(3);
    });

    it('answers skills/get for served skills and -32602 otherwise', async () => {
        const { mcp } = await loaded();
        expect(await resultOf(mcp, 'skills/get', { uri: ESCALATION })).toMatchObject({ skill: { uri: ESCALATION } });
        expect(await errorOf(mcp, 'skills/get', { uri: 'skill://nope/SKILL.md' })).toMatchObject({ code: -32_602 });
    });

    it('serves text, binary and Windows-authored SKILL.md files byte for byte', async () => {
        const { mcp, catalog } = await loaded();
        expect(await resultOf(mcp, 'resources/read', { uri: GIT })).toMatchObject({
            contents: [{ uri: GIT, mimeType: 'text/markdown', text: GIT_SKILL_MD }]
        });
        const logo = firstContent(await resultOf(mcp, 'resources/read', { uri: LOGO }));
        expect(Buffer.from(String(logo?.['blob']), 'base64')).toEqual(Buffer.from(PNG));
        const refunds = firstContent(await resultOf(mcp, 'resources/read', { uri: REFUNDS }));
        expect(refunds?.['text']).toBe(REFUNDS_SKILL_MD);
        const entry = catalog.entries.find(skill => skill.uri === REFUNDS);
        const listed = (entry?.resources as SkillResourceEntry[]).find(resource => resource.uri === REFUNDS);
        expect(listed?.digest).toBe(`sha256:${createHash('sha256').update(REFUNDS_SKILL_MD).digest('hex')}`);
    });

    it('serves valid UTF-8 as text whatever the MIME type', async () => {
        const { mcp, catalog, files } = await loaded();
        files['git-workflow/LICENSE'] = 'MIT License\n';
        await catalog.reload();
        const uri = 'skill://git-workflow/LICENSE';
        const license = firstContent(await resultOf(mcp, 'resources/read', { uri }));
        expect(license).toEqual({ uri, mimeType: 'application/octet-stream', text: 'MIT License\n' });
    });

    it('serves names with a space or a non-ASCII letter, however the request spells the URI', async () => {
        const { mcp } = await loaded();
        for (const [requested, served, text] of [
            [PURCHASE_ORDER, PURCHASE_ORDER, '# PO\n'],
            ['skill://acme/billing/refunds/templates/Purchase Order.md', PURCHASE_ORDER, '# PO\n'],
            [REMBOURSE, REMBOURSE, '# Remboursement\n'],
            ['skill://acme/billing/refunds/templates/Remboursé.md', REMBOURSE, '# Remboursement\n']
        ] as const) {
            expect(await resultOf(mcp, 'resources/read', { uri: requested })).toMatchObject({ contents: [{ uri: served, text }] });
        }
    });

    it('answers -32602 when resources/read targets a directory', async () => {
        const { mcp } = await loaded();
        expect(await errorOf(mcp, 'resources/read', { uri: 'skill://acme/billing/refunds' })).toMatchObject({
            code: -32_602,
            message: expect.stringMatching(/is a directory/)
        });
    });

    it('fails a read whose file changed since loading, warning every time', async () => {
        const { mcp, files, warnings } = await loaded();
        files['git-workflow/references/REVIEW.md'] = '# Changed\n';
        const uri = 'skill://git-workflow/references/REVIEW.md';
        expect(await errorOf(mcp, 'resources/read', { uri })).toMatchObject({ code: -32_603 });
        expect(await errorOf(mcp, 'resources/read', { uri })).toMatchObject({ code: -32_603 });
        expect(warnings.filter(warning => warning.message.includes('changed since'))).toHaveLength(2);
    });

    it('fails a read whose content changed at the same size, by its digest', async () => {
        const { mcp, files, warnings } = await loaded();
        files['git-workflow/references/REVIEW.md'] = '# Reviex\n';
        expect(await errorOf(mcp, 'resources/read', { uri: 'skill://git-workflow/references/REVIEW.md' })).toMatchObject({
            code: -32_603
        });
        expect(warnings).toContainEqual({ path: 'git-workflow/references/REVIEW.md', message: expect.stringContaining('changed since') });
    });

    it('reads skill directories, with caching fields on 2026-07-28 only', async () => {
        const { mcp } = await loaded();
        const uri = 'skill://acme/billing/refunds';
        expect(await resultOf(mcp, 'resources/directory/read', { uri })).toMatchObject({
            resources: [{ name: 'SKILL.md' }, { name: 'assets' }, { name: 'escalation' }, { name: 'templates' }],
            ttlMs: 0,
            cacheScope: 'private'
        });
        expect(await resultOf(mcp, 'resources/directory/read', { uri }, LEGACY)).not.toHaveProperty('ttlMs');
        expect(await errorOf(mcp, 'resources/directory/read', { uri: 'skill://acme' })).toMatchObject({ code: -32_602 });
    });

    it('omits caching fields on skills/list for 2025-era connections', async () => {
        const { mcp } = await loaded();
        expect(await resultOf(mcp, 'skills/list', {}, LEGACY)).not.toHaveProperty('ttlMs');
    });

    it('serves many servers from one catalog', async () => {
        const { catalog } = await loaded();
        const servers = [newServer(), newServer(), newServer()];
        for (const server of servers) catalog.attach(server);
        for (const server of servers) expect(await resultOf(server, 'skills/get', { uri: GIT })).toMatchObject({ skill: { uri: GIT } });
    });

    it('keeps attach cheap while many attached servers are still alive', async () => {
        const { catalog } = await loaded();
        const servers = Array.from({ length: 1100 }, () => newServer());
        const deref = WeakRef.prototype.deref;
        let derefs = 0;
        WeakRef.prototype.deref = function (this: WeakRef<WeakKey>) {
            derefs++;
            return deref.call(this);
        };
        try {
            for (const server of servers) catalog.attach(server);
        } finally {
            WeakRef.prototype.deref = deref;
        }
        expect(derefs).toBeLessThan(2 * servers.length);
    });

    it('hands out frozen entries: an edit throws and never changes what is served', async () => {
        const { catalog, mcp } = await loaded();
        const refunds = catalog.entries.find(skill => skill.uri === REFUNDS)!;
        expect(() => {
            (refunds.frontmatter as Record<string, unknown>)['description'] = 'edited for display';
        }).toThrow(TypeError);
        expect(() => {
            (refunds.resources as SkillResourceEntry[])[0]!.digest = `sha256:${'0'.repeat(64)}`;
        }).toThrow(TypeError);
        expect(() => (refunds.resources as SkillResourceEntry[]).pop()).toThrow(TypeError);
        expect(() => (catalog.entries as Skill[]).pop()).toThrow(TypeError);
        expect(await resultOf(mcp, 'skills/get', { uri: REFUNDS })).toMatchObject({
            skill: { frontmatter: { description: 'Refund workflow.' } }
        });
        expect(catalog.entries).toHaveLength(3);
    });

    it('freezes nested frontmatter too', async () => {
        const skillMd = `---
name: owned
description: d
metadata:
  owner: billing
tags: [a, b]
---
`;
        const catalog = await SkillsExtension.load(memorySkillFiles({ 'owned/SKILL.md': skillMd }));
        const frontmatter = catalog.entries[0]!.frontmatter as unknown as { metadata: Record<string, string>; tags: string[] };
        expect(() => {
            frontmatter.metadata['owner'] = 'someone else';
        }).toThrow(TypeError);
        expect(() => frontmatter.tags.push('c')).toThrow(TypeError);
    });
});

describe('SkillCatalog.reload', () => {
    it('returns what changed', async () => {
        const { catalog, files } = await loaded();
        delete files['git-workflow/SKILL.md'];
        delete files['git-workflow/references/REVIEW.md'];
        files['acme/billing/refunds/templates/Purchase Order.md'] = '# PO v2\n';
        expect(await catalog.reload()).toEqual({ added: [], removed: [GIT], changed: [REFUNDS], listChanged: true });
        expect(catalog.entries.map(skill => skill.uri)).toEqual([REFUNDS, ESCALATION]);
    });

    it('reports listChanged only when what clients list changes', async () => {
        const { catalog, files } = await loaded();
        expect(await catalog.reload()).toEqual({ added: [], removed: [], changed: [], listChanged: false });
        files['git-workflow/references/REVIEW.md'] = '# Review v2\n';
        expect(await catalog.reload()).toEqual({ added: [], removed: [], changed: [GIT], listChanged: false });
        files['git-workflow/SKILL.md'] = GIT_SKILL_MD.replace('Branching and review conventions.', 'Branching, review and release.');
        expect(await catalog.reload()).toEqual({ added: [], removed: [], changed: [GIT], listChanged: true });
        files['aaa/SKILL.md'] = NEW_SKILL;
        expect(await catalog.reload()).toMatchObject({ added: ['skill://aaa/SKILL.md'], listChanged: true });
    });

    it('attaches and reloads where the runtime has no WeakRef, tracking no servers (Workers before 2025-05-05)', async () => {
        const { catalog, files } = await loaded();
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WeakRef')!;
        Reflect.deleteProperty(globalThis, 'WeakRef');
        try {
            expect(typeof WeakRef).toBe('undefined');
            const mcp = newServer();
            expect(() => catalog.attach(mcp)).not.toThrow();
            expect(await resultOf(mcp, 'skills/get', { uri: GIT })).toMatchObject({ skill: { uri: GIT } });
            const notify = vi.spyOn(mcp.server, 'sendResourceListChanged');
            const [, serverSide] = InMemoryTransport.createLinkedPair();
            await mcp.connect(serverSide);
            files['aaa/SKILL.md'] = NEW_SKILL;
            expect(await catalog.reload()).toMatchObject({ added: ['skill://aaa/SKILL.md'], listChanged: true });
            expect(notify).not.toHaveBeenCalled();
            await mcp.close();
        } finally {
            Object.defineProperty(globalThis, 'WeakRef', descriptor);
        }
    });

    it('keeps serving the old catalog when a reload fails', async () => {
        const { catalog, files, mcp } = await loaded({ strict: true });
        files['git-workflow/SKILL.md'] = `---
name: renamed
description: d
---
`;
        await expect(catalog.reload()).rejects.toBeInstanceOf(SkillCatalogError);
        expect(catalog.entries.map(skill => skill.uri)).toEqual([REFUNDS, ESCALATION, GIT]);
        expect(await resultOf(mcp, 'skills/get', { uri: GIT })).toMatchObject({ skill: { uri: GIT } });
    });

    it('runs overlapping reloads one after another', async () => {
        const { catalog, files } = await loaded();
        files['aaa/SKILL.md'] = NEW_SKILL;
        const [first, second] = await Promise.all([catalog.reload(), catalog.reload()]);
        expect(first.added).toEqual(['skill://aaa/SKILL.md']);
        expect(second.added).toEqual([]);
    });

    it('notifies each connected server once, and only when the listing changes', async () => {
        const { catalog, files, mcp: disconnected } = await loaded();
        const mcp = newServer();
        catalog.attach(mcp);
        catalog.attach(mcp);
        const notify = vi.spyOn(mcp.server, 'sendResourceListChanged');
        const skipped = vi.spyOn(disconnected.server, 'sendResourceListChanged');
        const [, serverSide] = InMemoryTransport.createLinkedPair();
        await mcp.connect(serverSide);
        files['git-workflow/references/REVIEW.md'] = '# Review v2\n';
        expect(await catalog.reload()).toMatchObject({ listChanged: false });
        expect(notify).not.toHaveBeenCalled();
        files['aaa/SKILL.md'] = NEW_SKILL;
        expect(await catalog.reload()).toMatchObject({ listChanged: true });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(skipped).not.toHaveBeenCalled();
        await mcp.close();
    });

    it('reports a failed list_changed send as a warning, never an unhandled rejection', async () => {
        const { catalog, files, warnings } = await loaded();
        const mcp = newServer();
        catalog.attach(mcp);
        const [, serverSide] = InMemoryTransport.createLinkedPair();
        await mcp.connect(serverSide);
        vi.spyOn(serverSide, 'send').mockRejectedValue(new Error('transport down'));
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        try {
            files['aaa/SKILL.md'] = NEW_SKILL;
            await expect(catalog.reload()).resolves.toMatchObject({ added: ['skill://aaa/SKILL.md'] });
            const sendFailed = { path: 'resources/list_changed', message: expect.stringContaining('transport down') };
            await vi.waitFor(() => expect(warnings).toContainEqual(sendFailed));
            await new Promise(resolve => setImmediate(resolve));
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
            await mcp.close();
        }
    });

    it('keeps a throwing onWarning from escaping a failed send or skipping the other servers', async () => {
        const sink = vi.fn(() => {
            throw new Error('sink failed');
        });
        const { catalog, files } = await loaded({ onWarning: sink });
        const servers = [newServer(), newServer(), newServer()];
        for (const server of servers) {
            catalog.attach(server);
            await server.connect(InMemoryTransport.createLinkedPair()[1]);
        }
        const [throwsSync, rejects, healthy] = servers.map(server => vi.spyOn(server.server, 'sendResourceListChanged'));
        throwsSync!.mockImplementation(() => {
            throw new Error('send threw');
        });
        rejects!.mockRejectedValue(new Error('transport down'));
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        try {
            files['aaa/SKILL.md'] = NEW_SKILL;
            await expect(catalog.reload()).resolves.toMatchObject({ listChanged: true });
            expect(healthy).toHaveBeenCalledTimes(1);
            await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(2));
            await new Promise(resolve => setImmediate(resolve));
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
            for (const server of servers) await server.close();
        }
    });
});
