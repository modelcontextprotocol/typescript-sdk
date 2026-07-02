import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

import type { DefaultTheme } from 'vitepress';

import { guideSidebar } from './nav';

/**
 * LLM-facing renditions of the docs, generated into the site output at build
 * time (wired into `buildEnd` in config.mts), following https://llmstxt.org
 * and the Python SDK's equivalent:
 *
 * - `<page>.md` next to every guide page's HTML — the page as plain markdown,
 *   frontmatter stripped, links absolutized (cross-page links point at the
 *   `.md` renditions so an agent can keep fetching markdown).
 * - `llms.txt` — the index: one line per page, grouped like the sidebar.
 * - `llms-full.txt` — every guide page concatenated in sidebar order.
 *
 * The generated API reference stays out of all three (linked, not inlined):
 * it would swamp the prose that answers most questions.
 */

interface Page {
    /** Sidebar title. */
    title: string;
    /** Path of the markdown source relative to the docs dir, e.g. `servers/tools.md`. */
    sourcePath: string;
    /** Absolute URL of the markdown rendition. */
    mdUrl: string;
}

interface Section {
    title: string;
    pages: Page[];
}

function toPage(site: string, title: string, route: string): Page {
    const sourcePath = route === '/' ? 'index.md' : route.endsWith('/') ? `${route.slice(1)}index.md` : `${route.slice(1)}.md`;
    return { title, sourcePath, mdUrl: `${site}/${sourcePath}` };
}

/** Flatten the sidebar into ordered sections, preserving sidebar order exactly. */
function sections(site: string): Section[] {
    const out: Section[] = [{ title: 'Overview', pages: [toPage(site, 'MCP TypeScript SDK', '/')] }];
    for (const entry of guideSidebar as (DefaultTheme.SidebarItem & { items?: DefaultTheme.SidebarItem[] })[]) {
        if (entry.items) {
            out.push({ title: entry.text!, pages: entry.items.map(i => toPage(site, i.text!, i.link!)) });
        } else {
            out.push({ title: entry.text!, pages: [toPage(site, entry.text!, entry.link!)] });
        }
    }
    return out;
}

/** Read a `description:` frontmatter value, if present. */
function frontmatterDescription(markdown: string): string | undefined {
    if (!markdown.startsWith('---\n')) return undefined;
    const end = markdown.indexOf('\n---\n', 4);
    if (end === -1) return undefined;
    const match = /^description:\s*(.+)$/m.exec(markdown.slice(4, end));
    return match?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
}

/** Strip `--- ... ---` frontmatter. */
function stripFrontmatter(markdown: string): string {
    if (!markdown.startsWith('---\n')) return markdown;
    const end = markdown.indexOf('\n---\n', 4);
    return end === -1 ? markdown : markdown.slice(end + 5).replace(/^\n+/, '');
}

/** Drop the `source="…"` wiring attribute from fence info lines. */
function stripFenceAttributes(markdown: string): string {
    return markdown.replace(/^```(\w+)\s+source="[^"]*"\s*$/gm, '```$1');
}

/**
 * Absolutize every link for a page living at `pageDir` (docs-relative, '' for
 * the root). Relative `.md` links stay `.md` so they resolve to the markdown
 * renditions; `/specification/…` goes to modelcontextprotocol.io, mirroring
 * the render-time rewrite in config.mts.
 */
function absolutizeLinks(markdown: string, pageDir: string, site: string, sourcePath: string): string {
    // Runs over the raw markdown, code fences included — fine while no code
    // sample contains a relative markdown link (none do; a false rewrite would
    // show up in review of the rendition).
    return markdown.replace(/\]\(([^)\s]+)\)/g, (match, target: string) => {
        if (/^(https?:|mailto:|#)/.test(target)) return match;
        if (target.startsWith('/specification/')) return `](https://modelcontextprotocol.io${target})`;
        if (target.startsWith('/')) return `](${site}${target})`;
        const hashIndex = target.indexOf('#');
        const path = hashIndex === -1 ? target : target.slice(0, hashIndex);
        const hash = hashIndex === -1 ? '' : target.slice(hashIndex);
        let resolved = posix.normalize(posix.join(pageDir, path));
        if (resolved.startsWith('..')) {
            throw new Error(`${sourcePath}: relative link escapes the docs root: ${target} — use the site URL or a GitHub URL`);
        }
        if (resolved.startsWith('api/')) {
            // The generated API reference has no markdown renditions — link its HTML.
            resolved = resolved.replace(/\.md$/, '.html');
        }
        return `](${site}/${resolved}${hash})`;
    });
}

function renderPage(docsDir: string, page: Page, site: string): { markdown: string; description?: string } {
    const raw = readFileSync(join(docsDir, page.sourcePath), 'utf8');
    const pageDir = posix.dirname(page.sourcePath);
    return {
        markdown: absolutizeLinks(stripFenceAttributes(stripFrontmatter(raw)), pageDir === '.' ? '' : pageDir, site, page.sourcePath),
        description: frontmatterDescription(raw)
    };
}

/** First prose sentence after the H1, markdown stripped, for the llms.txt index line. */
function describe(rendered: string): string {
    const lines = rendered.split('\n');
    let inFence = false;
    let inContainer = false;
    let past = false;
    const paragraph: string[] = [];
    for (const line of lines) {
        if (line.startsWith('```')) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        if (line.startsWith(':::')) {
            inContainer = line.trim() !== ':::';
            continue;
        }
        if (inContainer) continue;
        if (line.startsWith('# ')) {
            past = true;
            continue;
        }
        if (!past) continue;
        if (line.trim() === '' || /^[#>|]|^[-*] /.test(line)) {
            if (paragraph.length > 0) break;
            continue;
        }
        paragraph.push(line.trim());
    }
    const plain = paragraph
        .join(' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*`]/g, '')
        .trim();
    const sentence = /^(.*?[.!?])(\s|$)/.exec(plain);
    const blurb = sentence ? sentence[1] : plain;
    return blurb.length > 220 ? `${blurb.slice(0, 217).replace(/\s+\S*$/, '')}…` : blurb;
}

/**
 * Generate llms.txt, llms-full.txt, and the per-page markdown renditions into
 * `outDir`. `site` is the absolute site URL without a trailing slash
 * (origin + base), owned by config.mts.
 */
export function generateLlmsArtifacts(docsDir: string, outDir: string, site: string): void {
    const groups = sections(site);
    const rendered = new Map<string, { markdown: string; blurb: string }>();

    for (const section of groups) {
        for (const page of section.pages) {
            const { markdown, description } = renderPage(docsDir, page, site);
            rendered.set(page.sourcePath, { markdown, blurb: description ?? describe(markdown) });
            const outPath = join(outDir, page.sourcePath);
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, markdown);
        }
    }

    const header = [
        '# MCP TypeScript SDK',
        '',
        '> The official TypeScript SDK for the Model Context Protocol (MCP): build MCP servers and clients on Node.js, Bun, Deno, and Workers. This is the v2 beta documentation, tracking the 2026-07-28 spec revision.',
        '',
        'Every page below is also served as plain markdown at its `.md` URL — fetch any page directly.',
        ''
    ];

    const index = [...header];
    for (const section of groups) {
        index.push(`## ${section.title}`, '');
        for (const page of section.pages) {
            const blurb = rendered.get(page.sourcePath)!.blurb;
            index.push(`- [${page.title}](${page.mdUrl})${blurb ? `: ${blurb}` : ''}`);
        }
        index.push('');
    }
    index.push(
        '## Optional',
        '',
        `- [llms-full.txt](${site}/llms-full.txt): every page above concatenated into one file`,
        `- [API reference](${site}/api/): generated per-package API reference`,
        '- [MCP specification](https://modelcontextprotocol.io/specification/latest)',
        '- [v1 documentation](https://ts.sdk.modelcontextprotocol.io/)',
        ''
    );
    writeFileSync(join(outDir, 'llms.txt'), index.join('\n'));

    // A separator no page body contains ('---' appears in the guides as a
    // thematic break, so it cannot delimit pages unambiguously).
    const separator = '='.repeat(80);
    const full = [...header];
    for (const section of groups) {
        for (const page of section.pages) {
            full.push(separator, `Source: ${page.mdUrl}`, separator, '', rendered.get(page.sourcePath)!.markdown.trimEnd(), '');
        }
    }
    writeFileSync(join(outDir, 'llms-full.txt'), full.join('\n'));

    console.log(`[docs] llms.txt, llms-full.txt, and ${rendered.size} markdown renditions written`);
}
