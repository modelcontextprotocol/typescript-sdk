import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import { buildSkillEntry, encodeUtf8, SdkErrorCode, sha256Digest } from '@modelcontextprotocol/core-internal';
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

    it('prefers the exact spelling when an entry lists two spellings of one file', async () => {
        const plain = `${PDF_ROOT}/references/Q&A.md`;
        const encoded = `${PDF_ROOT}/references/Q%26A.md`;
        const { skills, skill } = await publishedAs(
            new Map([
                [MANIFEST, PDF_SKILL_MD],
                [plain, '# plain\n'],
                [encoded, '# encoded\n']
            ])
        );
        for (const ref of ['references/Q&A.md', 'references/Q&A.md#part']) {
            expect(await skills.read(skill, ref)).toMatchObject({ uri: plain, text: '# plain\n' });
        }
        expect(await skills.read(skill, 'references/Q%26A.md')).toMatchObject({ uri: encoded, text: '# encoded\n' });
    });

    it("checks SKILL.md's frontmatter however the ref spells it", async () => {
        const alias = `${PDF_ROOT}/%53KILL.md`;
        const { skills, skill } = await publishedAs(
            new Map([
                [MANIFEST, PDF_SKILL_MD],
                [alias, PDF_SKILL_MD.replace('Extract text and fill forms in PDF files.', 'Something else.')]
            ])
        );
        await expect(skills.read(skill, '%53KILL.md')).rejects.toMatchObject({ reason: 'frontmatter', uri: alias });
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

    it('uses parseFrontmatter when given', async () => {
        const parseFrontmatter = vi.fn(() => ({
            name: 'pdf-processing',
            description: 'Extract text and fill forms in PDF files.',
            metadata: { author: 'acme', version: '1.0' }
        }));
        const { skills, skill } = await connected({ options: { parseFrontmatter } });
        expect(await skills.read(skill)).toMatchObject({ verified: true, body: expect.stringContaining('# PDF processing') });
        expect(parseFrontmatter).toHaveBeenCalledWith(PDF_SKILL_MD);
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
            files: { ...PDF_FILES, 'forms/SKILL.md': '---\nname: forms\ndescription: Nested.\n---\n' }
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

    it('gives up after that one extra fetch, and makes none under cacheMode bypass', async () => {
        const { skills, skill, served, calls } = await connected();
        served.set(FORMS, FORMS_MD.toUpperCase());
        await expect(skills.read(skill, 'references/FORMS.md')).rejects.toMatchObject({ reason: 'digest' });
        expect(reads(calls)).toEqual([FORMS, FORMS]);
        await expect(skills.read(skill, 'references/FORMS.md', { cacheMode: 'bypass' })).rejects.toMatchObject({ reason: 'digest' });
        expect(reads(calls)).toHaveLength(3);
    });

    it('throws CapabilityNotSupported on a server without the extension', async () => {
        const skill = await entryFor(PDF_ROOT, PDF_FILES);
        const { client } = await scriptedClient({ resources: {} }, {});
        await expect(new SkillsClient(client).read(skill)).rejects.toMatchObject({ code: SdkErrorCode.CapabilityNotSupported });
    });
});
