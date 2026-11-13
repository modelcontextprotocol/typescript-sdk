/**
 * Skills (SEP-2640) served by the conformance server, built with the SDK's
 * own API. Started as typescript-sdk#2797 (tobi-oye). `pageSize: 1` makes
 * skills/list and resources/directory/read page, so the pagination checks run.
 */
import { memorySkillFiles, SkillsExtension } from '@modelcontextprotocol/server/ext/skills';

export const conformanceSkills = await SkillsExtension.load(
    memorySkillFiles({
        'pdf-processing/SKILL.md': `---
name: pdf-processing
description: Extract, fill, and assemble PDF documents.
metadata:
  author: mcp-conformance
---
# PDF processing

Read references/FORMS.md before filling a form.
`,
        'pdf-processing/references/FORMS.md': `# Forms

Fill the fields from top to bottom.
`,
        'pdf-processing/scripts/extract.py': 'print("extract")\n',
        'acme/billing/refunds/SKILL.md': `---
name: refunds
description: Process customer refunds.
---
# Refunds
`,
        'acme/billing/refunds/templates/refund-email.md': 'Your refund is on its way.\n'
    }),
    { pageSize: 1, strict: true }
);
