import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import { SKILLS_EXTENSION_ID } from '@modelcontextprotocol/core/ext/skills';
import type { ServerCapabilities } from '@modelcontextprotocol/core-internal';
import { buildSkillEntry, encodeSegment, encodeUtf8 } from '@modelcontextprotocol/core-internal/ext/skills';

export const CAPABILITIES: ServerCapabilities = { resources: {}, extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: true } } };

export const PDF_ROOT = 'skill://pdf-processing';
export const PDF_SKILL_MD = `---
name: pdf-processing
description: Extract text and fill forms in PDF files.
metadata:
  author: acme
  version: "1.0"
---
# PDF processing

See [the forms guide](references/FORMS.md).
`;
export const FORMS_MD = `# Forms

Fill the fields in order.
`;
export const PDF_FILES: Readonly<Record<string, string | Uint8Array>> = {
    'SKILL.md': PDF_SKILL_MD,
    'references/FORMS.md': FORMS_MD,
    'templates/Purchase Order.md': '# PO\n'
};

/** The URI a conforming server publishes for `path` inside the skill at `root`: each segment percent-encoded. */
export function uriOf(root: string, path: string): string {
    return `${root}/${path
        .split('/')
        .map(segment => encodeSegment(segment))
        .join('/')}`;
}

/** File contents keyed by published URI. */
export function filesOf(root: string, files: Readonly<Record<string, string | Uint8Array>>): Map<string, string | Uint8Array> {
    return new Map(Object.entries(files).map(([path, content]) => [uriOf(root, path), content]));
}

/** A valid entry for these files, as a conforming server publishes it. */
export async function entryFor(root: string, files: Readonly<Record<string, string | Uint8Array>>): Promise<Skill> {
    const inputs = Object.entries(files).map(([path, content]) => ({
        uri: uriOf(root, path),
        bytes: typeof content === 'string' ? encodeUtf8(content) : content
    }));
    const { skill, problems } = await buildSkillEntry(`${root}/SKILL.md`, inputs);
    if (skill === undefined || problems.length > 0) throw new Error(problems.join('; '));
    return skill;
}

/** A valid skill called `name` with only a `SKILL.md`. */
export function namedSkill(name: string): Promise<Skill> {
    return entryFor(`skill://${name}`, { 'SKILL.md': `---\nname: ${name}\ndescription: The ${name} skill.\n---\n` });
}
