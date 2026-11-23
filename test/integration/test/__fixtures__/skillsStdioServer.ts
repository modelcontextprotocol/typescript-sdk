/**
 * A skills server over stdio: `loadSkills(<folder from argv>)` once, attached
 * to every server the dual-era `serveStdio` entry creates. Spawned by
 * `test/skills/skillsEndToEnd.test.ts`.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const root = process.argv[2];
if (root === undefined) throw new Error('usage: skillsStdioServer.ts <skills folder>');

const skills = await loadSkills(root);
const handle = serveStdio(() => {
    const mcp = new McpServer({ name: 'skills-stdio-fixture', version: '1.0.0' });
    skills.attach(mcp);
    return mcp;
});

const exit = async () => {
    await handle.close();
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(0);
};

process.on('SIGINT', exit);
process.on('SIGTERM', exit);
