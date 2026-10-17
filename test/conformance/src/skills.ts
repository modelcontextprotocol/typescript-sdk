/**
 * Skills (SEP-2640) served by the conformance server, built with the SDK's
 * own API. Started as typescript-sdk#2797 (tobi-oye). `pageSize: 1` makes
 * skills/list and resources/directory/read page, so the pagination checks run.
 */
import { memorySkillFiles, SkillsExtension } from '@modelcontextprotocol/server/ext/skills';

export const conformanceSkills = await SkillsExtension.load(
    memorySkillFiles({
        'pdf-processing/SKILL.md':
            '---\nname: pdf-processing\ndescription: Extract, fill, and assemble PDF documents.\nmetadata:\n  author: mcp-conformance\n---\n' +
            '# PDF processing\n\nRead references/FORMS.md before filling a form.\n',
        'pdf-processing/references/FORMS.md': '# Forms\n\nFill the fields from top to bottom.\n',
        'pdf-processing/scripts/extract.py': 'print("extract")\n',
        'acme/billing/refunds/SKILL.md': '---\nname: refunds\ndescription: Process customer refunds.\n---\n# Refunds\n',
        'acme/billing/refunds/templates/refund-email.md': 'Your refund is on its way.\n'
    }),
    { pageSize: 1, strict: true }
);
