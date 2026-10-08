import { readdirSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `migration/upgrade-to-v2.md` is assembled with `<!--@include: -->` from the
 * v1→v2 upgrade agent skill in `skills/mcp-typescript-sdk-upgrade-to-v2/`, its
 * source. The skill's links work wherever it is installed — cross-file
 * (`references/auth.md#auth`, `../SKILL.md#…`) and absolute site URLs — so on
 * the assembled page they are mapped back to in-page anchors and relative links.
 */
export const SKILL_PAGE = 'migration/upgrade-to-v2.md';

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../skills/mcp-typescript-sdk-upgrade-to-v2');
const references = new Set(readdirSync(resolve(skillDir, 'references')));

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
