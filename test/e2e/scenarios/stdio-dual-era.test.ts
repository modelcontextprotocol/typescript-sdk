/**
 * Self-contained test bodies for dual-era stdio serving.
 *
 * Like the other transport:stdio scenarios these do not use `wire()`: each
 * body spawns the dual-era fixture server in
 * `fixtures/dual-era-stdio-server.ts` (eraSupport: 'dual-era', unchanged
 * StdioServerTransport) as a real child process via {@link StdioClientTransport}.
 * The matrix `transport` arg is ignored (the requirement lists
 * `transports: ['stdio']`); the spec-version axis selects which client drives
 * the cell — a plain 2025 client over `initialize`, or the auto-negotiating
 * client reaching 2026-07-28 over `server/discover` on the same kind of pipe.
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
        // Legacy leg: a plain 2025 client is served via initialize, exactly as
        // against an undeclared server.
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
    // server/discover on the pipe (no initialize is ever written) and
    // tools/call round-trips with the per-request envelope.
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
