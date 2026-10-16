import { readdirSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The docs page assembled with `<!--@include: -->` from the skill in `skills/mcp-typescript-sdk-upgrade-to-v2/`. */
export const SKILL_PAGE = 'migration/upgrade-to-v2.md';

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../skills/mcp-typescript-sdk-upgrade-to-v2');
const references = new Set(readdirSync(resolve(skillDir, 'references')));

/**
 * GitHub's heading slug (github-slugger) for a heading's markdown text — the
 * anchor style the skill is written in, since GitHub and skills.sh render it.
 */
export function githubSlug(heading: string): string {
    return heading
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replaceAll('`', '')
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
        .replaceAll(' ', '-');
}

/** Rewrite one link target on the skill-assembled page; every other page and link passes through. */
export function rewriteSkillLink(href: string, page: string, site: string): string {
    if (page !== SKILL_PAGE) return href;
    const hashIndex = href.indexOf('#');
    const path = hashIndex === -1 ? href : href.slice(0, hashIndex);
    const hash = hashIndex === -1 ? '' : href.slice(hashIndex);
    if (path.startsWith(`${site}/`)) {
        const relative = posix.relative(posix.dirname(page), path.slice(site.length + 1));
        return `${relative.startsWith('../') ? relative : `./${relative}`}${hash}`;
    }
    const file = /^(?:\.\.\/)?SKILL\.md$/.test(path) ? 'SKILL.md' : path.replace(/^references\//, '');
    return hash && (file === 'SKILL.md' || references.has(file)) ? hash : href;
}
