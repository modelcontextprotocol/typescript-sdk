/**
 * Connects to `./server.ts` and walks the host side of MCP skills: list the
 * catalog, load a skill (its SKILL.md, verified), follow a reference, browse
 * a skill folder, and catch a verification failure.
 *
 * Spawns the sibling `server.ts` over stdio by default, or connects to a
 * running endpoint under `--http <url>`. See `examples/CONTRIBUTING.md` for
 * the canonical shape.
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SkillsClient, SkillVerificationError } from '@modelcontextprotocol/client/ext/skills';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const { transport, url, era } = parseExampleArgs();

const client = new Client(
    { name: 'skills-example-client', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } }
);

await client.connect(
    transport === 'stdio'
        ? new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] })
        : new StreamableHTTPClientTransport(new URL(url))
);

const skills = new SkillsClient(client);
check.ok(skills.supported);

// 1. List: entries only (frontmatter, file list, digests). No skill file is read yet.
const { skills: entries, invalid } = await skills.list();
console.log(`[client] ${era} leg: ${entries.map(entry => entry.frontmatter.name).join(', ')}`);
check.deepEqual(invalid, []);
check.deepEqual(
    entries.map(entry => entry.uri),
    [
        'skill://examples/acme/billing/refunds/SKILL.md',
        'skill://examples/acme/billing/refunds/escalation/SKILL.md',
        'skill://examples/git-workflow/SKILL.md'
    ]
);

// 2. Load a skill: SKILL.md is checked for size, digest and frontmatter before you use it.
const { skill: git } = await skills.get('skill://examples/git-workflow/SKILL.md');
const manifest = await skills.read(git);
check.equal(manifest.verified, true);
check.equal(manifest.frontmatter?.['name'], 'git-workflow');
check.match(manifest.body ?? '', /review checklist/);

// 3. Follow a reference: the relative path resolves against the skill folder and is verified too.
const review = await skills.read(git, 'references/REVIEW.md');
check.match(review.text ?? '', /# Review checklist/);

// 4. Browse a skill folder (the server declares directoryRead).
check.ok(skills.directoryRead);
const { resources: children } = await skills.readDirectory('skill://examples/acme/billing/refunds');
check.deepEqual(
    children.map(child => child.name),
    ['SKILL.md', 'escalation', 'templates']
);

// 5. A failed check is an error, never content: here, an entry whose frontmatter was altered.
const altered = { ...git, frontmatter: { ...git.frontmatter, description: 'Something else.' } };
await check.rejects(skills.read(altered), (error: unknown) => error instanceof SkillVerificationError && error.reason === 'frontmatter');

console.log(`[client] ${era} leg: loaded ${git.frontmatter.name}, followed 1 reference, verification failure caught`);
await client.close();
