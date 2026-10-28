import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A skill file as links inside the skill name it: `SKILL.md`, or a reference's bare file name. */
function skillFile(path: string): string {
    return /^(?:\.\.\/)?SKILL\.md$/.test(path) ? 'SKILL.md' : path.replace(/^references\//, '');
}

/** The docs pages assembled with `<!--@include: -->` from a skill in `skills/`, each with the skill files it includes. */
const SKILL_PAGES: ReadonlyMap<string, ReadonlySet<string>> = new Map(
    ['migration/upgrade-to-v2.md', 'servers/skills.md', 'clients/skills.md'].map(page => {
        const source = readFileSync(resolve(docsDir, page), 'utf8');
        const includes = source.matchAll(/<!--@include: \.\.\/\.\.\/skills\/[^/]+\/(SKILL\.md|references\/[^#]+?)(?:#[\w-]+)?-->/g);
        return [page, new Set([...includes].map(([, path]) => skillFile(path!)))];
    })
);

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

/** Rewrite one link target on a skill-assembled page; every other page and link passes through. */
export function rewriteSkillLink(href: string, page: string, site: string): string {
    const files = SKILL_PAGES.get(page);
    if (!files) return href;
    const hashIndex = href.indexOf('#');
    const path = hashIndex === -1 ? href : href.slice(0, hashIndex);
    const hash = hashIndex === -1 ? '' : href.slice(hashIndex);
    if (path.startsWith(`${site}/`)) {
        const relative = posix.relative(posix.dirname(page), path.slice(site.length + 1));
        return `${relative.startsWith('../') ? relative : `./${relative}`}${hash}`;
    }
    return hash && files.has(skillFile(path)) ? hash : href;
}
