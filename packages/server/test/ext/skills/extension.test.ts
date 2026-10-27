import { createHash } from 'node:crypto';

import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import { ListSkillsRequestParamsSchema, ReadResourceDirectoryRequestParamsSchema } from '@modelcontextprotocol/core/ext/skills';
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import type { SkillSource, SkillWarning } from '../../../src/ext/skills/index';
import { memorySkillFiles, SkillCatalogError, skillEntry, SkillsExtension } from '../../../src/ext/skills/index';
import type { ServerExtension } from '../../../src/server/extension';
import { ResourceTemplate } from '../../../src/server/mcp';
import { GIT, GIT_SKILL_MD } from './fixtures';
import { errorOf, LEGACY, newServer, resultOf } from './harness';

const digest = `sha256:${'a'.repeat(64)}`;
const gitWorkflow: Skill = {
    uri: 'skill://git-workflow/SKILL.md',
    frontmatter: { name: 'git-workflow', description: 'Branching and review conventions.' },
    resources: [{ uri: 'skill://git-workflow/SKILL.md', digest, size: 5 }]
};

function sourceOf(overrides: Partial<SkillSource> = {}): SkillSource {
    return {
        list: async () => ({ skills: [gitWorkflow] }),
        get: async uri => (uri === gitWorkflow.uri ? gitWorkflow : undefined),
        read: async uri => (uri === gitWorkflow.uri ? { text: '# Git', mimeType: 'text/markdown' } : undefined),
        ...overrides
    };
}

function served(options: Partial<ConstructorParameters<typeof SkillsExtension>[0]> = {}) {
    const warnings: SkillWarning[] = [];
    const mcp = newServer(new SkillsExtension({ source: sourceOf(), onWarning: warning => warnings.push(warning), ...options }));
    return { mcp, warnings };
}

describe('capability', () => {
    it('declares the extension, with directoryRead only when the source reads directories', () => {
        expect(served().mcp.server.getCapabilities().extensions).toEqual({ 'io.modelcontextprotocol/skills': {} });
        const withDirectories = served({ source: sourceOf({ readDirectory: async () => ({ resources: [] }) }) });
        expect(withDirectories.mcp.server.getCapabilities().extensions).toEqual({
            'io.modelcontextprotocol/skills': { directoryRead: true }
        });
        expect(withDirectories.mcp.server.getCapabilities().resources).toBeDefined();
    });
});

describe('skills/list', () => {
    it('serves the page with caching fields on 2026-07-28 only', async () => {
        const { mcp } = served({ cacheHint: { ttlMs: 60_000, cacheScope: 'public' } });
        expect(await resultOf(mcp, 'skills/list')).toMatchObject({ skills: [gitWorkflow], ttlMs: 60_000, cacheScope: 'public' });
        const legacy = await resultOf(mcp, 'skills/list', {}, LEGACY);
        expect(legacy['skills']).toEqual([gitWorkflow]);
        expect(legacy).not.toHaveProperty('ttlMs');
        expect(legacy).not.toHaveProperty('cacheScope');
    });

    it('defaults the caching fields to 0 / private', async () => {
        expect(await resultOf(served().mcp, 'skills/list')).toMatchObject({ ttlMs: 0, cacheScope: 'private' });
    });

    it('passes nextCursor through', async () => {
        const { mcp } = served({ source: sourceOf({ list: async () => ({ skills: [gitWorkflow], nextCursor: 'n' }) }) });
        expect(await resultOf(mcp, 'skills/list')).toMatchObject({ nextCursor: 'n' });
    });

    it('drops invalid entries from a source and warns, or fails with -32603 when strict', async () => {
        const broken = { ...gitWorkflow, uri: 'skill://broken/SKILL.md' };
        const lenient = served({ source: sourceOf({ list: async () => ({ skills: [gitWorkflow, broken] }) }) });
        const { skills } = await resultOf(lenient.mcp, 'skills/list');
        expect(skills).toEqual([gitWorkflow]);
        expect(lenient.warnings[0]).toMatchObject({ path: 'skill://broken/SKILL.md' });
        const strict = served({ strict: true, source: sourceOf({ list: async () => ({ skills: [broken] }) }) });
        expect(await errorOf(strict.mcp, 'skills/list')).toMatchObject({ code: -32_603 });
    });
});

describe('skills/get', () => {
    it('returns the entry with caching fields', async () => {
        expect(await resultOf(served().mcp, 'skills/get', { uri: gitWorkflow.uri })).toMatchObject({ skill: gitWorkflow, ttlMs: 0 });
    });

    it('answers -32602 for a skill it does not serve', async () => {
        expect(await errorOf(served().mcp, 'skills/get', { uri: 'skill://nope/SKILL.md' })).toMatchObject({ code: -32_602 });
    });

    it('answers -32603 when the source returns a different or invalid skill', async () => {
        const other = {
            ...gitWorkflow,
            uri: 'skill://other/SKILL.md',
            frontmatter: { name: 'other', description: 'd' },
            resources: [{ uri: 'skill://other/SKILL.md', digest, size: 1 }]
        };
        const differs = served({ source: sourceOf({ get: async () => other }) });
        expect(await errorOf(differs.mcp, 'skills/get', { uri: gitWorkflow.uri })).toMatchObject({ code: -32_603 });
        const invalid = { ...gitWorkflow, frontmatter: { name: 'Wrong', description: 'd' } };
        const broken = served({ source: sourceOf({ get: async () => invalid }) });
        expect(await errorOf(broken.mcp, 'skills/get', { uri: gitWorkflow.uri })).toMatchObject({ code: -32_603 });
    });
});

describe('resources/read through the skill template', () => {
    it('serves text, serves bytes as base64, and answers -32602 for unknown files', async () => {
        const bytes = Uint8Array.from([0, 1, 2, 255]);
        const { mcp } = served({
            source: sourceOf({
                read: async uri => {
                    if (uri === gitWorkflow.uri) return { text: '# Git', mimeType: 'text/markdown' };
                    if (uri === 'skill://git-workflow/logo.png') return { bytes, mimeType: 'image/png' };
                    return;
                }
            })
        });
        const { contents: text } = await resultOf(mcp, 'resources/read', { uri: gitWorkflow.uri });
        expect(text).toEqual([{ uri: gitWorkflow.uri, mimeType: 'text/markdown', text: '# Git' }]);
        const { contents: binary } = await resultOf(mcp, 'resources/read', { uri: 'skill://git-workflow/logo.png' });
        expect(binary).toEqual([
            { uri: 'skill://git-workflow/logo.png', mimeType: 'image/png', blob: Buffer.from(bytes).toString('base64') }
        ]);
        expect(await errorOf(mcp, 'resources/read', { uri: 'skill://git-workflow/missing.md' })).toMatchObject({ code: -32_602 });
    });

    it('registers the skill:// template under the extension id', async () => {
        const { resourceTemplates } = await resultOf(served().mcp, 'resources/templates/list');
        expect(resourceTemplates).toEqual([
            expect.objectContaining({ name: 'io.modelcontextprotocol/skills', uriTemplate: 'skill://{+path}' })
        ]);
    });
});

describe('resources/directory/read', () => {
    it('passes pages through with caching fields, answers -32602 for non-directories, and is absent without readDirectory', async () => {
        const child = { uri: 'skill://git-workflow/SKILL.md', name: 'SKILL.md', mimeType: 'text/markdown' };
        const { mcp } = served({
            source: sourceOf({
                readDirectory: async uri => (uri === 'skill://git-workflow' ? { resources: [child], nextCursor: 'n' } : undefined)
            })
        });
        expect(await resultOf(mcp, 'resources/directory/read', { uri: 'skill://git-workflow' })).toMatchObject({
            resources: [child],
            nextCursor: 'n',
            ttlMs: 0,
            cacheScope: 'private'
        });
        expect(await errorOf(mcp, 'resources/directory/read', { uri: 'skill://git-workflow/SKILL.md' })).toMatchObject({ code: -32_602 });
        expect(await errorOf(served().mcp, 'resources/directory/read', { uri: 'skill://git-workflow' })).toMatchObject({ code: -32_601 });
    });
});

describe('resources/list', () => {
    it('lists nothing from a source by default and what listResources returns otherwise', async () => {
        const { resources: none } = await resultOf(served().mcp, 'resources/list');
        expect(none).toEqual([]);
        const listed = { uri: gitWorkflow.uri, name: 'git-workflow', description: 'd', mimeType: 'text/markdown' };
        const outside = { uri: 'other://x/SKILL.md', name: 'x' };
        const { mcp, warnings } = served({ source: sourceOf({ listResources: async () => [listed, outside] }) });
        const { resources } = await resultOf(mcp, 'resources/list');
        expect(resources).toEqual([listed]);
        expect(warnings[0]).toMatchObject({ path: 'other://x/SKILL.md' });
    });
});

describe('baseUri', () => {
    it('serves a source under another scheme', async () => {
        const github: Skill = {
            uri: 'github://owner/repo/skills/refunds/SKILL.md',
            frontmatter: { name: 'refunds', description: 'Refunds.' },
            resources: [{ uri: 'github://owner/repo/skills/refunds/SKILL.md', digest, size: 1 }]
        };
        const { mcp } = served({
            baseUri: 'github://owner/repo/skills',
            source: sourceOf({
                list: async () => ({ skills: [github] }),
                read: async uri => (uri === github.uri ? { text: 'x' } : undefined)
            })
        });
        const { resourceTemplates } = await resultOf(mcp, 'resources/templates/list');
        expect(resourceTemplates).toEqual([expect.objectContaining({ uriTemplate: 'github://owner/repo/skills/{+path}' })]);
        const { contents } = await resultOf(mcp, 'resources/read', { uri: github.uri });
        expect(contents).toEqual([{ uri: github.uri, text: 'x' }]);
    });

    it('matches requests however the baseUri spells its host and port', async () => {
        const uri = 'https://example.com/skills/refunds/SKILL.md';
        const listed = { uri, name: 'refunds' };
        const { mcp, warnings } = served({
            baseUri: 'https://Example.com:443/skills/',
            source: sourceOf({
                read: async requested => (requested === uri ? { text: 'x' } : undefined),
                listResources: async () => [listed]
            })
        });
        expect(await resultOf(mcp, 'resources/templates/list')).toMatchObject({
            resourceTemplates: [{ uriTemplate: 'https://example.com/skills/{+path}' }]
        });
        expect(await resultOf(mcp, 'resources/read', { uri: 'https://EXAMPLE.com:443/skills/refunds/SKILL.md' })).toMatchObject({
            contents: [{ uri, text: 'x' }]
        });
        expect(await resultOf(mcp, 'resources/list')).toMatchObject({ resources: [listed] });
        expect(warnings).toEqual([]);
    });

    it('rejects a baseUri without a scheme, or one that does not parse', () => {
        expect(() => new SkillsExtension({ source: sourceOf(), baseUri: 'skills' })).toThrow(TypeError);
        expect(() => new SkillsExtension({ source: sourceOf(), baseUri: 'https://exa mple.com' })).toThrow(TypeError);
    });
});

describe('setup', () => {
    it('serves many servers from one instance', async () => {
        const extension = new SkillsExtension({ source: sourceOf() });
        const first = newServer(extension);
        const second = newServer(extension);
        expect(await resultOf(first, 'skills/get', { uri: gitWorkflow.uri })).toMatchObject({ skill: gitWorkflow });
        expect(await resultOf(second, 'skills/get', { uri: gitWorkflow.uri })).toMatchObject({ skill: gitWorkflow });
        expect(first.server.getCapabilities().extensions).toEqual({ 'io.modelcontextprotocol/skills': {} });
    });

    it('refuses a second skills extension on one server; each still serves a server of its own', async () => {
        const catalog = await SkillsExtension.load(memorySkillFiles({ 'git-workflow/SKILL.md': GIT_SKILL_MD }));
        const second = new SkillsExtension({ source: sourceOf() });
        expect(() => newServer(catalog, second)).toThrow('Extension "io.modelcontextprotocol/skills" is listed more than once');
        const own = newServer(catalog);
        expect(own.server.getCapabilities().extensions).toEqual({ 'io.modelcontextprotocol/skills': { directoryRead: true } });
        expect(await resultOf(own, 'resources/directory/read', { uri: 'skill://git-workflow' })).toMatchObject({
            resources: [{ name: 'SKILL.md' }]
        });
        expect(newServer(second).server.getCapabilities().extensions).toEqual({ 'io.modelcontextprotocol/skills': {} });
    });

    it('refuses a skills method another extension already serves', () => {
        const claimsList: ServerExtension = {
            id: 'com.example/list',
            setup: ctx => ctx.setRequestHandler('skills/list', { params: ListSkillsRequestParamsSchema }, () => ({ skills: [] }))
        };
        expect(() => newServer(claimsList, new SkillsExtension({ source: sourceOf() }))).toThrow(
            'Extension "io.modelcontextprotocol/skills" cannot register "skills/list": another handler already serves it'
        );
    });

    it('refuses resources/directory/read another extension serves only when the source reads directories', () => {
        const claimsDirectories: ServerExtension = {
            id: 'com.example/directories',
            setup: ctx =>
                ctx.setRequestHandler('resources/directory/read', { params: ReadResourceDirectoryRequestParamsSchema }, () => ({
                    resources: []
                }))
        };
        const withDirectories = new SkillsExtension({ source: sourceOf({ readDirectory: async () => ({ resources: [] }) }) });
        expect(() => newServer(claimsDirectories, withDirectories)).toThrow(/cannot register "resources\/directory\/read"/);
        // Without readDirectory, Skills never registers the method, so the two coexist.
        const mcp = newServer(claimsDirectories, new SkillsExtension({ source: sourceOf() }));
        expect(mcp.server.getCapabilities().extensions).toEqual({ 'com.example/directories': {}, 'io.modelcontextprotocol/skills': {} });
    });

    it('fails when the template name is already taken', () => {
        const takesName: ServerExtension = {
            id: 'com.example/app',
            setup: ctx =>
                void ctx.mcp.registerResource(
                    'io.modelcontextprotocol/skills',
                    new ResourceTemplate('app://{+path}', { list: undefined }),
                    {},
                    async uri => ({
                        contents: [{ uri: uri.href, text: 'app' }]
                    })
                )
        };
        expect(() => newServer(takesName, new SkillsExtension({ source: sourceOf() }))).toThrow(/already registered/);
    });

    it('has no setup hook a subclass can override', () => {
        let calls = 0;
        class Hooked extends SkillsExtension {
            afterSetup(): void {
                calls++;
            }
        }
        newServer(new Hooked({ source: sourceOf() }));
        expect(calls).toBe(0);
        expect('afterSetup' in SkillsExtension.prototype).toBe(false);
    });

    it('still serves through the deprecated attach, with its rules', async () => {
        const mcp = newServer();
        const skills = new SkillsExtension({ source: sourceOf() });
        skills.attach(mcp);
        skills.attach(mcp);
        expect(mcp.server.getCapabilities().extensions).toEqual({ 'io.modelcontextprotocol/skills': {} });
        expect(await resultOf(mcp, 'skills/list')).toMatchObject({ skills: [gitWorkflow] });
        expect(() => new SkillsExtension({ source: sourceOf() }).attach(mcp)).toThrow(/another skills extension is already attached/);
        expect(() => new SkillsExtension({ source: sourceOf() }).attach(newServer(new SkillsExtension({ source: sourceOf() })))).toThrow(
            /another skills extension is already attached/
        );
        const connected = newServer();
        const [, serverSide] = InMemoryTransport.createLinkedPair();
        await connected.connect(serverSide);
        expect(() => new SkillsExtension({ source: sourceOf() }).attach(connected)).toThrow(/before connecting/);
        await connected.close();
    });

    it('leaves no capability when attach fails on a taken template name', () => {
        const mcp = newServer();
        mcp.registerResource(
            'io.modelcontextprotocol/skills',
            new ResourceTemplate('app://{+path}', { list: undefined }),
            {},
            async uri => ({
                contents: [{ uri: uri.href, text: 'app' }]
            })
        );
        expect(() => new SkillsExtension({ source: sourceOf() }).attach(mcp)).toThrow(/already registered/);
        expect(mcp.server.getCapabilities().extensions?.['io.modelcontextprotocol/skills']).toBeUndefined();
    });

    it('rejects an invalid cacheHint at construction', () => {
        expect(() => new SkillsExtension({ source: sourceOf(), cacheHint: { ttlMs: -1 } })).toThrow();
    });
});

describe('skillEntry', () => {
    it('builds a valid entry from files with real digests', async () => {
        const skillMd = `---
name: refunds
description: Refund workflow.
---
# Refunds
`;
        const skill = await skillEntry('acme/refunds', { 'SKILL.md': skillMd, 'references/policy.md': '# Policy\n' });
        expect(skill.uri).toBe('skill://acme/refunds/SKILL.md');
        expect(skill.resources).toContainEqual({
            uri: 'skill://acme/refunds/SKILL.md',
            digest: `sha256:${createHash('sha256').update(skillMd).digest('hex')}`,
            size: Buffer.byteLength(skillMd)
        });
    });

    it('throws SkillCatalogError for an invalid skill and TypeError for an escaping path', async () => {
        await expect(
            skillEntry('acme/refunds', {
                'SKILL.md': `---
name: other
description: d
---
`
            })
        ).rejects.toBeInstanceOf(SkillCatalogError);
        await expect(skillEntry('acme/../x', { 'SKILL.md': '' })).rejects.toBeInstanceOf(TypeError);
    });
});
