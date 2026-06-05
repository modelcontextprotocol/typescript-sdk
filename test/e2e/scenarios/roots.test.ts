/**
 * Self-contained test bodies for the roots surface.
 *
 * Roots are a client capability: the client exposes filesystem roots to the
 * server. The server can request them via `roots/list`, and the client notifies
 * the server when roots change via `notifications/roots/list_changed`.
 */

import { expect, vi } from 'vitest';

import { z } from 'zod/v4';

import { Client } from '../../../src/client/index.js';
import { McpServer } from '../../../src/server/mcp.js';
import {
    ErrorCode,
    type ListRootsResult,
    ListRootsRequestSchema,
    McpError,
    RootsListChangedNotificationSchema
} from '../../../src/types.js';

import { wire } from '../helpers/index.js';
import type { TestArgs } from '../types.js';
import { verifies } from '../helpers/verifies.js';

verifies('roots:list:basic', async ({ transport, protocolVersion }: TestArgs) => {
    const received: Array<{ method: string }> = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        // Drive the server→client call via the typed Server.listRoots() helper —
        // this is the user-facing API and exercises the capability check.
        s.registerTool('list-roots', { inputSchema: z.object({}) }, async () => {
            const result = await s.server.listRoots();
            return { structuredContent: { ok: true, result }, content: [] };
        });
        return s;
    };

    const client = new Client({ name: 'c', version: '0' }, { capabilities: { roots: { listChanged: true } } });
    client.setRequestHandler(ListRootsRequestSchema, async req => {
        received.push({ method: req.method });
        return {
            roots: [{ uri: 'file:///home/user/projects/myproject', name: 'My Project' }, { uri: 'file:///home/user/repos/backend' }]
        };
    });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const result = await client.callTool({ name: 'list-roots', arguments: {} });

    expect(received).toHaveLength(1);
    expect(received[0].method).toBe('roots/list');

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
        ok: true,
        result: {
            roots: [{ uri: 'file:///home/user/projects/myproject', name: 'My Project' }, { uri: 'file:///home/user/repos/backend' }]
        }
    });
});

verifies('roots:list:empty', async ({ transport, protocolVersion }: TestArgs) => {
    const results: ListRootsResult[] = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('list-roots', { inputSchema: z.object({}) }, async () => {
            results.push(await s.server.listRoots());
            return { content: [{ type: 'text', text: 'ok' }] };
        });
        return s;
    };

    // The client supports roots but currently has none to offer.
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [] }));

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const result = await client.callTool({ name: 'list-roots', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(results).toHaveLength(1);
    expect(results[0].roots).toEqual([]);
});

verifies('roots:list:client-error', async ({ transport, protocolVersion }: TestArgs) => {
    const failures: McpError[] = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('list-roots', { inputSchema: z.object({}) }, async () => {
            try {
                await s.server.listRoots();
                return { content: [{ type: 'text', text: 'unexpected success' }] };
            } catch (e) {
                if (e instanceof McpError) failures.push(e);
                return { content: [{ type: 'text', text: 'rejected' }] };
            }
        });
        return s;
    };

    const client = new Client({ name: 'c', version: '0' }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, async () => {
        throw new McpError(ErrorCode.InternalError, 'roots provider crashed');
    });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const result = await client.callTool({ name: 'list-roots', arguments: {} });

    // The handler observed a rejection (not a hang or a malformed result), and it was an McpError.
    expect(result.content).toEqual([{ type: 'text', text: 'rejected' }]);
    expect(failures).toHaveLength(1);
    expect(failures[0].code).toBe(ErrorCode.InternalError);
    expect(failures[0].message).toMatch(/roots provider crashed/);
});

verifies('roots:list:not-supported', async ({ transport, protocolVersion }: TestArgs) => {
    const failures: McpError[] = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('list-roots', { inputSchema: z.object({}) }, async () => {
            try {
                await s.server.listRoots();
                return { content: [{ type: 'text', text: 'unexpected success' }] };
            } catch (e) {
                if (e instanceof McpError) failures.push(e);
                return { content: [{ type: 'text', text: 'rejected' }] };
            }
        });
        return s;
    };

    // The client deliberately declares no roots capability and registers no roots/list handler.
    const client = new Client({ name: 'c', version: '0' });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const result = await client.callTool({ name: 'list-roots', arguments: {} });

    expect(result.content).toEqual([{ type: 'text', text: 'rejected' }]);
    expect(failures).toHaveLength(1);
    expect(failures[0].code).toBe(ErrorCode.MethodNotFound);
    expect(failures[0].message).toMatch(/Method not found/);
});

verifies('roots:list-changed', async ({ transport, protocolVersion }: TestArgs) => {
    const refetched: ListRootsResult[] = [];
    let server!: McpServer;
    const makeServer = () => {
        server = new McpServer({ name: 's', version: '0' });
        server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
            refetched.push(await server.server.listRoots());
        });
        return server;
    };

    let roots = [{ uri: 'file:///home/user/projects/a', name: 'A' }];
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { roots: { listChanged: true } } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots }));

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    // Change roots, signal the server, and observe the server's re-request
    // returning the *new* roots.
    roots = [
        { uri: 'file:///home/user/projects/a', name: 'A' },
        { uri: 'file:///home/user/projects/b', name: 'B' }
    ];
    await client.sendRootsListChanged();
    await vi.waitFor(() => expect(refetched).toHaveLength(1));
    expect(refetched[0].roots).toEqual(roots);

    roots = [{ uri: 'file:///home/user/projects/b', name: 'B' }];
    await client.sendRootsListChanged();
    await vi.waitFor(() => expect(refetched).toHaveLength(2));
    expect(refetched[1].roots).toEqual(roots);
});
