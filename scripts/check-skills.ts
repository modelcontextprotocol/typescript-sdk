#!/usr/bin/env tsx
/**
 * Check the agent skills under `skills/` against the Agent Skills spec
 * (https://agentskills.io/specification) and their own links:
 *
 * - `name` matches the skill's directory and the spec's character rules;
 *   `description` is 1–1024 characters; SKILL.md stays under 500 lines.
 * - Every relative link resolves inside the skill — file and `#anchor`, using
 *   GitHub's heading slugs as GitHub and skills.sh render them. A skill is
 *   installed on its own, so anything outside it is linked by absolute URL.
 *
 * Run: pnpm check:skills
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { githubSlug } from '../docs/.vitepress/skill';

const ROOT = resolve(import.meta.dirname, '..');
const SKILLS = join(ROOT, 'skills');

/** Lines outside fenced code blocks. */
function prose(markdown: string): string[] {
    let fenced = false;
    return markdown.split('\n').filter(line => {
        if (/^\s*```/.test(line)) fenced = !fenced;
        return !fenced && !/^\s*```/.test(line);
    });
}

function anchors(file: string): Set<string> {
    return new Set(
        prose(readFileSync(file, 'utf8')).flatMap(line => (/^#{1,6} (.*)$/.exec(line) ? [githubSlug(line.replace(/^#+ /, ''))] : []))
    );
}

/** A single-line frontmatter value, unquoted. */
function field(frontmatter: string, key: string): string | undefined {
    const raw = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(frontmatter)?.[1]?.trim();
    if (raw?.startsWith("'")) return raw.slice(1, -1).replaceAll("''", "'");
    if (raw?.startsWith('"')) return JSON.parse(raw) as string;
    return raw;
}

function markdownFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return markdownFiles(path);
        return entry.name.endsWith('.md') ? [path] : [];
    });
}

const errors: string[] = [];

for (const name of readdirSync(SKILLS)) {
    const dir = join(SKILLS, name);
    const skillMd = join(dir, 'SKILL.md');
    if (!existsSync(skillMd)) {
        errors.push(`skills/${name}: no SKILL.md`);
        continue;
    }
    const text = readFileSync(skillMd, 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
    const skillName = field(frontmatter, 'name');
    const description = field(frontmatter, 'description') ?? '';
    if (skillName !== name) errors.push(`skills/${name}/SKILL.md: name "${skillName}" must match the directory name`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64)
        errors.push(`skills/${name}: name must be ≤64 of a-z, 0-9 and single hyphens`);
    if (description.length === 0 || description.length > 1024)
        errors.push(`skills/${name}/SKILL.md: description is ${description.length} characters (1–1024)`);
    const lines = text.split('\n').length;
    if (lines > 500) errors.push(`skills/${name}/SKILL.md: ${lines} lines; move detail into references/ (limit 500)`);

    for (const file of markdownFiles(dir)) {
        const where = relative(ROOT, file);
        for (const line of prose(readFileSync(file, 'utf8'))) {
            for (const [, target] of line.matchAll(/\]\(([^)\s]+)\)/g)) {
                if (/^[a-z]+:/i.test(target!)) continue;
                const [path, anchor] = target!.split('#');
                const linked = path ? resolve(dirname(file), path) : file;
                if (relative(dir, linked).startsWith('..')) {
                    errors.push(`${where}: ${target} leaves the skill; link it by absolute URL`);
                } else if (!existsSync(linked)) {
                    errors.push(`${where}: ${target} does not exist`);
                } else if (anchor && !anchors(linked).has(anchor)) {
                    errors.push(`${where}: ${target} has no matching heading`);
                }
            }
        }
    }
}

if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
}
console.log(`[skills] ${readdirSync(SKILLS).length} skill(s) OK`);
