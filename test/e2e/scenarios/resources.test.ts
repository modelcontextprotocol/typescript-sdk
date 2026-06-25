/**
 * Self-contained test bodies for the resources surface.
 *
 * Each export is a TestCase: it builds its own server (via a factory), builds
 * its own client, wires them with wire(), and asserts. Function names mirror
 * the requirement id in camelCase. Bodies that inspect server-side state
 * declare the recorder outside the factory so every server instance closes
 * over the same array.
 */

import { Client } from '@modelcontextprotocol/client';
import type { RegisteredResource } from '@modelcontextprotocol/server';
import { McpServer, ProtocolError, ProtocolErrorCode, ResourceTemplate, Server } from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';

import { wire } from '../helpers/index';
import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const FIXTURE_LAST_MODIFIED = '2024-01-15T10:30:00.000Z';

const newClient = () => new Client({ name: 'c', version: '0' });

verifies('resources:list:basic', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerResource('text', 'file:///fixture.txt', { description: 'A plain-text resource.', mimeType: 'text/plain' }, () => ({
            contents: [{ uri: 'file:///fixture.txt', mimeType: 'text/plain', text: 'hello, world' }]
        }));
        s.registerResource('blob', 'file:///fixture.png', { description: 'A 1×1 PNG.', mimeType: 'image/png' }, () => ({
            contents: [{ uri: 'file:///fixture.png', mimeType: 'image/png', blob: TINY_PNG_BASE64 }]
        }));
        s.registerResource('annotated', 'file:///annotated.md', { description: 'Annotated.', mimeType: 'text/markdown' }, () => ({
            contents: [{ uri: 'file:///annotated.md', mimeType: 'text/markdown', text: '# Annotated' }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const result = await client.listResources();

    expect(result.resources).toHaveLength(3);
    expect(result.resources.map(r => r.uri).toSorted()).toEqual(['file:///annotated.md', 'file:///fixture.png', 'file:///fixture.txt']);

    expect(result.resources.find(r => r.uri === 'file:///fixture.txt')).toMatchObject({
        uri: 'file:///fixture.txt',
        name: 'text',
        description: 'A plain-text resource.',
        mimeType: 'text/plain'
    });

    expect(result.resources.find(r => r.uri === 'file:///fixture.png')).toMatchObject({
        uri: 'file:///fixture.png',
        name: 'blob',
        description: 'A 1×1 PNG.',
        mimeType: 'image/png'
    });
});

verifies(
    'resources:list:pagination',
    async ({ transport }: TestArgs) => {
        const TOTAL = 25;
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            for (let i = 0; i < TOTAL; i++) {
                s.registerResource(
                    `bulk_${String(i).padStart(2, '0')}`,
                    `bulk://item/${String(i).padStart(2, '0')}`,
                    { mimeType: 'text/plain' },
                    uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: '' }] })
                );
            }
            return s;
        };
        const client = newClient();
        await using _ = await wire(transport, makeServer, client);

        // No-arg listResources() auto-aggregates every page.
        const all = await client.listResources();
        expect(all.resources.length).toBe(TOTAL);
        expect(all.nextCursor).toBeUndefined();
        expect(new Set(all.resources.map(r => r.uri)).size).toBe(TOTAL);
    },
    { title: 'mcpserver' }
);

verifies(
    'resources:list:pagination',
    async ({ transport }: TestArgs) => {
        const TOTAL = 25;
        const PAGE = 10;
        const all = Array.from({ length: TOTAL }, (_, i) => `bulk://item/${String(i).padStart(2, '0')}`);
        const cursorsReceived: Array<string | undefined> = [];

        const makeServer = () => {
            const s = new Server({ name: 's', version: '0' }, { capabilities: { resources: { listChanged: true } } });
            s.setRequestHandler('resources/list', req => {
                cursorsReceived.push(req.params?.cursor);
                const start = req.params?.cursor === undefined ? 0 : Number.parseInt(req.params.cursor, 10);
                const slice = all.slice(start, start + PAGE);
                return {
                    resources: slice.map(uri => ({ uri, name: uri, mimeType: 'text/plain' })),
                    nextCursor: start + PAGE < TOTAL ? String(start + PAGE) : undefined
                };
            });
            s.setRequestHandler('resources/read', () => ({ contents: [] }));
            return s;
        };
        const client = newClient();
        await using _ = await wire(transport, makeServer, client);

        // No-arg listResources() auto-aggregates every page; the server
        // receives the cursor walk verbatim (protocol-level pagination is
        // what is verified here).
        const result = await client.listResources();
        expect(result.nextCursor).toBeUndefined();
        const seen = new Set(result.resources.map(r => r.uri));
        expect(seen.size).toBe(TOTAL);
        for (const name of all) expect(seen.has(name)).toBe(true);
        expect(cursorsReceived).toEqual([undefined, '10', '20']);

        // Explicit cursor → one raw page (per-page path).
        const page = await client.listResources({ cursor: '10' });
        expect(page.resources.length).toBe(PAGE);
        expect(page.nextCursor).toBe('20');
    },
    { title: 'raw server' }
);

verifies('resources:read:text', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerResource('text', 'file:///fixture.txt', { mimeType: 'text/plain' }, () => ({
            contents: [{ uri: 'file:///fixture.txt', mimeType: 'text/plain', text: 'hello, world' }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const result = await client.readResource({ uri: 'file:///fixture.txt' });
    expect(result.contents).toHaveLength(1);

    const [entry] = result.contents;
    if (entry === undefined) throw new Error('expected exactly one content entry');
    expect(entry.uri).toBe('file:///fixture.txt');
    expect(entry.mimeType).toBe('text/plain');
    expect('text' in entry && entry.text).toBe('hello, world');
    expect(entry).not.toHaveProperty('blob');
});

verifies('resources:read:blob', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerResource('blob', 'file:///fixture.png', { mimeType: 'image/png' }, () => ({
            contents: [{ uri: 'file:///fixture.png', mimeType: 'image/png', blob: TINY_PNG_BASE64 }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const result = await client.readResource({ uri: 'file:///fixture.png' });
    expect(result.contents).toHaveLength(1);

    const [entry] = result.contents;
    expect(entry).toEqual({ uri: 'file:///fixture.png', mimeType: 'image/png', blob: TINY_PNG_BASE64 });
    expect(entry).not.toHaveProperty('text');
});

verifies('resources:read:unknown-uri', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerResource('text', 'file:///exists.txt', { mimeType: 'text/plain' }, () => ({
            contents: [{ uri: 'file:///exists.txt', mimeType: 'text/plain', text: 'ok' }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    let received: ProtocolError | undefined;
    try {
        const result = await client.readResource({ uri: 'file:///no-such-resource' });
        // MUST-NOT rider: never an empty contents array for a non-existent resource.
        expect(result.contents).not.toEqual([]);
    } catch (error) {
        received = error as ProtocolError;
    }
    expect(received).toBeDefined();

    // The wire code is −32602 on every protocol revision (the encode seam owns
    // the −32002 → −32602 mapping), with `data.uri` echoing the requested URI.
    expect(received!.code).toBe(-32_602);
    expect(received!.message).toMatch(/not found/i);
    expect(received!.data).toEqual({ uri: 'file:///no-such-resource' });

    // The cross-bundle data-parse recognizer reconstructs the typed error
    // from code + structurally valid data (no `instanceof` across bundles).
    // It accepts BOTH −32602 and the legacy −32002; the duck shape is `data.uri`.
    const recognised = ProtocolError.fromError(received!.code, received!.message, received!.data);
    expect((recognised as { uri?: string }).uri).toBe('file:///no-such-resource');
    const legacy = ProtocolError.fromError(-32_002, 'Resource not found', { uri: 'file:///x' });
    expect((legacy as { uri?: string }).uri).toBe('file:///x');
    // ProtocolErrorCode.ResourceNotFound (−32002) stays importable as legacy
    // receive-tolerated vocabulary.
    expect(ProtocolErrorCode.ResourceNotFound).toBe(-32_002);
});

verifies('resources:read:template-vars', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerResource(
            'greet',
            new ResourceTemplate('greet://hello/{name}', { list: undefined }),
            { mimeType: 'text/plain' },
            (uri, { name }) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: `Hello, ${name}!` }] })
        );
        s.registerResource(
            'repo',
            new ResourceTemplate('github://{owner}/{repo}', { list: undefined }),
            { mimeType: 'text/plain' },
            (uri, { owner, repo }) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: `${owner}/${repo}` }] })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const greet = await client.readResource({ uri: 'greet://hello/Ada' });
    expect(greet.contents).toEqual([{ uri: 'greet://hello/Ada', mimeType: 'text/plain', text: 'Hello, Ada!' }]);

    const repo = await client.readResource({ uri: 'github://modelcontextprotocol/typescript-sdk' });
    expect(repo.contents).toEqual([
        { uri: 'github://modelcontextprotocol/typescript-sdk', mimeType: 'text/plain', text: 'modelcontextprotocol/typescript-sdk' }
    ]);
});

verifies('resources:list-changed', async ({ transport }: TestArgs) => {
    let server!: McpServer;
    const makeServer = () => {
        server = new McpServer({ name: 's', version: '0' });
        server.registerResource('seed', 'file:///seed.txt', { mimeType: 'text/plain' }, () => ({
            contents: [{ uri: 'file:///seed.txt', mimeType: 'text/plain', text: 'seed' }]
        }));
        return server;
    };

    let listChanged = 0;
    const client = newClient();
    client.setNotificationHandler('notifications/resources/list_changed', () => {
        listChanged++;
    });

    await using _ = await wire(transport, makeServer, client);

    const initial = await client.listResources();
    expect(initial.resources).toHaveLength(1);

    const handle = server.registerResource('dynamic', 'file:///probe.txt', { mimeType: 'text/plain' }, () => ({
        contents: [{ uri: 'file:///probe.txt', mimeType: 'text/plain', text: 'probe' }]
    }));
    await vi.waitFor(() => expect(listChanged).toBeGreaterThanOrEqual(1));
    const afterAddList = await client.listResources();
    expect(afterAddList.resources).toHaveLength(2);
    const afterAdd = listChanged;

    handle.remove();
    await vi.waitFor(() => expect(listChanged).toBeGreaterThan(afterAdd));
    const afterRemoveList = await client.listResources();
    expect(afterRemoveList.resources).toHaveLength(1);
});

verifies('resources:annotations', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerResource(
            'annotated',
            'file:///annotated.md',
            {
                mimeType: 'text/markdown',
                annotations: { audience: ['user', 'assistant'], priority: 0.8, lastModified: FIXTURE_LAST_MODIFIED }
            },
            () => ({ contents: [{ uri: 'file:///annotated.md', mimeType: 'text/markdown', text: '# Annotated' }] })
        );
        s.registerResource(
            'greet',
            new ResourceTemplate('greet://hello/{name}', { list: undefined }),
            {
                mimeType: 'text/plain',
                annotations: { audience: ['user'], priority: 0.5, lastModified: FIXTURE_LAST_MODIFIED }
            },
            (uri, { name }) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: `Hello, ${name}!` }] })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const { resources } = await client.listResources();
    const resource = resources.find(r => r.uri === 'file:///annotated.md');
    expect(resource).toBeDefined();
    expect(resource?.annotations).toEqual({
        audience: ['user', 'assistant'],
        priority: 0.8,
        lastModified: FIXTURE_LAST_MODIFIED
    });

    const { resourceTemplates } = await client.listResourceTemplates();
    const template = resourceTemplates.find(t => t.name === 'greet');
    expect(template).toBeDefined();
    expect(template?.annotations).toEqual({ audience: ['user'], priority: 0.5, lastModified: FIXTURE_LAST_MODIFIED });

    const result = await client.readResource({ uri: 'file:///annotated.md' });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]?.uri).toBe('file:///annotated.md');
});

verifies('resources:capability:declared', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' }, { capabilities: { resources: {} } });
        s.registerResource('echo', 'file:///echo.txt', { mimeType: 'text/plain' }, () => ({
            contents: [{ uri: 'file:///echo.txt', mimeType: 'text/plain', text: 'echo' }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const caps = client.getServerCapabilities();
    expect(caps?.resources).toBeDefined();
    const list = await client.listResources();
    expect(list.resources).toHaveLength(1);
    expect(caps?.resources?.listChanged).toBe(true);
});

verifies('resources:subscribe:capability-required', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' }, { capabilities: { resources: { listChanged: true } } });
        s.registerResource('text', 'file:///fixture.txt', { mimeType: 'text/plain' }, () => ({
            contents: [{ uri: 'file:///fixture.txt', mimeType: 'text/plain', text: 'hello' }]
        }));
        return s;
    };
    const client = new Client({ name: 'c', version: '0' }, { enforceStrictCapabilities: true });
    await using _ = await wire(transport, makeServer, client);

    const caps = client.getServerCapabilities();
    expect(caps?.resources).toBeDefined();
    expect(caps?.resources?.subscribe).toBeFalsy();

    await expect(client.subscribeResource({ uri: 'file:///fixture.txt' })).rejects.toThrow(/does not support.*subscri/i);
});

verifies('resources:subscribe:updated', async ({ transport }: TestArgs) => {
    let server!: Server;
    const subscriptions = new Set<string>();
    const makeServer = () => {
        server = new Server({ name: 's', version: '0' }, { capabilities: { resources: { listChanged: true, subscribe: true } } });
        server.setRequestHandler('resources/list', () => ({
            resources: [{ uri: 'counter://subscribable', name: 'subscribable', mimeType: 'text/plain' }]
        }));
        server.setRequestHandler('resources/read', () => ({
            contents: [{ uri: 'counter://subscribable', mimeType: 'text/plain', text: 'count' }]
        }));
        server.setRequestHandler('resources/subscribe', req => {
            subscriptions.add(req.params.uri);
            return {};
        });
        return server;
    };

    const updates: string[] = [];
    const client = newClient();
    client.setNotificationHandler('notifications/resources/updated', n => {
        updates.push(n.params.uri);
    });

    await using _ = await wire(transport, makeServer, client);

    await client.subscribeResource({ uri: 'counter://subscribable' });
    expect(subscriptions.has('counter://subscribable')).toBe(true);

    await server.sendResourceUpdated({ uri: 'counter://subscribable' });

    await vi.waitFor(() => expect(updates).toContain('counter://subscribable'));
});

verifies('resources:unsubscribe:stops-updates', async ({ transport }: TestArgs) => {
    let server!: Server;
    const subscriptions = new Set<string>();
    const makeServer = () => {
        server = new Server({ name: 's', version: '0' }, { capabilities: { resources: { listChanged: true, subscribe: true } } });
        server.setRequestHandler('resources/list', () => ({
            resources: [
                { uri: 'counter://target', name: 'target', mimeType: 'text/plain' },
                { uri: 'counter://sentinel', name: 'sentinel', mimeType: 'text/plain' }
            ]
        }));
        server.setRequestHandler('resources/read', () => ({ contents: [] }));
        server.setRequestHandler('resources/subscribe', req => {
            subscriptions.add(req.params.uri);
            return {};
        });
        server.setRequestHandler('resources/unsubscribe', req => {
            subscriptions.delete(req.params.uri);
            return {};
        });
        return server;
    };

    const updates: string[] = [];
    const client = newClient();
    client.setNotificationHandler('notifications/resources/updated', n => {
        updates.push(n.params.uri);
    });

    await using _ = await wire(transport, makeServer, client);

    await client.subscribeResource({ uri: 'counter://target' });
    await client.subscribeResource({ uri: 'counter://sentinel' });

    await server.sendResourceUpdated({ uri: 'counter://target' });
    await vi.waitFor(() => expect(updates.filter(u => u === 'counter://target').length).toBeGreaterThanOrEqual(1));

    await client.unsubscribeResource({ uri: 'counter://target' });
    expect(subscriptions.has('counter://target')).toBe(false);
    updates.length = 0;

    // A user-shaped server only emits updates for URIs that are still
    // subscribed; the SDK provides the send method, the server author owns the
    // subscription set. After unsubscribe, the server should not send for
    // 'target' — so we only send for the sentinel and assert nothing for
    // 'target' arrived while the sentinel update did.
    for (const uri of subscriptions) await server.sendResourceUpdated({ uri });

    await vi.waitFor(() => expect(updates.filter(u => u === 'counter://sentinel').length).toBeGreaterThanOrEqual(1));
    expect(updates.filter(u => u === 'counter://target')).toHaveLength(0);
});

verifies('resources:templates:list', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerResource(
            'greet',
            new ResourceTemplate('greet://hello/{name}', { list: undefined }),
            { description: 'Greets {name}.', mimeType: 'text/plain' },
            (uri, { name }) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: `Hello, ${name}!` }] })
        );
        s.registerResource(
            'listed',
            new ResourceTemplate('listed://items/{id}', {
                list: () => ({ resources: [{ uri: 'listed://items/alpha', name: 'alpha' }] })
            }),
            { mimeType: 'text/plain' },
            (uri, { id }) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: String(id) }] })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const result = await client.listResourceTemplates();

    expect(result.resourceTemplates).toHaveLength(2);
    expect(result.resourceTemplates.map(t => t.name).toSorted()).toEqual(['greet', 'listed']);

    expect(result.resourceTemplates.find(t => t.name === 'greet')).toMatchObject({
        name: 'greet',
        uriTemplate: 'greet://hello/{name}',
        description: 'Greets {name}.',
        mimeType: 'text/plain'
    });

    expect(result.resourceTemplates.find(t => t.name === 'listed')).toMatchObject({
        name: 'listed',
        uriTemplate: 'listed://items/{id}'
    });
});

verifies(
    'resources:templates:pagination',
    async ({ transport }: TestArgs) => {
        const TOTAL = 25;
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            for (let i = 0; i < TOTAL; i++) {
                s.registerResource(
                    `tpl_${String(i).padStart(2, '0')}`,
                    new ResourceTemplate(`bulk-tpl://t${String(i).padStart(2, '0')}/{x}`, { list: undefined }),
                    { mimeType: 'text/plain' },
                    (uri, { x }) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: String(x) }] })
                );
            }
            return s;
        };
        const client = newClient();
        await using _ = await wire(transport, makeServer, client);

        // No-arg listResourceTemplates() auto-aggregates every page.
        const all = await client.listResourceTemplates();
        expect(all.resourceTemplates.length).toBe(TOTAL);
        expect(all.nextCursor).toBeUndefined();
        expect(new Set(all.resourceTemplates.map(t => t.uriTemplate)).size).toBe(TOTAL);
    },
    { title: 'mcpserver' }
);

verifies(
    'resources:templates:pagination',
    async ({ transport }: TestArgs) => {
        const TOTAL = 25;
        const PAGE = 10;
        const all = Array.from({ length: TOTAL }, (_, i) => `bulk-tpl://t${String(i).padStart(2, '0')}/{x}`);

        const makeServer = () => {
            const s = new Server({ name: 's', version: '0' }, { capabilities: { resources: { listChanged: true } } });
            s.setRequestHandler('resources/templates/list', req => {
                const start = req.params?.cursor === undefined ? 0 : Number.parseInt(req.params.cursor, 10);
                const slice = all.slice(start, start + PAGE);
                return {
                    resourceTemplates: slice.map(uriTemplate => ({ uriTemplate, name: uriTemplate, mimeType: 'text/plain' })),
                    nextCursor: start + PAGE < TOTAL ? String(start + PAGE) : undefined
                };
            });
            return s;
        };
        const client = newClient();
        await using _ = await wire(transport, makeServer, client);

        // No-arg listResourceTemplates() auto-aggregates every page.
        const result = await client.listResourceTemplates();
        expect(result.nextCursor).toBeUndefined();
        const seen = new Set(result.resourceTemplates.map(t => t.uriTemplate));
        expect(seen.size).toBe(TOTAL);
        for (const name of all) expect(seen.has(name)).toBe(true);

        // Explicit cursor → one raw page (per-page path).
        const page = await client.listResourceTemplates({ cursor: '10' });
        expect(page.resourceTemplates.length).toBe(PAGE);
        expect(page.nextCursor).toBe('20');
    },
    { title: 'raw server' }
);

verifies('mcpserver:resource:duplicate-name', async ({ transport }: TestArgs) => {
    let server!: McpServer;
    const makeServer = () => {
        server = new McpServer({ name: 's', version: '0' });
        server.registerResource('text', 'file:///fixture.txt', { mimeType: 'text/plain' }, () => ({
            contents: [{ uri: 'file:///fixture.txt', mimeType: 'text/plain', text: 'hello, world' }]
        }));
        return server;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const before = await client.listResources();
    expect(before.resources.filter(r => r.uri === 'file:///fixture.txt')).toHaveLength(1);

    expect(() => server.registerResource('text', 'file:///fixture.txt', { mimeType: 'text/plain' }, () => ({ contents: [] }))).toThrow(
        /already registered/i
    );

    const after = await client.listResources();
    expect(after.resources.filter(r => r.uri === 'file:///fixture.txt')).toHaveLength(1);

    const result = await client.readResource({ uri: 'file:///fixture.txt' });
    expect(result.contents).toEqual([{ uri: 'file:///fixture.txt', mimeType: 'text/plain', text: 'hello, world' }]);
});

verifies('mcpserver:resource:handle-update-remove', async ({ transport }: TestArgs) => {
    let handle!: RegisteredResource;
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        handle = s.registerResource('probe', 'file:///probe.txt', { mimeType: 'text/plain' }, () => ({
            contents: [{ uri: 'file:///probe.txt', mimeType: 'text/plain', text: 'v1' }]
        }));
        return s;
    };

    let listChanged = 0;
    const client = newClient();
    client.setNotificationHandler('notifications/resources/list_changed', () => {
        listChanged++;
    });
    await using _ = await wire(transport, makeServer, client);

    const initialList = await client.listResources();
    expect(initialList.resources).toHaveLength(1);
    const before = initialList.resources.find(r => r.uri === 'file:///probe.txt');
    expect(before).toBeDefined();
    expect(before?.name).toBe('probe');
    const initialRead = await client.readResource({ uri: 'file:///probe.txt' });
    expect(initialRead.contents).toEqual([{ uri: 'file:///probe.txt', mimeType: 'text/plain', text: 'v1' }]);

    const beforeUpdate = listChanged;
    handle.update({
        name: 'probe (v2)',
        callback: () => ({ contents: [{ uri: 'file:///probe.txt', mimeType: 'text/plain', text: 'v2' }] })
    });
    await vi.waitFor(() => expect(listChanged).toBeGreaterThan(beforeUpdate));
    const updatedList = await client.listResources();
    expect(updatedList.resources).toHaveLength(1);

    const after = updatedList.resources.find(r => r.uri === 'file:///probe.txt');
    expect(after).toBeDefined();
    expect(after?.name).toBe('probe (v2)');
    const updatedRead = await client.readResource({ uri: 'file:///probe.txt' });
    expect(updatedRead.contents).toEqual([{ uri: 'file:///probe.txt', mimeType: 'text/plain', text: 'v2' }]);

    const beforeRemove = listChanged;
    handle.remove();
    await vi.waitFor(() => expect(listChanged).toBeGreaterThan(beforeRemove));
    const removedList = await client.listResources();
    expect(removedList.resources).toHaveLength(0);

    await expect(client.readResource({ uri: 'file:///probe.txt' })).rejects.toBeInstanceOf(ProtocolError);
    const finalList = await client.listResources();
    const gone = finalList.resources.find(r => r.uri === 'file:///probe.txt');
    expect(gone).toBeUndefined();
});

verifies('mcpserver:resource:read-throws-surfaced', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerResource('throws', 'file:///throws', { mimeType: 'text/plain' }, () => {
            throw new Error('resource read failed');
        });
        s.registerResource('ok', 'file:///ok.txt', { mimeType: 'text/plain' }, () => ({
            contents: [{ uri: 'file:///ok.txt', mimeType: 'text/plain', text: 'ok' }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    await expect(client.readResource({ uri: 'file:///throws' })).rejects.toMatchObject({
        code: ProtocolErrorCode.InternalError,
        message: expect.stringContaining('resource read failed')
    });

    const ok = await client.readResource({ uri: 'file:///ok.txt' });
    expect(ok.contents).toEqual([{ uri: 'file:///ok.txt', mimeType: 'text/plain', text: 'ok' }]);
});

verifies('mcpserver:resource:template-list-callback', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerResource('static', 'file:///static.txt', { mimeType: 'text/plain' }, () => ({
            contents: [{ uri: 'file:///static.txt', mimeType: 'text/plain', text: 'static' }]
        }));
        s.registerResource(
            'listed',
            new ResourceTemplate('listed://items/{id}', {
                list: () => ({
                    resources: [
                        { uri: 'listed://items/alpha', name: 'alpha' },
                        { uri: 'listed://items/beta', name: 'beta' },
                        { uri: 'listed://items/gamma', name: 'gamma' }
                    ]
                })
            }),
            { description: 'Template-level description.', mimeType: 'text/plain' },
            (uri, { id }) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: String(id) }] })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const { resources } = await client.listResources();
    expect(resources.some(r => r.uri === 'file:///static.txt')).toBe(true);

    const listed = resources.filter(r => r.uri.startsWith('listed://items/'));
    expect(listed.map(r => r.uri).toSorted()).toEqual(['listed://items/alpha', 'listed://items/beta', 'listed://items/gamma']);

    const alpha = listed.find(r => r.uri === 'listed://items/alpha');
    expect(alpha).toMatchObject({
        uri: 'listed://items/alpha',
        name: 'alpha',
        description: 'Template-level description.',
        mimeType: 'text/plain'
    });
});

verifies('mcpserver:resource:metadata-override', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerResource(
            'listed',
            new ResourceTemplate('listed://items/{id}', {
                list: () => ({
                    resources: [
                        { uri: 'listed://items/alpha', name: 'alpha' },
                        { uri: 'listed://items/gamma', name: 'gamma', description: 'Per-resource override.', mimeType: 'application/json' }
                    ]
                })
            }),
            { description: 'Template-level.', mimeType: 'text/plain' },
            (uri, { id }) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: String(id) }] })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const { resources } = await client.listResources();
    const alpha = resources.find(r => r.uri === 'listed://items/alpha');
    const gamma = resources.find(r => r.uri === 'listed://items/gamma');

    expect(alpha).toBeDefined();
    expect(gamma).toBeDefined();

    expect(alpha).toMatchObject({
        uri: 'listed://items/alpha',
        name: 'alpha',
        description: 'Template-level.',
        mimeType: 'text/plain'
    });

    expect(gamma).toMatchObject({
        uri: 'listed://items/gamma',
        name: 'gamma',
        description: 'Per-resource override.',
        mimeType: 'application/json'
    });
});
