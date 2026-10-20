/**
 * Skills over MCP end to end, through public import paths only: a folder on
 * disk served by `loadSkills`, read and verified by `SkillsClient`, over HTTP
 * (`createMcpHandler`, one server per request) and stdio (a child process), on
 * both protocol versions.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { SkillCatalog } from '@modelcontextprotocol/server/ext/skills';
import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ESCALATION, GIT, PURCHASE_ORDER, REFUNDS, writeSkillTree } from './skillTree';

const LEGACY = '2025-11-25';
const MODERN = '2026-07-28';
const FIXTURES_DIR = path.resolve(__dirname, '../__fixtures__');

function clientFor(revision: string): Client {
    return new Client(
        { name: 'skills-host', version: '1.0.0' },
        revision === MODERN ? { versionNegotiation: { mode: { pin: MODERN } } } : {}
    );
}

async function overHttp(catalog: SkillCatalog, revision: string, onServer: () => void = () => {}): Promise<Client> {
    const handler = createMcpHandler(() => {
        onServer();
        const mcp = new McpServer({ name: 'skills-http', version: '1.0.0' });
        catalog.attach(mcp);
        return mcp;
    });
    const client = clientFor(revision);
    await client.connect(
        new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) })
    );
    return client;
}

async function overStdio(root: string, revision: string): Promise<Client> {
    const client = clientFor(revision);
    await client.connect(
        new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'skillsStdioServer.ts', root], cwd: FIXTURES_DIR })
    );
    return client;
}

let root: string;
let catalog: SkillCatalog;

beforeAll(async () => {
    root = await writeSkillTree();
    catalog = await loadSkills(root);
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

describe.each([
    ['http', LEGACY],
    ['http', MODERN],
    ['stdio', LEGACY],
    ['stdio', MODERN]
])('skills over %s on %s', (transport, revision) => {
    let client: Client;
    let skills: SkillsClient;

    beforeAll(async () => {
        client = transport === 'http' ? await overHttp(catalog, revision) : await overStdio(root, revision);
        skills = new SkillsClient(client);
    }, 30_000);

    afterAll(async () => {
        await client.close();
    });

    it('declares the extension with directoryRead', () => {
        expect(skills.supported).toBe(true);
        expect(skills.directoryRead).toBe(true);
    });

    it('lists every skill, and every file of every skill verifies', async () => {
        const { skills: entries, invalid } = await skills.list();
        expect(invalid).toEqual([]);
        expect(entries.map(entry => entry.uri)).toEqual([REFUNDS, ESCALATION, GIT]);
        for (const entry of entries) {
            const manifest = await skills.read(entry);
            expect(manifest).toMatchObject({ verified: true, frontmatter: entry.frontmatter });
            for (const resource of entry.resources === 'dynamic' ? [] : entry.resources) {
                expect(await skills.read(entry, resource.uri)).toMatchObject({ uri: resource.uri, verified: true });
            }
        }
    });

    it('keeps a Windows-authored SKILL.md byte for byte', async () => {
        const { skill: refunds } = await skills.get(REFUNDS);
        const manifest = await skills.read(refunds);
        expect(manifest.text?.startsWith('﻿---\r\n')).toBe(true);
        expect(manifest.frontmatter).toEqual({ name: 'refunds', description: 'Refund workflow.' });
    });

    it('gets a skill and reads files by relative path, including names with a space', async () => {
        const { skill: git } = await skills.get(GIT);
        expect(await skills.read(git, 'references/REVIEW.md')).toMatchObject({ text: '# Review\n\n- tests pass\n', verified: true });
        const { skill: refunds } = await skills.get(REFUNDS);
        expect(await skills.read(refunds, 'templates/Purchase Order.md')).toMatchObject({ uri: PURCHASE_ORDER, verified: true });
    });

    it('reads a skill directory', async () => {
        const { resources: children } = await skills.readDirectory('skill://acme/billing/refunds');
        expect(children.map(child => child.name)).toEqual(['SKILL.md', 'assets', 'escalation', 'templates']);
    });

    it('returns caching fields from list, get and readDirectory on 2026-07-28 only', async () => {
        const results = [await skills.list(), await skills.get(GIT), await skills.readDirectory('skill://acme/billing/refunds')];
        for (const result of results) {
            if (revision === MODERN) {
                expect(result).toMatchObject({ ttlMs: 0, cacheScope: 'private' });
            } else {
                expect(result).not.toHaveProperty('ttlMs');
                expect(result).not.toHaveProperty('cacheScope');
            }
        }
    });

    it('lists only SKILL.md files in resources/list', async () => {
        const { resources } = await client.listResources();
        expect(resources.map(resource => resource.uri)).toEqual([REFUNDS, ESCALATION, GIT]);
    });
});

describe('one catalog behind per-request HTTP servers', () => {
    it('serves every request from a fresh server', async () => {
        let servers = 0;
        const client = await overHttp(catalog, MODERN, () => {
            servers++;
        });
        const skills = new SkillsClient(client);
        const { skills: entries } = await skills.list();
        for (const entry of entries) await skills.read(entry);
        expect(servers).toBeGreaterThan(3);
        await client.close();
    });

    it('refuses an edited file until reload(), then serves the new version', async () => {
        const editable = await writeSkillTree();
        const own = await loadSkills(editable, { onWarning: () => {} });
        const client = await overHttp(own, MODERN);
        const skills = new SkillsClient(client);
        const { skill: before } = await skills.get(GIT);
        await writeFile(path.join(editable, 'git-workflow', 'references', 'REVIEW.md'), '# Review v2\n');
        await expect(skills.read(before, 'references/REVIEW.md')).rejects.toMatchObject({ code: -32_603 });
        expect(await own.reload()).toEqual({ added: [], removed: [], changed: [GIT], listChanged: false });
        const { skill: after } = await skills.get(GIT);
        expect(await skills.read(after, 'references/REVIEW.md')).toMatchObject({ text: '# Review v2\n', verified: true });
        await client.close();
        await rm(editable, { recursive: true, force: true });
    });

    it('tells listen streams about a listing change through handler.notify, which reload() alone cannot reach', async () => {
        const editable = await writeSkillTree();
        const own = await loadSkills(editable, { onWarning: () => {} });
        const handler = createMcpHandler(
            () => {
                const mcp = new McpServer({ name: 'skills-http', version: '1.0.0' });
                own.attach(mcp);
                return mcp;
            },
            { keepAliveMs: 0 }
        );
        const client = clientFor(MODERN);
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
                fetch: (url, init) => handler.fetch(new Request(url, init))
            })
        );
        const seen: string[] = [];
        client.setNotificationHandler('notifications/resources/list_changed', () => void seen.push('resources/list_changed'));
        const subscription = await client.listen({ resourcesListChanged: true });
        expect(subscription.honoredFilter).toEqual({ resourcesListChanged: true });

        await mkdir(path.join(editable, 'aaa'));
        await writeFile(
            path.join(editable, 'aaa', 'SKILL.md'),
            `---
name: aaa
description: Sorts first.
---
`
        );
        const changes = await own.reload();
        expect(changes).toMatchObject({ added: ['skill://aaa/SKILL.md'], listChanged: true });
        // Every server this handler built has served its one request and closed: nothing reaches the stream.
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(seen).toEqual([]);

        // What docs/servers/skills.md tells servers behind createMcpHandler to do.
        if (changes.listChanged) handler.notify.resourcesChanged();
        await vi.waitFor(() => expect(seen).toEqual(['resources/list_changed']));

        await subscription.close();
        await client.close();
        await handler.close();
        await rm(editable, { recursive: true, force: true });
    });
});
