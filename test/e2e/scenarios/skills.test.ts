/**
 * Self-contained test bodies for the Skills extension (SEP-2640).
 *
 * Each body builds its own catalog (in memory) or SkillSource, attaches it
 * inside the server factory, wires a real Client and asserts through
 * SkillsClient or raw requests. Bodies that send skills/* or
 * resources/directory/read pass SKILLS_WIRE so the wire sniffer permits them.
 */

import { Client, SdkError, SdkErrorCode, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SkillsClient, SkillVerificationError } from '@modelcontextprotocol/client/ext/skills';
import { createMcpHandler, McpServer, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { Skill, SkillCatalog, SkillCatalogOptions, SkillSource, SkillWarning } from '@modelcontextprotocol/server/ext/skills';
import { memorySkillFiles, SkillCatalogError, skillEntry, SkillsExtension } from '@modelcontextprotocol/server/ext/skills';
import { expect, vi } from 'vitest';
import * as z from 'zod/v4';

import type { Wired } from '../helpers/index';
import { defined, tapWire, wire } from '../helpers/index';
import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

const SKILLS_WIRE = { allowCustomMethods: true } as const;
const EXTENSION = 'io.modelcontextprotocol/skills';

const GIT = 'skill://git-workflow/SKILL.md';
const REVIEW = 'skill://git-workflow/references/REVIEW.md';
const GIT_MD = skillMd('git-workflow', 'Branching and review conventions.', '# Git workflow\n');
const REVIEW_MD = '# Review\n';
const NOTES_MD = skillMd('notes', 'Team notes.', '# Notes\n');
const DIGEST = /^sha256:[\da-f]{64}$/;

const quiet = (): void => {};
const newClient = (): Client => new Client({ name: 'c', version: '0' });

function skillMd(name: string, description: string, body = '# Body\n'): string {
    return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

function catalogOf(files: Record<string, string | Uint8Array>, options?: SkillCatalogOptions): Promise<SkillCatalog> {
    return SkillsExtension.load(memorySkillFiles(files), { onWarning: quiet, ...options });
}

function serving(skills: { attach(mcp: McpServer): void }): () => McpServer {
    return () => {
        const s = new McpServer({ name: 's', version: '0' });
        skills.attach(s);
        return s;
    };
}

function raw(client: Client, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return client.request({ method, ...(params !== undefined && { params }) }, z.looseObject({}));
}

/** The methods of the requests sent so far, read after a macrotask so fire-and-forget sends are counted. */
async function requestMethods(tap: ReturnType<typeof tapWire>): Promise<string[]> {
    await new Promise(resolve => setTimeout(resolve, 0));
    return tap.sent.flatMap(message => ('id' in message && 'method' in message ? [message.method] : []));
}

/** A one-skill SkillSource with no readDirectory and no listResources. */
async function notesSource(): Promise<{ notes: Skill; source: SkillSource }> {
    const notes = await skillEntry('notes', { 'SKILL.md': NOTES_MD });
    const source: SkillSource = {
        list: async () => ({ skills: [notes] }),
        get: async uri => (uri === notes.uri ? notes : undefined),
        read: async uri => (uri === notes.uri ? { text: NOTES_MD, mimeType: 'text/markdown' } : undefined)
    };
    return { notes, source };
}

// ───────────────────────────────────────────────────────────────────────────────
// Discovery
// ───────────────────────────────────────────────────────────────────────────────

verifies('skills:capability:declared', async ({ transport }: TestArgs) => {
    {
        const catalog = await catalogOf({ 'git-workflow/SKILL.md': GIT_MD });
        const client = newClient();
        await using _ = await wire(transport, serving(catalog), client);

        expect(client.getServerCapabilities()?.resources).toBeDefined();
        expect(client.getServerCapabilities()?.extensions).toEqual({ [EXTENSION]: { directoryRead: true } });
        const skills = new SkillsClient(client);
        expect(skills.supported).toBe(true);
        expect(skills.directoryRead).toBe(true);
    }
    {
        const { source } = await notesSource();
        const client = newClient();
        await using _ = await wire(transport, serving(new SkillsExtension({ source, onWarning: quiet })), client);

        expect(client.getServerCapabilities()?.resources).toBeDefined();
        expect(client.getServerCapabilities()?.extensions).toEqual({ [EXTENSION]: {} });
        const skills = new SkillsClient(client);
        expect(skills.supported).toBe(true);
        expect(skills.directoryRead).toBe(false);
    }
});

verifies('skills:client:requires-declaration', async ({ transport }: TestArgs) => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const entry = await skillEntry('notes', { 'SKILL.md': NOTES_MD });
    const client = newClient();
    // No SKILLS_WIRE: the sniffer itself rejects any skills/* request the client might send.
    await using _ = await wire(transport, () => new McpServer({ name: 's', version: '0' }), client);
    const tap = tapWire(client);
    const skills = new SkillsClient(client);

    try {
        expect(skills.supported).toBe(false);
        await expect(skills.list()).resolves.toEqual({ skills: [], invalid: [] });
        const unsupported = { code: SdkErrorCode.CapabilityNotSupported };
        await expect(skills.get(entry.uri)).rejects.toBeInstanceOf(SdkError);
        await expect(skills.get(entry.uri)).rejects.toMatchObject(unsupported);
        await expect(skills.read(entry)).rejects.toMatchObject(unsupported);
        const sent = await requestMethods(tap);
        expect(sent.filter(method => method.startsWith('skills/') || method === 'resources/read')).toEqual([]);
    } finally {
        debug.mockRestore();
    }
});

verifies('skills:resources:skill-md-listed', async ({ transport }: TestArgs) => {
    const catalog = await catalogOf({ 'git-workflow/SKILL.md': GIT_MD, 'git-workflow/references/REVIEW.md': REVIEW_MD });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client);

    const { resources } = await client.listResources();

    expect(resources).toEqual([
        { uri: GIT, name: 'git-workflow', description: 'Branching and review conventions.', mimeType: 'text/markdown', size: GIT_MD.length }
    ]);
});

verifies('typescript:skills:resources:template', async ({ transport }: TestArgs) => {
    const catalog = await catalogOf({ 'git-workflow/SKILL.md': GIT_MD });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client);

    const { resourceTemplates } = await raw(client, 'resources/templates/list');

    expect(resourceTemplates).toEqual([{ name: EXTENSION, uriTemplate: 'skill://{+path}' }]);
});

verifies('typescript:skills:resources:app-resource-first', async ({ transport }: TestArgs) => {
    const catalog = await catalogOf({ 'git-workflow/SKILL.md': GIT_MD, 'git-workflow/references/REVIEW.md': REVIEW_MD });
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerResource('override', REVIEW, { mimeType: 'text/plain' }, () => ({ contents: [{ uri: REVIEW, text: 'app wins' }] }));
        catalog.attach(s);
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const { contents } = await client.readResource({ uri: REVIEW });
    expect(contents).toEqual([{ uri: REVIEW, text: 'app wins' }]);

    const { resources } = await client.listResources();
    expect(resources.map(resource => resource.uri)).toEqual([REVIEW, GIT]);
});

// ───────────────────────────────────────────────────────────────────────────────
// Listing
// ───────────────────────────────────────────────────────────────────────────────

verifies(
    'skills:list:entries',
    async ({ transport }: TestArgs) => {
        const skillText = '---\nname: refunds\ndescription: Refund workflow.\nlicense: MIT\nmetadata:\n  team: billing\n---\n# Refunds\n';
        const catalog = await catalogOf({ 'refunds/SKILL.md': skillText, 'refunds/templates/form.md': '# Form\n' });
        const client = newClient();
        await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);

        const { skills } = await new SkillsClient(client).list();

        expect(skills).toHaveLength(1);
        expect(skills[0]?.uri).toBe('skill://refunds/SKILL.md');
        expect(skills[0]?.frontmatter).toEqual({
            name: 'refunds',
            description: 'Refund workflow.',
            license: 'MIT',
            metadata: { team: 'billing' }
        });
        expect(skills[0]?.resources).toHaveLength(2);
        expect(skills[0]?.resources).toEqual(
            expect.arrayContaining([
                { uri: 'skill://refunds/SKILL.md', digest: expect.stringMatching(DIGEST), size: skillText.length },
                { uri: 'skill://refunds/templates/form.md', digest: expect.stringMatching(DIGEST), size: '# Form\n'.length }
            ])
        );
    },
    { title: 'entries' }
);

verifies(
    'skills:list:entries',
    async ({ transport }: TestArgs) => {
        const catalog = await catalogOf({});
        const client = newClient();
        await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);
        const skills = new SkillsClient(client);

        expect(skills.supported).toBe(true);
        await expect(skills.list()).resolves.toMatchObject({ skills: [] });
        await expect(skills.get('skill://x/SKILL.md')).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
    },
    { title: 'empty catalog' }
);

verifies('skills:list:pagination', async ({ transport }: TestArgs) => {
    const catalog = await catalogOf(
        {
            // Two files per skill, so an entry split across pages would show up as a partial or repeated entry.
            'alpha/SKILL.md': skillMd('alpha', 'First.'),
            'alpha/a.md': '# a\n',
            'bravo/SKILL.md': skillMd('bravo', 'Second.'),
            'bravo/b.md': '# b\n',
            'charlie/SKILL.md': skillMd('charlie', 'Third.'),
            'charlie/c.md': '# c\n'
        },
        { pageSize: 1 }
    );
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);
    const skills = new SkillsClient(client);

    const all = await skills.list();
    expect(all.skills.map(entry => entry.uri)).toEqual(['skill://alpha/SKILL.md', 'skill://bravo/SKILL.md', 'skill://charlie/SKILL.md']);
    expect(all).not.toHaveProperty('nextCursor');

    const first = await raw(client, 'skills/list');
    expect(first.skills).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await skills.list({ cursor: first.nextCursor as string });
    expect(second.skills.map(entry => entry.uri)).toEqual(['skill://bravo/SKILL.md']);
    expect(second.nextCursor).toEqual(expect.any(String));

    // An entry is never split across pages: each listed entry is the whole skill.
    for (const entry of all.skills) {
        const { skill } = await skills.get(entry.uri);
        expect(skill).toEqual(entry);
    }
});

verifies('skills:list:invalid-cursor', async ({ transport }: TestArgs) => {
    const catalog = await catalogOf({ 'git-workflow/SKILL.md': GIT_MD });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);

    await expect(new SkillsClient(client).list({ cursor: 'garbage' })).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
});

verifies('skills:list:nested', async ({ transport }: TestArgs) => {
    const catalog = await catalogOf({
        'outer/SKILL.md': skillMd('outer', 'Outer.'),
        'outer/inner/SKILL.md': skillMd('inner', 'Inner.'),
        'outer/inner/notes.md': '# Notes\n'
    });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);

    const { skills } = await new SkillsClient(client).list();

    expect(skills.map(entry => entry.uri).toSorted()).toEqual(['skill://outer/SKILL.md', 'skill://outer/inner/SKILL.md'].toSorted());
    const outer = skills.find(entry => entry.uri === 'skill://outer/SKILL.md');
    const outerFiles = outer?.resources === 'dynamic' ? [] : (outer?.resources ?? []).map(resource => resource.uri);
    expect(outerFiles).toEqual(expect.arrayContaining(['skill://outer/inner/SKILL.md', 'skill://outer/inner/notes.md']));
});

verifies('typescript:skills:catalog:limits', async ({ transport }: TestArgs) => {
    const files = { 'big/SKILL.md': skillMd('big', 'Too many files.'), 'big/a.md': 'a', 'big/b.md': 'b' };
    const warnings: SkillWarning[] = [];
    const catalog = await catalogOf(files, { limits: { files: 2 }, onWarning: warning => void warnings.push(warning) });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);

    const { skills } = await new SkillsClient(client).list();

    expect(skills.map(entry => entry.uri)).toEqual(['skill://big/SKILL.md']);
    expect(warnings).toEqual([
        expect.objectContaining({ path: expect.stringContaining('big'), message: expect.stringContaining('exceeds the limit') })
    ]);
    await expect(catalogOf(files, { limits: { files: 2 }, strict: true })).rejects.toBeInstanceOf(SkillCatalogError);
});

// ───────────────────────────────────────────────────────────────────────────────
// Get
// ───────────────────────────────────────────────────────────────────────────────

verifies('skills:get:entry', async ({ transport }: TestArgs) => {
    const catalog = await catalogOf({ 'git-workflow/SKILL.md': GIT_MD, 'git-workflow/references/REVIEW.md': REVIEW_MD });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);
    const skills = new SkillsClient(client);

    const { skill } = await skills.get(GIT);
    const { skills: listed } = await skills.list();

    expect(skill).toEqual(listed[0]);
});

verifies('skills:get:unlisted', async ({ transport }: TestArgs) => {
    const { notes, source } = await notesSource();
    const unlisted: SkillSource = { ...source, list: async () => ({ skills: [] }) };
    const client = newClient();
    await using _ = await wire(transport, serving(new SkillsExtension({ source: unlisted, onWarning: quiet })), client, SKILLS_WIRE);
    const skills = new SkillsClient(client);

    await expect(skills.list()).resolves.toMatchObject({ skills: [] });
    const { skill } = await skills.get(notes.uri);
    await expect(skills.read(skill)).resolves.toMatchObject({ verified: true, frontmatter: { name: 'notes' } });
});

verifies('skills:get:unknown', async ({ transport }: TestArgs) => {
    const catalog = await catalogOf({ 'git-workflow/SKILL.md': GIT_MD });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);

    await expect(new SkillsClient(client).get('skill://nope/SKILL.md')).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message: expect.stringContaining('skill://nope/SKILL.md')
    });
});

verifies('skills:errors:internal', async ({ transport }: TestArgs) => {
    const { notes, source } = await notesSource();
    const other = await skillEntry('other', { 'SKILL.md': skillMd('other', 'Another skill.') });
    // Raw requests: SkillsClient.get would also refuse these answers on the client side.
    const answers: Array<[SkillSource['get'], string]> = [
        [async () => other, `the skill source returned ${other.uri}`],
        [async () => ({ ...notes, frontmatter: { name: 'renamed', description: 'x' } }), 'invalid skill entry from the source']
    ];
    for (const [get, message] of answers) {
        const client = newClient();
        await using _ = await wire(
            transport,
            serving(new SkillsExtension({ source: { ...source, get }, onWarning: quiet })),
            client,
            SKILLS_WIRE
        );

        await expect(raw(client, 'skills/get', { uri: notes.uri })).rejects.toMatchObject({
            code: ProtocolErrorCode.InternalError,
            message: expect.stringContaining(message)
        });
    }
});

// ───────────────────────────────────────────────────────────────────────────────
// Reading
// ───────────────────────────────────────────────────────────────────────────────

verifies('skills:read:relative', async ({ transport }: TestArgs) => {
    const refundsMd = skillMd('refunds', 'Refund workflow.', '# Refunds\n');
    const catalog = await catalogOf({
        'acme/billing/refunds/SKILL.md': refundsMd,
        'acme/billing/refunds/templates/Purchase Order.md': '# PO\n',
        'acme/billing/refunds/references/Über.md': '# Über\n',
        'acme/billing/refunds/references/REVIEW.md': REVIEW_MD
    });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);
    const skills = new SkillsClient(client);
    const { skill: refunds } = await skills.get('skill://acme/billing/refunds/SKILL.md');

    await expect(skills.read(refunds)).resolves.toMatchObject({
        verified: true,
        frontmatter: { name: 'refunds', description: 'Refund workflow.' },
        body: '# Refunds\n'
    });
    await expect(skills.read(refunds, 'templates/Purchase Order.md')).resolves.toMatchObject({
        uri: 'skill://acme/billing/refunds/templates/Purchase%20Order.md',
        text: '# PO\n',
        verified: true
    });
    await expect(skills.read(refunds, 'references/Über.md')).resolves.toMatchObject({ text: '# Über\n', verified: true });

    const plain = await skills.read(refunds, 'references/REVIEW.md');
    const dotted = await skills.read(refunds, './references/REVIEW.md#top');
    expect(dotted).toMatchObject({ uri: plain.uri, text: REVIEW_MD, verified: true });
});

verifies('skills:read:binary', async ({ transport }: TestArgs) => {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
    const catalog = await catalogOf({ 'pics/SKILL.md': skillMd('pics', 'Pictures.'), 'pics/logo.png': png });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);
    const skills = new SkillsClient(client);
    const { skill: pics } = await skills.get('skill://pics/SKILL.md');

    const file = await skills.read(pics, 'logo.png');

    expect(file).toMatchObject({ verified: true, mimeType: 'image/png' });
    expect([...file.bytes]).toEqual([...png]);
    const { contents } = await client.readResource({ uri: 'skill://pics/logo.png' });
    expect(contents).toEqual([{ uri: 'skill://pics/logo.png', mimeType: 'image/png', blob: expect.any(String) }]);
});

verifies('skills:read:unknown-file', async ({ transport }: TestArgs) => {
    const catalog = await catalogOf({ 'git-workflow/SKILL.md': GIT_MD });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client);

    await expect(client.readResource({ uri: 'skill://nope/x.md' })).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
});

verifies('skills:read:directory-uri', async ({ transport }: TestArgs) => {
    const catalog = await catalogOf({ 'git-workflow/SKILL.md': GIT_MD, 'git-workflow/references/REVIEW.md': REVIEW_MD });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client);

    await expect(client.readResource({ uri: 'skill://git-workflow' })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message: expect.stringMatching(/is a directory/)
    });
});

// ───────────────────────────────────────────────────────────────────────────────
// Verification and lazy retrieval
// ───────────────────────────────────────────────────────────────────────────────

/** Serves `entry` as listed and whatever `serve` returns for each file, true to the entry or not. */
function lyingSource(entry: Skill, serve: (uri: string) => string | undefined): SkillSource {
    return {
        list: async () => ({ skills: [entry] }),
        get: async uri => (uri === entry.uri ? entry : undefined),
        read: async uri => {
            const text = serve(uri);
            return text === undefined ? undefined : { text };
        }
    };
}

verifies('skills:verify:size', async ({ transport }: TestArgs) => {
    const notes = await skillEntry('notes', { 'SKILL.md': NOTES_MD, 'a.md': 'aaaa' });
    const source = lyingSource(notes, uri => (uri.endsWith('/a.md') ? 'aaaaa' : NOTES_MD));
    const client = newClient();
    await using _ = await wire(transport, serving(new SkillsExtension({ source, onWarning: quiet })), client);

    const read = new SkillsClient(client).read(notes, 'a.md');

    await expect(read).rejects.toBeInstanceOf(SkillVerificationError);
    await expect(read).rejects.toMatchObject({ reason: 'size' });
});

verifies('skills:verify:digest', async ({ transport }: TestArgs) => {
    const notes = await skillEntry('notes', { 'SKILL.md': NOTES_MD, 'a.md': 'aaaa' });
    const source = lyingSource(notes, uri => (uri.endsWith('/a.md') ? 'bbbb' : NOTES_MD));
    const client = newClient();
    await using _ = await wire(transport, serving(new SkillsExtension({ source, onWarning: quiet })), client);

    const read = new SkillsClient(client).read(notes, 'a.md');

    await expect(read).rejects.toBeInstanceOf(SkillVerificationError);
    await expect(read).rejects.toMatchObject({ reason: 'digest' });
});

verifies('skills:verify:frontmatter', async ({ transport }: TestArgs) => {
    const notes = await skillEntry('notes', { 'SKILL.md': NOTES_MD });
    // The SKILL.md bytes match the entry's digest; only the entry's frontmatter differs.
    const listed: Skill = { ...notes, frontmatter: { ...notes.frontmatter, description: 'Something else.' } };
    const source = lyingSource(listed, () => NOTES_MD);
    const client = newClient();
    await using _ = await wire(transport, serving(new SkillsExtension({ source, onWarning: quiet })), client);

    const read = new SkillsClient(client).read(listed);

    await expect(read).rejects.toBeInstanceOf(SkillVerificationError);
    await expect(read).rejects.toMatchObject({ reason: 'frontmatter', differences: [expect.stringContaining('description')] });
});

verifies('skills:verify:unlisted', async ({ transport }: TestArgs) => {
    // Under a prefix, so `../notes/SKILL.md` resolves to the sibling skill's real file (at the authority, `..` stays put).
    const catalog = await catalogOf({ 'team/git-workflow/SKILL.md': GIT_MD, 'team/notes/SKILL.md': NOTES_MD });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);
    const skills = new SkillsClient(client);
    const { skill: git } = await skills.get('skill://team/git-workflow/SKILL.md');
    const tap = tapWire(client);

    for (const ref of ['missing.md', '../notes/SKILL.md', 'skill://team/notes/SKILL.md']) {
        const read = skills.read(git, ref);
        await expect(read).rejects.toBeInstanceOf(SkillVerificationError);
        await expect(read).rejects.toMatchObject({ reason: 'unlisted' });
    }
    expect(await requestMethods(tap)).not.toContain('resources/read');
});

verifies('skills:verify:directory-ahead-of-entry', async ({ transport }: TestArgs) => {
    const files: Record<string, string> = { 'git-workflow/SKILL.md': GIT_MD, 'git-workflow/references/REVIEW.md': REVIEW_MD };
    const catalog = await catalogOf(files);
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);
    const skills = new SkillsClient(client);
    const { skill: before } = await skills.get(GIT);

    files['git-workflow/references/NEW.md'] = '# New\n';
    await catalog.reload();

    const { resources } = await skills.readDirectory('skill://git-workflow/references');
    expect(resources.map(resource => resource.name)).toContain('NEW.md');
    const stale = skills.read(before, 'references/NEW.md');
    await expect(stale).rejects.toBeInstanceOf(SkillVerificationError);
    await expect(stale).rejects.toMatchObject({ reason: 'unlisted' });

    const { skill: after } = await skills.get(GIT);
    await expect(skills.read(after, 'references/NEW.md')).resolves.toMatchObject({ verified: true, text: '# New\n' });
});

verifies('skills:verify:dynamic', async ({ transport }: TestArgs) => {
    const live: Skill = {
        uri: 'skill://team/live/SKILL.md',
        frontmatter: { name: 'live', description: 'Generated.' },
        resources: 'dynamic'
    };
    const texts: Record<string, string> = {
        'skill://team/live/SKILL.md': skillMd('live', 'Generated.'),
        'skill://team/live/data/today.md': '# Today\n',
        'skill://team/other/SKILL.md': skillMd('other', 'Outside the dynamic skill.')
    };
    const client = newClient();
    await using _ = await wire(
        transport,
        serving(new SkillsExtension({ source: lyingSource(live, uri => texts[uri]), onWarning: quiet })),
        client
    );
    const skills = new SkillsClient(client);

    await expect(skills.read(live)).resolves.toMatchObject({ verified: false, frontmatter: { name: 'live', description: 'Generated.' } });
    await expect(skills.read(live, 'data/today.md')).resolves.toMatchObject({ verified: false, text: '# Today\n' });

    const read = skills.read({ ...live, frontmatter: { name: 'live', description: 'Other.' } });
    await expect(read).rejects.toBeInstanceOf(SkillVerificationError);
    await expect(read).rejects.toMatchObject({ reason: 'frontmatter' });

    // With no listing to check, the skill root is the only bound: a ref that climbs out is refused before any request.
    const tap = tapWire(client);
    const outside = skills.read(live, '../other/SKILL.md');
    await expect(outside).rejects.toBeInstanceOf(SkillVerificationError);
    await expect(outside).rejects.toMatchObject({ reason: 'unlisted' });
    expect(await requestMethods(tap)).not.toContain('resources/read');
});

verifies('skills:host:lazy', async ({ transport }: TestArgs) => {
    const catalog = await catalogOf({ 'git-workflow/SKILL.md': GIT_MD, 'git-workflow/references/REVIEW.md': REVIEW_MD });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);
    const skills = new SkillsClient(client);
    const tap = tapWire(client);

    await skills.list();
    await skills.get(GIT);

    const methods = await requestMethods(tap);
    expect(methods).toEqual(expect.arrayContaining(['skills/list', 'skills/get']));
    expect(methods).not.toContain('resources/read');
});

// ───────────────────────────────────────────────────────────────────────────────
// Directories
// ───────────────────────────────────────────────────────────────────────────────

const REFUNDS_MD = skillMd('refunds', 'Refund workflow.');

verifies('skills:directory:children', async ({ transport }: TestArgs) => {
    const catalog = await catalogOf({
        'refunds/SKILL.md': REFUNDS_MD,
        'refunds/templates/a.md': '# A\n',
        'refunds/assets/logo.png': Uint8Array.from([137, 80, 78, 71])
    });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);

    const { resources } = await new SkillsClient(client).readDirectory('skill://refunds');

    expect(resources.map(resource => resource.name)).toEqual(['SKILL.md', 'assets', 'templates']);
    expect(resources.find(resource => resource.name === 'SKILL.md')).toMatchObject({
        uri: 'skill://refunds/SKILL.md',
        mimeType: 'text/markdown',
        size: REFUNDS_MD.length
    });
    for (const name of ['assets', 'templates']) {
        expect(resources.find(resource => resource.name === name)).toMatchObject({
            uri: `skill://refunds/${name}`,
            mimeType: 'inode/directory'
        });
    }
});

verifies('skills:directory:pagination', async ({ transport }: TestArgs) => {
    const catalog = await catalogOf(
        {
            'refunds/SKILL.md': REFUNDS_MD,
            'refunds/templates/a.md': '# A\n',
            'refunds/templates/b.md': '# B\n',
            'refunds/templates/c.md': '# C\n'
        },
        { pageSize: 1 }
    );
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);

    const { resources } = await new SkillsClient(client).readDirectory('skill://refunds/templates');
    expect(resources.map(resource => resource.name)).toEqual(['a.md', 'b.md', 'c.md']);

    const page = await raw(client, 'resources/directory/read', { uri: 'skill://refunds/templates' });
    expect(page.resources).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
});

verifies('skills:directory:not-a-directory', async ({ transport }: TestArgs) => {
    const catalog = await catalogOf({ 'refunds/SKILL.md': REFUNDS_MD });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);
    const skills = new SkillsClient(client);

    await expect(skills.readDirectory('skill://refunds/SKILL.md')).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
    await expect(skills.readDirectory('skill://nope')).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
});

verifies('skills:directory:client-gated', async ({ transport }: TestArgs) => {
    const { source } = await notesSource();
    const client = newClient();
    await using _ = await wire(transport, serving(new SkillsExtension({ source, onWarning: quiet })), client, SKILLS_WIRE);
    const tap = tapWire(client);

    const read = new SkillsClient(client).readDirectory('skill://notes');

    await expect(read).rejects.toBeInstanceOf(SdkError);
    await expect(read).rejects.toMatchObject({ code: SdkErrorCode.CapabilityNotSupported });
    expect(await requestMethods(tap)).not.toContain('resources/directory/read');
});

verifies('skills:directory:undeclared', async ({ transport }: TestArgs) => {
    const { source } = await notesSource();
    const client = newClient();
    await using _ = await wire(transport, serving(new SkillsExtension({ source, onWarning: quiet })), client, SKILLS_WIRE);

    await expect(raw(client, 'resources/directory/read', { uri: 'skill://notes' })).rejects.toMatchObject({
        code: ProtocolErrorCode.MethodNotFound
    });
});

// ───────────────────────────────────────────────────────────────────────────────
// Version-specific (cache fields, resultType, the client response cache)
// ───────────────────────────────────────────────────────────────────────────────

const GIT_FILES = { 'git-workflow/SKILL.md': GIT_MD, 'git-workflow/references/REVIEW.md': REVIEW_MD };

/** Parses a captured response body (plain JSON or SSE-framed) into its JSON-RPC messages. */
function jsonRpcMessagesFrom(text: string): Array<Record<string, unknown>> {
    if (text.trim() === '') return [];
    if (text.includes('data: ')) {
        return text
            .split('\n')
            .filter(line => line.startsWith('data: '))
            .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
    }
    const parsed = JSON.parse(text) as Record<string, unknown> | Array<Record<string, unknown>>;
    return Array.isArray(parsed) ? parsed : [parsed];
}

/** The wire result of the first recorded HTTP exchange that carried a `method` request. */
async function wireResultOf(wired: Wired, method: string): Promise<Record<string, unknown>> {
    for (const exchange of wired.httpLog ?? []) {
        if (exchange.requestBody === undefined || (JSON.parse(exchange.requestBody) as { method?: unknown }).method !== method) continue;
        for (const message of jsonRpcMessagesFrom(await exchange.response.text())) {
            const result = message.result as Record<string, unknown> | undefined;
            if (result) return result;
        }
    }
    throw new Error(`no ${method} result in the HTTP log`);
}

verifies('typescript:skills:cache-fields:absent', async ({ transport }: TestArgs) => {
    // A configured hint, so a 2026 stamp leaking onto the 2025 wire would show.
    const catalog = await catalogOf(GIT_FILES, { cacheHint: { ttlMs: 60_000, cacheScope: 'public' } });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);
    const skills = new SkillsClient(client);
    const tap = tapWire(client);

    const results = [await skills.list(), await skills.get(GIT), await skills.readDirectory('skill://git-workflow')];
    const onTheWire = tap.received.flatMap(message => ('result' in message ? [message.result] : []));

    expect(onTheWire).toHaveLength(3);
    for (const result of [...results, ...onTheWire]) {
        expect(result).not.toHaveProperty('ttlMs');
        expect(result).not.toHaveProperty('cacheScope');
    }
});

verifies('skills:cache-fields:present', async ({ transport }: TestArgs) => {
    const hints = [
        [undefined, { ttlMs: 0, cacheScope: 'private' }],
        [
            { ttlMs: 60_000, cacheScope: 'public' },
            { ttlMs: 60_000, cacheScope: 'public' }
        ]
    ] as const;
    for (const [cacheHint, expected] of hints) {
        const catalog = await catalogOf(GIT_FILES, cacheHint === undefined ? {} : { cacheHint });
        const client = newClient();
        await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);
        const skills = new SkillsClient(client);

        const results = [await skills.list(), await skills.get(GIT), await skills.readDirectory('skill://git-workflow')];

        for (const result of results) expect(result).toMatchObject(expected);
    }
});

verifies('skills:cache-fields:client-rejects-missing', async ({ transport }: TestArgs) => {
    const notes = await skillEntry('notes', { 'SKILL.md': NOTES_MD });
    // Hand-registered handlers: the entry stamps cache fields only on the base protocol's cacheable methods.
    const handlersReturning = (cacheFields: Record<string, unknown>) => () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.server.registerCapabilities({ resources: {}, extensions: { [EXTENSION]: { directoryRead: true } } });
        s.server.setRequestHandler('skills/list', { params: z.looseObject({}) }, () => ({ skills: [], ...cacheFields }));
        s.server.setRequestHandler('skills/get', { params: z.looseObject({}) }, () => ({ skill: notes, ...cacheFields }));
        s.server.setRequestHandler('resources/directory/read', { params: z.looseObject({}) }, () => ({ resources: [], ...cacheFields }));
        return s;
    };
    {
        // Control: the same results with the fields are accepted, so the rejections below are about the fields alone.
        const client = newClient();
        await using _ = await wire(transport, handlersReturning({ ttlMs: 0, cacheScope: 'private' }), client, SKILLS_WIRE);
        const skills = new SkillsClient(client);

        await expect(skills.list()).resolves.toMatchObject({ skills: [] });
        await expect(skills.get(notes.uri)).resolves.toMatchObject({ skill: notes });
        await expect(skills.readDirectory('skill://notes')).resolves.toMatchObject({ resources: [] });
    }
    // Both fields are REQUIRED: a result missing either one is refused, as is one missing both.
    for (const cacheFields of [{}, { ttlMs: 0 }, { cacheScope: 'private' }]) {
        const client = newClient();
        await using _ = await wire(transport, handlersReturning(cacheFields), client, SKILLS_WIRE);
        const skills = new SkillsClient(client);
        const invalid = { code: SdkErrorCode.InvalidResult };

        await expect(skills.list()).rejects.toMatchObject(invalid);
        await expect(new SkillsClient(client, { skipInvalid: true }).list()).rejects.toMatchObject(invalid);
        await expect(skills.get(notes.uri)).rejects.toMatchObject(invalid);
        await expect(skills.readDirectory('skill://notes')).rejects.toBeInstanceOf(SdkError);
        await expect(skills.readDirectory('skill://notes')).rejects.toMatchObject(invalid);
    }
});

verifies('skills:result-type', async ({ transport }: TestArgs) => {
    const catalog = await catalogOf(GIT_FILES);
    const client = newClient();
    await using wired = await wire(transport, serving(catalog), client, SKILLS_WIRE);
    const skills = new SkillsClient(client);

    await skills.list();
    await skills.get(GIT);
    await skills.readDirectory('skill://git-workflow');

    for (const method of ['skills/list', 'skills/get', 'resources/directory/read']) {
        expect(await wireResultOf(wired, method)).toMatchObject({ resultType: 'complete' });
    }
});

verifies('skills:host:cache-refetch', async ({ transport }: TestArgs) => {
    const files: Record<string, string> = { ...GIT_FILES };
    const catalog = await catalogOf(files, { cacheHint: { ttlMs: 60_000, cacheScope: 'private' } });
    const client = newClient();
    await using _ = await wire(transport, serving(catalog), client, SKILLS_WIRE);
    const skills = new SkillsClient(client);
    const tap = tapWire(client);

    const { skill: v1 } = await skills.get(GIT);
    await expect(skills.read(v1, 'references/REVIEW.md')).resolves.toMatchObject({ text: REVIEW_MD, verified: true });

    files['git-workflow/references/REVIEW.md'] = '# Review v2\n';
    await catalog.reload();
    const { skill: v2 } = await skills.get(GIT);

    // The cached v1 copy fails v2's digest, so read() fetches once more; the third read is a cache hit.
    await expect(skills.read(v2, 'references/REVIEW.md')).resolves.toMatchObject({ text: '# Review v2\n', verified: true });
    await expect(skills.read(v2, 'references/REVIEW.md')).resolves.toMatchObject({ text: '# Review v2\n', verified: true });
    const sent = await requestMethods(tap);
    expect(sent.filter(method => method === 'resources/read')).toHaveLength(2);
});

// ───────────────────────────────────────────────────────────────────────────────
// Custom sources
// ───────────────────────────────────────────────────────────────────────────────

verifies('skills:uri:other-scheme', async ({ transport }: TestArgs) => {
    const baseUri = 'github://owner/repo/skills';
    const notes = await skillEntry('notes', { 'SKILL.md': NOTES_MD }, { baseUri });
    const source = lyingSource(notes, uri => (uri === notes.uri ? NOTES_MD : undefined));
    const client = newClient();
    await using _ = await wire(transport, serving(new SkillsExtension({ source, baseUri, onWarning: quiet })), client, SKILLS_WIRE);
    const skills = new SkillsClient(client);

    const { resourceTemplates } = await raw(client, 'resources/templates/list');
    expect(resourceTemplates).toEqual([{ name: EXTENSION, uriTemplate: 'github://owner/repo/skills/{+path}' }]);
    const { skills: listed } = await skills.list();
    expect(listed.map(entry => entry.uri)).toEqual(['github://owner/repo/skills/notes/SKILL.md']);
    const { skill } = await skills.get(notes.uri);
    expect(skill.uri).toBe('github://owner/repo/skills/notes/SKILL.md');
    await expect(skills.read(skill)).resolves.toMatchObject({ uri: 'github://owner/repo/skills/notes/SKILL.md', verified: true });
});

verifies('typescript:skills:source:list-resources', async ({ transport }: TestArgs) => {
    const { notes, source } = await notesSource();
    const warnings: SkillWarning[] = [];
    const listing: SkillSource = {
        ...source,
        listResources: async () => [
            { uri: notes.uri, name: 'notes', mimeType: 'text/markdown' },
            { uri: 'file:///elsewhere.md', name: 'elsewhere' }
        ]
    };
    {
        const client = newClient();
        const extension = new SkillsExtension({ source: listing, onWarning: warning => void warnings.push(warning) });
        await using _ = await wire(transport, serving(extension), client);

        const { resources } = await client.listResources();

        expect(resources.map(resource => resource.uri)).toEqual([notes.uri]);
        expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'file:///elsewhere.md' })]));
    }
    {
        const client = newClient();
        await using _ = await wire(transport, serving(new SkillsExtension({ source, onWarning: quiet })), client);

        await expect(client.listResources()).resolves.toMatchObject({ resources: [] });
    }
});

verifies('typescript:skills:source:invalid-entries', async ({ transport }: TestArgs) => {
    const { notes, source } = await notesSource();
    const other = await skillEntry('other', { 'SKILL.md': skillMd('other', 'Another skill.') });
    const withInvalid: SkillSource = {
        ...source,
        list: async () => ({ skills: [notes, { ...other, frontmatter: { name: 'mismatch', description: 'x' } }] })
    };
    {
        const warnings: SkillWarning[] = [];
        const client = newClient();
        const extension = new SkillsExtension({ source: withInvalid, onWarning: warning => void warnings.push(warning) });
        await using _ = await wire(transport, serving(extension), client, SKILLS_WIRE);

        const { skills } = await new SkillsClient(client).list();

        expect(skills.map(entry => entry.uri)).toEqual([notes.uri]);
        expect(warnings).toEqual([expect.objectContaining({ message: expect.stringContaining('dropped from skills/list') })]);
    }
    {
        const client = newClient();
        await using _ = await wire(
            transport,
            serving(new SkillsExtension({ source: withInvalid, strict: true, onWarning: quiet })),
            client,
            SKILLS_WIRE
        );

        await expect(raw(client, 'skills/list')).rejects.toMatchObject({
            code: ProtocolErrorCode.InternalError,
            message: expect.stringContaining('invalid skill entry from the source')
        });
    }
});

verifies('typescript:skills:client:skip-invalid', async ({ transport }: TestArgs) => {
    const { notes, source } = await notesSource();
    const git = await skillEntry('git-workflow', { 'SKILL.md': GIT_MD });
    const repeated: SkillSource = { ...source, list: async () => ({ skills: [git, notes, notes] }) };
    const client = newClient();
    await using _ = await wire(transport, serving(new SkillsExtension({ source: repeated, onWarning: quiet })), client, SKILLS_WIRE);

    const strict = new SkillsClient(client).list();
    await expect(strict).rejects.toBeInstanceOf(SdkError);
    await expect(strict).rejects.toMatchObject({
        code: SdkErrorCode.InvalidResult,
        data: { invalid: [expect.anything(), expect.anything()] }
    });

    const lenient = await new SkillsClient(client, { skipInvalid: true }).list();
    expect(lenient.skills.map(entry => entry.uri)).toEqual([git.uri]);
    expect(lenient.invalid).toEqual([
        { index: 1, uri: notes.uri, reason: expect.stringContaining('more than once') },
        { index: 2, uri: notes.uri, reason: expect.stringContaining('more than once') }
    ]);
});

// ───────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ───────────────────────────────────────────────────────────────────────────────

verifies('typescript:skills:attach:rules', async ({ transport }: TestArgs) => {
    const a = await catalogOf({ 'alpha/SKILL.md': skillMd('alpha', 'First catalog.') });
    const b = await catalogOf({ 'bravo/SKILL.md': skillMd('bravo', 'Second catalog.') });
    let server: McpServer | undefined;
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        a.attach(s);
        a.attach(s);
        expect(() => b.attach(s)).toThrow(/another skills extension is already attached/);
        server = s;
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client, SKILLS_WIRE);

    const { skills } = await new SkillsClient(client).list();
    expect(skills.map(entry => entry.uri)).toEqual(['skill://alpha/SKILL.md']);

    const connected = defined(server, 'server');
    expect(() => a.attach(connected)).not.toThrow();
    expect(() => b.attach(connected)).toThrow('attach skills before connecting the server');
});

verifies('typescript:skills:catalog:reload-notifies', async ({ transport }: TestArgs) => {
    const DELTA = 'skill://delta/SKILL.md';
    const files: Record<string, string> = { 'git-workflow/SKILL.md': GIT_MD };
    const catalog = await catalogOf(files);
    // Two clients, so two connected servers share the catalog: each must hear every listing change.
    const heard = { first: 0, second: 0 };
    const [first, second] = [newClient(), newClient()];
    first.setNotificationHandler('notifications/resources/list_changed', () => void heard.first++);
    second.setNotificationHandler('notifications/resources/list_changed', () => void heard.second++);
    const bothHeard = (count: number) => vi.waitFor(() => expect(heard).toEqual({ first: count, second: count }));
    await using _ = await wire(transport, serving(catalog), first);
    {
        await using _ = await wire(transport, serving(catalog), second);

        files['delta/SKILL.md'] = skillMd('delta', 'Added later.');
        await expect(catalog.reload()).resolves.toEqual({ added: [DELTA], removed: [], changed: [], listChanged: true });
        await bothHeard(1);

        files['delta/SKILL.md'] = skillMd('delta', 'Added later.', '# A new body\n');
        await expect(catalog.reload()).resolves.toEqual({ added: [], removed: [], changed: [DELTA], listChanged: false });
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(heard).toEqual({ first: 1, second: 1 });

        files['delta/SKILL.md'] = skillMd('delta', 'A new description.', '# A new body\n');
        await expect(catalog.reload()).resolves.toEqual({ added: [], removed: [], changed: [DELTA], listChanged: true });
        await bothHeard(2);

        delete files['delta/SKILL.md'];
        await expect(catalog.reload()).resolves.toEqual({ added: [], removed: [DELTA], changed: [], listChanged: true });
        await bothHeard(3);
    }
});

verifies('typescript:skills:catalog:reload-listen', async () => {
    const files: Record<string, string> = { 'git-workflow/SKILL.md': GIT_MD };
    const catalog = await catalogOf(files);
    // Hosted by the body, not wire(): publishing the change needs the handler's notify.
    const handler = createMcpHandler(serving(catalog), { legacy: 'reject', keepAliveMs: 0 });
    const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(
        new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) })
    );
    await using _ = { [Symbol.asyncDispose]: () => Promise.all([client.close(), handler.close()]).then(() => {}) };
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const seen: string[] = [];
    client.setNotificationHandler('notifications/resources/list_changed', () => void seen.push('resources/list_changed'));
    const subscription = await client.listen({ resourcesListChanged: true });
    expect(subscription.honoredFilter).toEqual({ resourcesListChanged: true });

    files['delta/SKILL.md'] = skillMd('delta', 'Added later.');
    const changes = await catalog.reload();
    expect(changes).toMatchObject({ added: ['skill://delta/SKILL.md'], listChanged: true });
    // Each server the handler built has served its one request and closed, so reload() alone reaches no client.
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(seen).toEqual([]);

    if (changes.listChanged) handler.notify.resourcesChanged();
    await vi.waitFor(() => expect(seen).toEqual(['resources/list_changed']));
    await subscription.close();
});
