/**
 * Runnable stdio MCP server fixture for the transport:stdio:* e2e tests.
 *
 * Spawned as a real child process by test/e2e/scenarios/stdio.ts. Registers a
 * single `echo` tool, writes a readiness marker line to stderr once it is
 * serving, and — when E2E_IGNORE_SIGTERM=1 — keeps running after stdin EOF and
 * swallows SIGTERM so the client transport's shutdown escalation
 * (stdin EOF → SIGTERM → SIGKILL) is observable.
 */

/* eslint-disable unicorn/no-process-exit -- standalone spawned executable; exit codes are the behavior under test */

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';

const server = new McpServer({ name: 'stdio-echo-server', version: '1.0.0' });

server.registerTool(
    'echo',
    {
        description: 'Echoes the input text back as a text content block, including multi-line text.',
        inputSchema: z.object({ text: z.string() })
    },
    ({ text }) => ({ content: [{ type: 'text', text }] })
);

// env-report tool: returns JSON array of environment variable names (sorted) that
// reached the child process. This allows tests to verify the env safelist behavior.
server.registerTool(
    'env-report',
    {
        description: 'Returns sorted array of environment variable names present in this process.',
        inputSchema: z.object({})
    },
    () => {
        const envKeys = Object.keys(process.env).toSorted();
        return { content: [{ type: 'text', text: JSON.stringify(envKeys) }] };
    }
);

if (process.env.E2E_IGNORE_SIGTERM === '1') {
    // Misbehaving-server mode: keep alive after stdin EOF via interval (load-bearing — without it the child exits on stdin EOF and SIGTERM never arrives) and ignore SIGTERM, so only SIGKILL can end the process.
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(1), 30_000);
    process.on('SIGTERM', () => {
        process.stderr.write('[stdio-server] sigterm ignored\n');
    });
}

if (process.env.E2E_GARBAGE_STDOUT === '1') {
    // Broken-server mode: write non-JSON garbage to stdout before the server connects, simulating a broken or misconfigured server that pollutes the JSON-RPC channel.
    process.stdout.write('GARBAGE LINE 1: not json\n');
    process.stdout.write('GARBAGE LINE 2: {malformed json\n');
    process.stdout.write('GARBAGE LINE 3: also not valid jsonrpc\n');
    // Valid JSON but not a valid JSON-RPC message: v2 silently skips non-JSON noise, but schema-invalid messages must still surface via onerror.
    process.stdout.write('{"jsonrpc":"1.0","bogus":true}\n');
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
    setTimeout(() => process.exit(1), 30_000);
} else {
    await server.connect(new StdioServerTransport());
    process.stderr.write('[stdio-server] ready\n');
}
