import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import { SkillSchema } from '@modelcontextprotocol/core/ext/skills';

import { decodeUtf8Lossless, sha256Digest } from './bytes';
import { FrontmatterError, parseSkillMarkdown } from './frontmatter';
import { canonicalUri, compareUris, isWithin, lastSegmentOf, skillFileKey, skillRootUri } from './uri';

/** Agent Skills name rule: lowercase letters, digits and single hyphens (length checked separately). */
export const SKILL_NAME_PATTERN = /^[\da-z]+(?:-[\da-z]+)*$/;

const isStringMap = (value: unknown): boolean =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(item => typeof item === 'string');

// Agent Skills length limits count characters (code points), not UTF-16 code units.
function countCharacters(text: string): number {
    let count = 0;
    for (let index = 0; index < text.length; index += text.codePointAt(index)! > 0xff_ff ? 2 : 1) count++;
    return count;
}

/** Structural rules of the stable spec and Agent Skills. Empty array = valid. */
export function validateSkillEntry(skill: Skill): string[] {
    const problems: string[] = [];
    const root = skillRootUri(skill.uri);
    if (root === undefined) return [`uri "${skill.uri}" must be a URI ending in /SKILL.md inside a named directory`];
    const frontmatter = skill.frontmatter as Record<string, unknown>;
    const { name, description } = skill.frontmatter;
    if (name.length === 0 || name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
        problems.push(`frontmatter name "${name}" must be 1-64 lowercase letters, digits and single hyphens`);
    } else if (lastSegmentOf(root) !== name) {
        problems.push(`frontmatter name "${name}" must match the last path segment "${lastSegmentOf(root)}"`);
    }
    if (description === '' || countCharacters(description) > 1024) problems.push('frontmatter description must be 1-1024 characters');
    const compatibility = frontmatter['compatibility'];
    if (
        compatibility !== undefined &&
        (typeof compatibility !== 'string' || compatibility === '' || countCharacters(compatibility) > 500)
    ) {
        problems.push('frontmatter compatibility must be a string of 1-500 characters');
    }
    if (frontmatter['metadata'] !== undefined && !isStringMap(frontmatter['metadata'])) {
        problems.push('frontmatter metadata must map strings to strings');
    }
    if (skill.resources !== 'dynamic') {
        const self = canonicalUri(skill.uri);
        const seen = new Set<string>();
        let hasSelf = false;
        for (const resource of skill.resources) {
            const canonical = canonicalUri(resource.uri);
            if (canonical === undefined) {
                problems.push(`resource "${resource.uri}" is not a valid URI`);
                continue;
            }
            // A canonical URI holds a raw `?` or `#` only as a query or fragment, even an empty one.
            if (/[#?]/.test(canonical)) {
                problems.push(`resource "${resource.uri}" must not have a query or fragment`);
                continue;
            }
            const key = skillFileKey(root, canonical) ?? canonical;
            if (seen.has(key)) problems.push(`resource "${resource.uri}" is listed more than once`);
            seen.add(key);
            if (canonical === self) hasSelf = true;
            else if (!isWithin(root, resource.uri)) problems.push(`resource "${resource.uri}" is outside the skill directory ${root}`);
        }
        if (!hasSelf) problems.push(`resources must include ${skill.uri}`);
    }
    return problems;
}

/** Schema check plus {@linkcode validateSkillEntry}, for values received from elsewhere. */
export function skillEntryProblems(value: unknown): string[] {
    const parsed = SkillSchema.safeParse(value);
    if (!parsed.success) return parsed.error.issues.map(issue => `${issue.path.join('.') || '(entry)'}: ${issue.message}`);
    return validateSkillEntry(parsed.data);
}

export interface SkillFileInput {
    uri: string;
    bytes: Uint8Array;
}

/** Builds an entry from a skill's files: parses `SKILL.md`, hashes every file, sorts by URI, validates. */
export async function buildSkillEntry(
    skillMdUri: string,
    files: readonly SkillFileInput[]
): Promise<{ skill?: Skill; problems: string[] }> {
    const manifest = files.find(file => file.uri === skillMdUri);
    if (manifest === undefined) return { problems: ['SKILL.md is missing'] };
    const text = decodeUtf8Lossless(manifest.bytes);
    if (text === undefined) return { problems: ['SKILL.md is not valid UTF-8'] };
    let frontmatter: Record<string, unknown>;
    try {
        frontmatter = parseSkillMarkdown(text).frontmatter;
    } catch (error) {
        if (error instanceof FrontmatterError) return { problems: [`SKILL.md frontmatter: ${error.message}`] };
        throw error;
    }
    if (typeof frontmatter['name'] !== 'string' || typeof frontmatter['description'] !== 'string') {
        return { problems: ['SKILL.md frontmatter must contain string "name" and "description"'] };
    }
    const resources = await Promise.all(
        files.map(async file => ({ uri: file.uri, digest: await sha256Digest(file.bytes), size: file.bytes.byteLength }))
    );
    resources.sort((a, b) => compareUris(a.uri, b.uri));
    const skill = { uri: skillMdUri, frontmatter, resources } as Skill;
    return { skill, problems: validateSkillEntry(skill) };
}
