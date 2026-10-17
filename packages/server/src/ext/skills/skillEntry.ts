import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import { buildSkillEntry, encodeUtf8, joinUri } from '@modelcontextprotocol/core-internal/ext/skills';

import { SkillCatalogError } from './errors';
import { splitRelativePath } from './files';

/**
 * Builds a valid entry — digests, sizes, frontmatter, rule checks — from one
 * skill's files. Keys are paths under the skill's folder (`SKILL.md`,
 * `references/GUIDE.md`). For `SkillSource` authors who publish digests.
 */
export async function skillEntry(
    skillPath: string,
    files: Record<string, string | Uint8Array>,
    options: { baseUri?: string } = {}
): Promise<Skill> {
    const segments = splitRelativePath(skillPath, 'skillPath');
    const baseUri = options.baseUri ?? 'skill://';
    const inputs = Object.entries(files).map(([path, content]) => ({
        uri: joinUri(baseUri, [...segments, ...splitRelativePath(path, 'file path')]),
        bytes: typeof content === 'string' ? encodeUtf8(content) : content
    }));
    const { skill, problems } = await buildSkillEntry(joinUri(baseUri, [...segments, 'SKILL.md']), inputs);
    if (skill === undefined || problems.length > 0) {
        throw new SkillCatalogError(problems.map(message => ({ path: skillPath, message })));
    }
    return skill;
}
