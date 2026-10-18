export const GIT_SKILL_MD = `---
name: git-workflow
description: Branching and review conventions.
---
# Git workflow

See references/REVIEW.md.
`;
/** Windows-authored: UTF-8 BOM and CRLF line endings. */
export const REFUNDS_SKILL_MD = '﻿---\r\nname: refunds\r\ndescription: Refund workflow.\r\n---\r\n# Refunds\r\n';
export const ESCALATION_SKILL_MD = `---
name: escalation
description: Escalate a refund.
---
# Escalation
`;
export const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

export const GIT = 'skill://git-workflow/SKILL.md';
export const REFUNDS = 'skill://acme/billing/refunds/SKILL.md';
export const ESCALATION = 'skill://acme/billing/refunds/escalation/SKILL.md';
export const LOGO = 'skill://acme/billing/refunds/assets/logo.png';
export const PURCHASE_ORDER = 'skill://acme/billing/refunds/templates/Purchase%20Order.md';
export const REMBOURSE = 'skill://acme/billing/refunds/templates/Rembours%C3%A9.md';

/**
 * A fresh, mutable file map: two top-level skills, a nested skill under an
 * organisational prefix, file names with a space and a non-ASCII letter, a
 * binary file and hidden files.
 */
export function fixtureFiles(): Record<string, string | Uint8Array> {
    return {
        'git-workflow/SKILL.md': GIT_SKILL_MD,
        'git-workflow/references/REVIEW.md': '# Review\n',
        'git-workflow/.private-notes.md': 'hidden',
        'acme/billing/refunds/SKILL.md': REFUNDS_SKILL_MD,
        'acme/billing/refunds/templates/Purchase Order.md': '# PO\n',
        'acme/billing/refunds/templates/Remboursé.md': '# Remboursement\n',
        'acme/billing/refunds/assets/logo.png': PNG,
        'acme/billing/refunds/escalation/SKILL.md': ESCALATION_SKILL_MD,
        '.DS_Store': 'junk'
    };
}
