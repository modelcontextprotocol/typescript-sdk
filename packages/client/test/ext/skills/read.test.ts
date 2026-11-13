import type { Skill, SkillResourceEntry } from '@modelcontextprotocol/core/ext/skills';
import { SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { buildSkillEntry, encodeUtf8, joinUri, sha256Digest } from '@modelcontextprotocol/core-internal/ext/skills';
import { describe, expect, it, vi } from 'vitest';

import type { SkillsClientOptions } from '../../../src/ext/skills/index';
import { SkillsClient, SkillVerificationError } from '../../../src/ext/skills/index';
import { CAPABILITIES, entryFor, filesOf, FORMS_MD, PDF_FILES, PDF_ROOT, PDF_SKILL_MD, uriOf } from './fixtures';
import type { Call } from './scripted';
import { scriptedClient, skillsHandlers } from './scripted';

const MANIFEST = `${PDF_ROOT}/SKILL.md`;
const FORMS = `${PDF_ROOT}/references/FORMS.md`;

interface Setup {
    files?: Readonly<Record<string, string | Uint8Array>>;
    options?: SkillsClientOptions;
    readTtlMs?: number;
}

async function connected({ files = PDF_FILES, options = {}, readTtlMs }: Setup = {}) {
    const skill = await entryFor(PDF_ROOT, files);
    const served = filesOf(PDF_ROOT, files);
    const { client, calls } = await scriptedClient(CAPABILITIES, skillsHandlers([skill], served, { readTtlMs }));
    return { skill, served, calls, skills: new SkillsClient(client, options) };
}

/** A server that publishes exactly these URIs, however it spells them, with these contents. */
async function publishedAs(contents: ReadonlyMap<string, string>) {
    const { skill, problems } = await buildSkillEntry(
        MANIFEST,
        [...contents].map(([uri, text]) => ({ uri, bytes: encodeUtf8(text) }))
    );
    if (skill === undefined || problems.length > 0) throw new Error(problems.join('; '));
    const { client, calls } = await scriptedClient(CAPABILITIES, skillsHandlers([skill], contents));
    return { skill, calls, skills: new SkillsClient(client) };
}

const reads = (calls: Call[]): unknown[] => calls.filter(call => call.method === 'resources/read').map(call => call.params['uri']);

describe('SkillsClient.read', () => {
    it("reads and verifies the skill's own SKILL.md", async () => {
        const { skills, skill } = await connected();
        const file = await skills.read(skill);
        expect(file).toMatchObject({
            uri: MANIFEST,
            text: PDF_SKILL_MD,
            verified: true,
            frontmatter: { name: 'pdf-processing', metadata: { author: 'acme', version: '1.0' } },
            body: expect.stringContaining('# PDF processing')
        });
        expect(file.bytes).toEqual(encodeUtf8(PDF_SKILL_MD));
    });

    it('resolves a relative path or an absolute URI against the skill root', async () => {
        const { skills, skill } = await connected();
        for (const ref of ['references/FORMS.md', './references/FORMS.md', 'references/../references/FORMS.md', FORMS]) {
            expect(await skills.read(skill, ref)).toMatchObject({ uri: FORMS, text: FORMS_MD, verified: true });
        }
    });

    it('resolves file names with a space to the URI the server published', async () => {
        const { skills, skill } = await connected();
        const published = uriOf(PDF_ROOT, 'templates/Purchase Order.md');
        expect(published).toBe('skill://pdf-processing/templates/Purchase%20Order.md');
        expect(await skills.read(skill, 'templates/Purchase Order.md')).toMatchObject({ uri: published, text: '# PO\n', verified: true });
    });

    it('resolves non-ASCII file names to the URI the server published', async () => {
        const { skills, skill } = await connected({ files: { ...PDF_FILES, 'references/résumé.md': '# CV\n' } });
        const published = uriOf(PDF_ROOT, 'references/résumé.md');
        expect(published).toBe('skill://pdf-processing/references/r%C3%A9sum%C3%A9.md');
        for (const ref of ['references/résumé.md', 'references/r%c3%a9sum%c3%a9.md']) {
            expect(await skills.read(skill, ref)).toMatchObject({ uri: published, text: '# CV\n', verified: true });
        }
    });

    it('matches reserved characters in a name however the ref spells them', async () => {
        const { skills, skill, calls } = await connected({ files: { ...PDF_FILES, 'references/Q&A.md': '# Q&A\n' } });
        const published = uriOf(PDF_ROOT, 'references/Q&A.md');
        expect(published).toBe('skill://pdf-processing/references/Q&A.md');
        for (const ref of ['references/Q&A.md', 'references/Q%26A.md']) {
            expect(await skills.read(skill, ref)).toMatchObject({ uri: published, text: '# Q&A\n', verified: true });
        }
        expect(reads(calls)).toEqual([published, published]);
    });

    it('verifies a file a server published with more encoding than ours, requesting its spelling', async () => {
        const overEncoded = `${PDF_ROOT}/references/Q%26A.md`;
        const { skills, skill, calls } = await publishedAs(
            new Map([
                [MANIFEST, PDF_SKILL_MD],
                [overEncoded, '# Q&A\n']
            ])
        );
        for (const ref of ['references/Q&A.md', 'references/Q%26A.md']) {
            expect(await skills.read(skill, ref)).toMatchObject({ uri: overEncoded, text: '# Q&A\n', verified: true });
        }
        expect(reads(calls)).toEqual([overEncoded, overEncoded]);
    });

    it('requests a dynamic skill file at the URI its ref resolves to', async () => {
        const overEncoded = `${PDF_ROOT}/references/Q%26A.md`;
        const { skill, calls, skills } = await publishedAs(
            new Map([
                [MANIFEST, PDF_SKILL_MD],
                [overEncoded, '# Q&A\n']
            ])
        );
        const dynamic: Skill = { ...skill, resources: 'dynamic' };
        expect(await skills.read(dynamic, 'references/Q%26A.md')).toMatchObject({ uri: overEncoded, text: '# Q&A\n', verified: false });
        expect(reads(calls)).toEqual([overEncoded]);
    });

    it('accepts contents that spell the requested file differently', async () => {
        const skill = await entryFor(PDF_ROOT, { ...PDF_FILES, 'references/Q&A.md': '# Q&A\n' });
        const echoed = `${PDF_ROOT}/references/Q%26A.md`;
        const { client } = await scriptedClient(CAPABILITIES, {
            ...skillsHandlers([skill], new Map()),
            'resources/read': () => ({ contents: [{ uri: echoed, text: '# Q&A\n' }], ttlMs: 0, cacheScope: 'private' })
        });
        const skills = new SkillsClient(client);
        for (const target of [skill, { ...skill, resources: 'dynamic' } satisfies Skill]) {
            expect(await skills.read(target, 'references/Q&A.md')).toMatchObject({ text: '# Q&A\n' });
        }
    });

    it('refuses an invalid entry before any request: a file listed in two spellings, or outside the skill', async () => {
        const { skills, skill, calls } = await connected({ files: { ...PDF_FILES, 'references/Q&A.md': '# Q&A\n' } });
        const listed = skill.resources as SkillResourceEntry[];
        const qa = listed.find(resource => resource.uri.endsWith('/Q&A.md'))!;
        const twice: Skill = { ...skill, resources: [...listed, { ...qa, uri: `${PDF_ROOT}/references/Q%26A.md` }] };
        const outside: Skill = { ...skill, resources: [...listed, { ...qa, uri: 'skill://other-skill/Q&A.md' }] };
        for (const [entry, ref, reason] of [
            [twice, 'references/Q&A.md', /more than once/],
            [outside, 'skill://other-skill/Q&A.md', /outside the skill directory/]
        ] as const) {
            const error = await skills.read(entry, ref).catch((error: unknown) => error);
            expect(error).toBeInstanceOf(TypeError);
            expect(error).toMatchObject({ message: expect.stringMatching(reason) });
        }
        expect(reads(calls)).toEqual([]);
    });

    it("checks SKILL.md's frontmatter however the ref spells it", async () => {
        const { skills, skill, calls } = await connected();
        expect(await skills.read(skill, '%53KILL.md')).toMatchObject({ uri: MANIFEST, frontmatter: { name: 'pdf-processing' } });
        const tampered: Skill = { ...skill, frontmatter: { ...skill.frontmatter, description: 'Something else.' } };
        await expect(skills.read(tampered, '%53KILL.md')).rejects.toMatchObject({ reason: 'frontmatter', uri: MANIFEST });
        expect(reads(calls)).toEqual([MANIFEST, MANIFEST]);
    });

    it('drops a fragment from the ref', async () => {
        const { skills, skill, calls } = await connected();
        expect(await skills.read(skill, 'references/FORMS.md#fields')).toMatchObject({ uri: FORMS, verified: true });
        const dynamic: Skill = { ...skill, resources: 'dynamic' };
        expect(await skills.read(dynamic, 'references/FORMS.md#fields')).toMatchObject({ uri: FORMS, verified: false });
        expect(reads(calls)).toEqual([FORMS, FORMS]);
    });

    it('refuses a ref that is not a URI reference, before any request', async () => {
        const { skills, skill, calls } = await connected();
        const error = await skills.read(skill, 'http://[').catch((error: unknown) => error);
        expect(error).toBeInstanceOf(SkillVerificationError);
        expect(error).toMatchObject({ reason: 'unlisted', uri: 'http://[' });
        expect(reads(calls)).toEqual([]);
    });

    it.each([
        ['100% off.md', '100%25%20off.md'],
        ['10%Dec.md', '10%25Dec.md'],
        ['%Café.md', '%25Caf%C3%A9.md']
    ])('reads %s, a name with a stray %, by its plain name', async (name, encoded) => {
        const { skills, skill } = await connected({ files: { ...PDF_FILES, [`references/${name}`]: '# Sale\n' } });
        const published = uriOf(PDF_ROOT, `references/${name}`);
        expect(published).toBe(`skill://pdf-processing/references/${encoded}`);
        expect(await skills.read(skill, `references/${name}`)).toMatchObject({ uri: published, text: '# Sale\n', verified: true });
    });

    it.each(['me@home', 'acme:prod', '[draft]'])('reads and matches files of a skill under the %s folder or prefix', async first => {
        const root = joinUri('skill://', [first, 'pdf-processing']);
        expect(root).toBe(`skill://${encodeURIComponent(first)}/pdf-processing`);
        const files = { ...PDF_FILES, 'references/Q&A.md': '# Q&A\n' };
        const skill = await entryFor(root, files);
        const { client } = await scriptedClient(CAPABILITIES, skillsHandlers([skill], filesOf(root, files)));
        const skills = new SkillsClient(client);
        expect(await skills.read(skill)).toMatchObject({ uri: `${root}/SKILL.md`, verified: true });
        for (const ref of ['references/Q&A.md', 'references/Q%26A.md', `${root}/references/Q&A.md`]) {
            expect(await skills.read(skill, ref)).toMatchObject({ uri: `${root}/references/Q&A.md`, text: '# Q&A\n', verified: true });
        }
    });

    it('refuses unlisted files before sending any request', async () => {
        const { skills, skill, calls } = await connected();
        for (const ref of ['references/MISSING.md', '../../etc/passwd', 'skill://other-skill/SKILL.md', 'https://example.com/x']) {
            await expect(skills.read(skill, ref)).rejects.toMatchObject({ reason: 'unlisted' });
        }
        expect(reads(calls)).toEqual([]);
    });

    it('rejects a file whose size differs from the entry', async () => {
        const { skills, skill, served } = await connected();
        served.set(FORMS, '# Forms, but longer\n');
        await expect(skills.read(skill, 'references/FORMS.md')).rejects.toMatchObject({ reason: 'size', uri: FORMS });
    });

    it('rejects a file whose digest differs from the entry', async () => {
        const { skills, skill, served } = await connected();
        served.set(FORMS, FORMS_MD.toUpperCase());
        const error = await skills.read(skill, 'references/FORMS.md').catch((error: unknown) => error);
        expect(error).toBeInstanceOf(SkillVerificationError);
        expect(error).toMatchObject({ reason: 'digest', uri: FORMS, code: SdkErrorCode.InvalidResult });
    });

    it('rejects a SKILL.md whose frontmatter differs from the entry, naming the field', async () => {
        const { skills, skill } = await connected();
        const tampered: Skill = { ...skill, frontmatter: { ...skill.frontmatter, metadata: { author: 'someone-else', version: '1.0' } } };
        await expect(skills.read(tampered)).rejects.toMatchObject({
            reason: 'frontmatter',
            differences: [expect.stringContaining('metadata.author')]
        });
    });

    it('sees fields either side inherits through a prototype', async () => {
        const inheriting = (fields: object, inherited: object) => Object.assign(Object.create(inherited) as object, fields);
        const { skills, skill } = await connected();
        const entry: Skill = {
            ...skill,
            frontmatter: inheriting(skill.frontmatter, { 'allowed-tools': 'Bash(*)' }) as Skill['frontmatter']
        };
        await expect(skills.read(entry)).rejects.toMatchObject({
            reason: 'frontmatter',
            differences: ['allowed-tools: the entry has "Bash(*)", SKILL.md has nothing']
        });
        const parseFrontmatter = () => inheriting(skill.frontmatter, { 'allowed-tools': 'Bash(*)' }) as Record<string, unknown>;
        const parsing = await connected({ options: { parseFrontmatter } });
        await expect(parsing.skills.read(parsing.skill)).rejects.toMatchObject({
            reason: 'frontmatter',
            differences: ['allowed-tools: the entry has nothing, SKILL.md has "Bash(*)"']
        });
    });

    it('fails closed on YAML outside the supported subset', async () => {
        const markdown = '---\nname: &n pdf-processing\ndescription: d\n---\n';
        const bytes = encodeUtf8(markdown);
        const skill: Skill = {
            uri: MANIFEST,
            frontmatter: { name: 'pdf-processing', description: 'd' },
            resources: [{ uri: MANIFEST, digest: await sha256Digest(bytes), size: bytes.byteLength }]
        };
        const { client } = await scriptedClient(CAPABILITIES, skillsHandlers([skill], new Map([[MANIFEST, markdown]])));
        await expect(new SkillsClient(client).read(skill)).rejects.toMatchObject({ reason: 'frontmatter' });
    });

    it('passes parseFrontmatter only the YAML between the --- lines', async () => {
        const parseFrontmatter = vi.fn(() => ({
            name: 'pdf-processing',
            description: 'Extract text and fill forms in PDF files.',
            metadata: { author: 'acme', version: '1.0' }
        }));
        const { skills, skill } = await connected({ options: { parseFrontmatter } });
        expect(await skills.read(skill)).toMatchObject({ verified: true, body: expect.stringContaining('# PDF processing') });
        expect(parseFrontmatter).toHaveBeenCalledWith(`name: pdf-processing
description: Extract text and fill forms in PDF files.
metadata:
  author: acme
  version: "1.0"
`);
    });

    it('passes parseFrontmatter the YAML of a Windows-authored SKILL.md with the BOM and CRLF removed', async () => {
        const windows = { 'SKILL.md': '﻿---\r\nname: pdf-processing\r\ndescription: Extract text.\r\n---\r\n# PDF\r\n' };
        const parseFrontmatter = vi.fn(() => ({ name: 'pdf-processing', description: 'Extract text.' }));
        const { skills, skill } = await connected({ files: windows, options: { parseFrontmatter } });
        expect(await skills.read(skill)).toMatchObject({ verified: true });
        expect(parseFrontmatter).toHaveBeenCalledWith('name: pdf-processing\ndescription: Extract text.\n');
    });

    it('verifies a Windows-authored SKILL.md (BOM and CRLF)', async () => {
        const windows = { 'SKILL.md': '﻿---\r\nname: pdf-processing\r\ndescription: Extract text.\r\n---\r\n# PDF\r\n' };
        const { skills, skill } = await connected({ files: windows });
        expect(await skills.read(skill)).toMatchObject({
            verified: true,
            frontmatter: { name: 'pdf-processing', description: 'Extract text.' }
        });
    });

    it('decodes and verifies binary files', async () => {
        const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
        const { skills, skill } = await connected({ files: { ...PDF_FILES, 'assets/logo.png': png } });
        const file = await skills.read(skill, 'assets/logo.png');
        expect(file).toMatchObject({ verified: true, mimeType: 'application/octet-stream' });
        expect(file.bytes).toEqual(png);
        expect(file).not.toHaveProperty('text');
    });

    it("treats a nested skill's SKILL.md as an ordinary file of the enclosing skill", async () => {
        const { skills, skill } = await connected({
            files: {
                ...PDF_FILES,
                'forms/SKILL.md': `---
name: forms
description: Nested.
---
`
            }
        });
        const file = await skills.read(skill, 'forms/SKILL.md');
        expect(file).toMatchObject({ verified: true });
        expect(file).not.toHaveProperty('frontmatter');
    });

    it('reads dynamic skills unverified but still compares SKILL.md frontmatter', async () => {
        const { skills, skill } = await connected();
        const dynamic: Skill = { ...skill, resources: 'dynamic' };
        expect(await skills.read(dynamic, 'references/FORMS.md')).toMatchObject({ verified: false, text: FORMS_MD });
        expect(await skills.read(dynamic)).toMatchObject({ verified: false, frontmatter: { name: 'pdf-processing' } });
        const tampered = { ...dynamic, frontmatter: { ...dynamic.frontmatter, description: 'other' } };
        await expect(skills.read(tampered)).rejects.toMatchObject({ reason: 'frontmatter' });
        await expect(skills.read(dynamic, 'skill://other-skill/SKILL.md')).rejects.toMatchObject({ reason: 'unlisted' });
    });

    it('fetches again once when a cached copy fails verification', async () => {
        const { skills, skill, served, calls } = await connected({ readTtlMs: 60_000 });
        await skills.read(skill, 'references/FORMS.md');
        served.set(FORMS, '# Forms v2\n');
        const updated = await entryFor(PDF_ROOT, { ...PDF_FILES, 'references/FORMS.md': '# Forms v2\n' });
        expect(await skills.read(updated, 'references/FORMS.md')).toMatchObject({ text: '# Forms v2\n', verified: true });
        expect(reads(calls)).toEqual([FORMS, FORMS]);
    });

    it('gives up when the fresh copy fails as well', async () => {
        const { skills, skill, served, calls } = await connected({ readTtlMs: 60_000 });
        await skills.read(skill, 'references/FORMS.md');
        served.set(FORMS, '# Forms v2\n');
        const other = await entryFor(PDF_ROOT, { ...PDF_FILES, 'references/FORMS.md': '# Forms v3\n' });
        await expect(skills.read(other, 'references/FORMS.md')).rejects.toMatchObject({ reason: 'digest' });
        expect(reads(calls)).toEqual([FORMS, FORMS]);
    });

    it('fetches no second copy when the failing one came from the server', async () => {
        const { skills, skill, served, calls } = await connected({ readTtlMs: 60_000 });
        served.set(FORMS, FORMS_MD.toUpperCase());
        for (const cacheMode of [undefined, 'refresh', 'bypass'] as const) {
            await expect(skills.read(skill, 'references/FORMS.md', { cacheMode })).rejects.toMatchObject({ reason: 'digest' });
        }
        expect(reads(calls)).toEqual([FORMS, FORMS, FORMS]);
    });

    it('refuses contents for a URI other than the one requested', async () => {
        const skill = await entryFor(PDF_ROOT, PDF_FILES);
        const other = { uri: `${PDF_ROOT}/references/OTHER.md`, mimeType: 'text/markdown', text: FORMS_MD };
        const { client } = await scriptedClient(CAPABILITIES, {
            ...skillsHandlers([skill], filesOf(PDF_ROOT, PDF_FILES)),
            'resources/read': () => ({ contents: [other], ttlMs: 0, cacheScope: 'private' })
        });
        const skills = new SkillsClient(client);
        for (const target of [skill, { ...skill, resources: 'dynamic' } satisfies Skill]) {
            const error = await skills.read(target, 'references/FORMS.md').catch((error: unknown) => error);
            expect(error).not.toBeInstanceOf(SkillVerificationError);
            expect(error).toMatchObject({ code: SdkErrorCode.InvalidResult, message: expect.stringContaining(FORMS) });
        }
    });

    it('throws CapabilityNotSupported on a server without the extension', async () => {
        const skill = await entryFor(PDF_ROOT, PDF_FILES);
        const { client } = await scriptedClient({ resources: {} }, {});
        await expect(new SkillsClient(client).read(skill)).rejects.toMatchObject({ code: SdkErrorCode.CapabilityNotSupported });
    });
});
