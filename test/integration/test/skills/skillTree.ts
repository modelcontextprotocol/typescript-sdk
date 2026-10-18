import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

/**
 * A skills folder with everything that tends to break: a Windows-authored
 * SKILL.md (BOM + CRLF), a nested skill under organisational folders, a file
 * name with a space and a binary file. Written to a temp dir at test time, so
 * no formatter or git line-ending rule can touch the bytes.
 */
export const SKILL_TREE: Readonly<Record<string, string | Uint8Array>> = {
    'git-workflow/SKILL.md': `---
name: git-workflow
description: Branching and review conventions.
---
# Git workflow

Read references/REVIEW.md before opening a PR.
`,
    'git-workflow/references/REVIEW.md': `# Review

- tests pass
`,
    'acme/billing/refunds/SKILL.md': '﻿---\r\nname: refunds\r\ndescription: Refund workflow.\r\n---\r\n# Refunds\r\n',
    'acme/billing/refunds/templates/Purchase Order.md': '# PO\n',
    'acme/billing/refunds/assets/logo.png': PNG,
    'acme/billing/refunds/escalation/SKILL.md': `---
name: escalation
description: Escalate a refund.
---
# Escalation
`
};

export const GIT = 'skill://git-workflow/SKILL.md';
export const REFUNDS = 'skill://acme/billing/refunds/SKILL.md';
export const ESCALATION = 'skill://acme/billing/refunds/escalation/SKILL.md';
export const PURCHASE_ORDER = 'skill://acme/billing/refunds/templates/Purchase%20Order.md';

/** Writes `files` under a fresh temp dir and returns its path. */
export async function writeSkillTree(files: Readonly<Record<string, string | Uint8Array>> = SKILL_TREE): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'mcp-skills-it-'));
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(root, ...relative.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
    }
    return root;
}
