/**
 * Self-contained test bodies for the roots surface.
 *
 * Roots are a client capability: the client exposes filesystem roots to the
 * server. The server can request them via `roots/list`, and the client notifies
 * the server when roots change via `notifications/roots/list_changed`.
 */

import { Client } from '@modelcontextprotocol/client';
import type { ListRootsResult } from '@modelcontextprotocol/server';
import { McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { wire } from '../helpers/index';
import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

verifies('roots:list:basic', async ({ transport }: TestArgs) => {
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
    client.setRequestHandler('roots/list', async req => {
        received.push({ method: req.method });
        return {
            roots: [{ uri: 'file:///home/user/projects/myproject', name: 'My Project' }, { uri: 'file:///home/user/repos/backend' }]
        };
    });

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'list-roots', arguments: {} });

    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe('roots/list');

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
        ok: true,
        result: {
            roots: [{ uri: 'file:///home/user/projects/myproject', name: 'My Project' }, { uri: 'file:///home/user/repos/backend' }]
        }
    });
});

verifies('roots:list:empty', async ({ transport }: TestArgs) => {
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
    client.setRequestHandler('roots/list', async () => ({ roots: [] }));

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'list-roots', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(results).toHaveLength(1);
    expect(results[0]?.roots).toEqual([]);
});

verifies('roots:list:client-error', async ({ transport }: TestArgs) => {
    const failures: ProtocolError[] = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('list-roots', { inputSchema: z.object({}) }, async () => {
            try {
                await s.server.listRoots();
                return { content: [{ type: 'text', text: 'unexpected success' }] };
            } catch (error) {
                if (error instanceof ProtocolError) failures.push(error);
                return { content: [{ type: 'text', text: 'rejected' }] };
            }
        });
        return s;
    };

    const client = new Client({ name: 'c', version: '0' }, { capabilities: { roots: {} } });
    client.setRequestHandler('roots/list', async () => {
        throw new ProtocolError(ProtocolErrorCode.InternalError, 'roots provider crashed');
    });

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'list-roots', arguments: {} });

    // The handler observed a rejection (not a hang or a malformed result), and it was a ProtocolError.
    expect(result.content).toEqual([{ type: 'text', text: 'rejected' }]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe(ProtocolErrorCode.InternalError);
    expect(failures[0]?.message).toMatch(/roots provider crashed/);
});

verifies('roots:list:not-supported', async ({ transport }: TestArgs) => {
    const failures: ProtocolError[] = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('list-roots', { inputSchema: z.object({}) }, async () => {
            try {
                await s.server.listRoots();
                return { content: [{ type: 'text', text: 'unexpected success' }] };
            } catch (error) {
                if (error instanceof ProtocolError) failures.push(error);
                return { content: [{ type: 'text', text: 'rejected' }] };
            }
        });
        return s;
    };

    // The client deliberately declares no roots capability and registers no roots/list handler.
    const client = new Client({ name: 'c', version: '0' });

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'list-roots', arguments: {} });

    expect(result.content).toEqual([{ type: 'text', text: 'rejected' }]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe(ProtocolErrorCode.MethodNotFound);
    expect(failures[0]?.message).toMatch(/Method not found/);
});

verifies('roots:list-changed', async ({ transport }: TestArgs) => {
    const refetched: ListRootsResult[] = [];
    const makeServer = () => {
        const server = new McpServer({ name: 's', version: '0' });
        server.server.setNotificationHandler('notifications/roots/list_changed', async () => {
            refetched.push(await server.server.listRoots());
        });
        return server;
    };

    let roots = [{ uri: 'file:///home/user/projects/a', name: 'A' }];
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { roots: { listChanged: true } } });
    client.setRequestHandler('roots/list', async () => ({ roots }));

    await using _ = await wire(transport, makeServer, client);

    // Change roots, signal the server, and observe the server's re-request
    // returning the *new* roots.
    roots = [
        { uri: 'file:///home/user/projects/a', name: 'A' },
        { uri: 'file:///home/user/projects/b', name: 'B' }
    ];
    await client.sendRootsListChanged();
    await vi.waitFor(() => expect(refetched).toHaveLength(1));
    expect(refetched[0]?.roots).toEqual(roots);

    roots = [{ uri: 'file:///home/user/projects/b', name: 'B' }];
    await client.sendRootsListChanged();
    await vi.waitFor(() => expect(refetched).toHaveLength(2));
    expect(refetched[1]?.roots).toEqual(roots);
});
