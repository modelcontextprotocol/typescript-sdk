/**
 * Self-contained test bodies for dual-era stdio serving.
 *
 * Like the other transport:stdio scenarios these do not use `wire()`: each
 * body spawns the dual-era fixture server in
 * `fixtures/dual-era-stdio-server.ts` (the connection-pinned `serveStdio`
 * entry over an ordinary McpServer factory) as a real child process via
 * {@link StdioClientTransport}. The matrix `transport` arg is ignored (the
 * requirement lists `transports: ['stdio']`); the spec-version axis selects
 * which client opens the connection — a plain 2025 client over `initialize`,
 * or the auto-negotiating client reaching 2026-07-28 over `server/discover` —
 * and the entry pins that connection's instance to the era the client opened
 * with.
 */

import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { expect } from 'vitest';

import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

/** Absolute path to the runnable dual-era fixture server (executed with tsx). */
const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/dual-era-stdio-server.ts', import.meta.url));

/** E2E package root — spawn cwd so node/tsx resolve the local toolchain and workspace packages. */
const E2E_ROOT = fileURLToPath(new URL('../', import.meta.url));

const MODERN = '2026-07-28';

verifies('typescript:transport:stdio:dual-era-serving', async ({ protocolVersion }: TestArgs) => {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', FIXTURE_PATH],
        cwd: E2E_ROOT
    });

    if (protocolVersion === '2025-11-25') {
        // Legacy leg: a plain 2025 client opens with initialize and the entry
        // pins the connection to a 2025-era instance, served exactly as a
        // hand-wired stdio server serves it today.
        const client = new Client({ name: 'plain-2025-client', version: '0' });
        try {
            await client.connect(transport);
            expect(client.getNegotiatedProtocolVersion()).toBe(protocolVersion);
            const result = await client.callTool({ name: 'echo', arguments: { text: 'legacy leg' } });
            expect(result.isError).toBeFalsy();
            expect(result.content).toEqual([{ type: 'text', text: 'legacy leg' }]);
        } finally {
            await client.close();
            await transport.close();
        }
        return;
    }

    // Modern leg: the auto-negotiating client reaches 2026-07-28 via
    // server/discover on the pipe (no initialize is ever written), the entry
    // pins the connection to a 2026-era instance, and tools/call round-trips
    // with the per-request envelope.
    const sentMethods: string[] = [];
    const originalSend = transport.send.bind(transport);
    transport.send = async message => {
        if ('method' in message) sentMethods.push(message.method);
        return originalSend(message);
    };

    const client = new Client({ name: 'auto-client', version: '0' }, { versionNegotiation: { mode: 'auto' } });
    try {
        await client.connect(transport);
        expect(client.getNegotiatedProtocolVersion()).toBe(protocolVersion);
        expect(sentMethods).not.toContain('initialize');
        expect(sentMethods[0]).toBe('server/discover');

        const envelope = {
            [PROTOCOL_VERSION_META_KEY]: MODERN,
            [CLIENT_INFO_META_KEY]: { name: 'auto-client', version: '0' },
            [CLIENT_CAPABILITIES_META_KEY]: {}
        };
        const result = (await client.request({
            method: 'tools/call',
            params: { name: 'echo', arguments: { text: 'modern leg' }, _meta: envelope }
        })) as CallToolResult;
        expect(result.content).toEqual([{ type: 'text', text: 'modern leg' }]);
    } finally {
        await client.close();
        await transport.close();
    }
});
