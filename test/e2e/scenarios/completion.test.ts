/**
 * Self-contained test bodies for the completion surface.
 *
 * Completion provides autocompletion for prompt arguments and resource template
 * variables. The server declares the `completions` capability and handles
 * `completion/complete` requests, returning up to 100 string suggestions based
 * on the partial value and optional context (already-resolved variables).
 */

import { expect } from 'vitest';
import { z } from 'zod/v4';
import { Server, completable, McpServer, ResourceTemplate, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { wire } from '../helpers/index.js';
import type { TestArgs } from '../types.js';
import { verifies } from '../helpers/verifies.js';

const COLORS = ['red', 'green', 'blue', 'rebeccapurple'] as const;
const FILE_PATHS = ['README.md', 'src/index.ts', 'src/types.ts'] as const;
const REPOS_BY_OWNER: Record<string, readonly string[]> = {
    'acme-corp': ['widget-sdk', 'gadget-sdk', 'docs'],
    globex: ['frobnicator', 'reticulator']
};
const MANY_TOTAL = 150;

const newClient = () => new Client({ name: 'c', version: '0' });

function colorCompletionServer(): McpServer {
    const s = new McpServer({ name: 's', version: '0' });
    s.registerPrompt(
        'complete-color',
        { argsSchema: z.object({ color: completable(z.string(), value => COLORS.filter(c => c.startsWith(value))) }) },
        ({ color }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `color=${color}` } }] })
    );
    return s;
}

verifies('completion:capability:declared', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, colorCompletionServer, client);

    const caps = client.getServerCapabilities();
    expect(caps?.completions).toBeDefined();
    expect(typeof caps?.completions).toBe('object');

    const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'complete-color' },
        argument: { name: 'color', value: '' }
    });
    expect(Array.isArray(result.completion.values)).toBe(true);
});

verifies('completion:complete:not-supported', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerPrompt('summarize-code', { argsSchema: z.object({ code: z.string() }) }, ({ code }) => ({
            messages: [{ role: 'user', content: { type: 'text', text: `Summarize the following code:\n${code}` } }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const caps = client.getServerCapabilities();
    expect(caps).toBeDefined();
    expect(caps?.completions).toBeUndefined();
    expect(caps?.prompts).toBeDefined();

    // Raw request bypasses any client-side capability gating, so the rejection observed is the server's own.
    await expect(
        client.request({
            method: 'completion/complete',
            params: { ref: { type: 'ref/prompt', name: 'summarize-code' }, argument: { name: 'code', value: 'co' } }
        })
    ).rejects.toMatchObject({ code: ProtocolErrorCode.MethodNotFound });
});

verifies('completion:context-arguments', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerResource(
            'github-repo',
            new ResourceTemplate('github://{owner}/{repo}', {
                list: undefined,
                complete: {
                    repo: (value, context) => {
                        const owner = context?.arguments?.owner;
                        if (!owner || typeof owner !== 'string') return [];
                        const repos = REPOS_BY_OWNER[owner] ?? [];
                        return repos.filter(r => r.startsWith(value));
                    }
                }
            }),
            { mimeType: 'text/plain' },
            (uri, { owner, repo }) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: `${owner}/${repo}` }] })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const acme = await client.complete({
        ref: { type: 'ref/resource', uri: 'github://{owner}/{repo}' },
        argument: { name: 'repo', value: '' },
        context: { arguments: { owner: 'acme-corp' } }
    });
    expect(acme.completion.values).toEqual(['widget-sdk', 'gadget-sdk', 'docs']);

    const globex = await client.complete({
        ref: { type: 'ref/resource', uri: 'github://{owner}/{repo}' },
        argument: { name: 'repo', value: '' },
        context: { arguments: { owner: 'globex' } }
    });
    expect(globex.completion.values).toEqual(['frobnicator', 'reticulator']);
    expect(acme.completion.values).not.toEqual(globex.completion.values);

    const bare = await client.complete({
        ref: { type: 'ref/resource', uri: 'github://{owner}/{repo}' },
        argument: { name: 'repo', value: '' }
    });
    expect(bare.completion.values).toEqual([]);
});

verifies(
    'completion:error:invalid-ref',
    async ({ transport }: TestArgs) => {
        const client = newClient();
        await using _ = await wire(transport, colorCompletionServer, client);

        await expect(
            client.complete({ ref: { type: 'ref/prompt', name: 'no-such-prompt' }, argument: { name: 'whatever', value: '' } })
        ).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });

        await expect(
            client.complete({ ref: { type: 'ref/resource', uri: 'nosuchscheme://nowhere/{x}' }, argument: { name: 'x', value: '' } })
        ).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
    },
    { title: 'mcpserver' }
);

verifies(
    'completion:error:invalid-ref',
    async ({ transport }: TestArgs) => {
        const makeServer = () => {
            const s = new Server({ name: 's', version: '0' }, { capabilities: { completions: {} } });
            s.setRequestHandler('completion/complete', req => {
                if (req.params.ref.type === 'ref/prompt' && req.params.ref.name === 'known') {
                    return { completion: { values: ['ok'] } };
                }
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No completion target: ${JSON.stringify(req.params.ref)}`);
            });
            return s;
        };
        const client = newClient();
        await using _ = await wire(transport, makeServer, client);

        const known = await client.complete({ ref: { type: 'ref/prompt', name: 'known' }, argument: { name: 'a', value: '' } });
        expect(known.completion.values).toEqual(['ok']);

        await expect(
            client.complete({ ref: { type: 'ref/prompt', name: 'no-such-prompt' }, argument: { name: 'a', value: '' } })
        ).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
    },
    { title: 'raw server' }
);

verifies('completion:prompt-arg', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, colorCompletionServer, client);

    const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'complete-color' },
        argument: { name: 'color', value: 're' }
    });

    const expected = COLORS.filter(c => c.startsWith('re'));
    expect(result.completion.values).toEqual(expected);
    expect(result.completion.hasMore ?? false).toBe(false);
});

verifies('completion:resource-template-arg', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerResource(
            'file-path',
            new ResourceTemplate('completion://files/{path}', {
                list: undefined,
                complete: { path: value => FILE_PATHS.filter(p => p.startsWith(value)) }
            }),
            { mimeType: 'text/plain' },
            (uri, { path }) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: `path=${path}` }] })
        );
        s.registerResource(
            'github-repo',
            new ResourceTemplate('github://{owner}/{repo}', {
                list: undefined,
                complete: { owner: () => [] }
            }),
            { mimeType: 'text/plain' },
            (uri, { owner, repo }) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: `${owner}/${repo}` }] })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const result = await client.complete({
        ref: { type: 'ref/resource', uri: 'completion://files/{path}' },
        argument: { name: 'path', value: 'src/' }
    });

    expect(result.completion.values).toEqual(['src/index.ts', 'src/types.ts']);
    expect(result.completion.hasMore ?? false).toBe(false);

    const other = await client.complete({
        ref: { type: 'ref/resource', uri: 'github://{owner}/{repo}' },
        argument: { name: 'path', value: 'src/' }
    });

    expect(other.completion.values).toEqual([]);
});

verifies('completion:result-shape', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerPrompt(
            'complete-color',
            { argsSchema: z.object({ color: completable(z.string(), value => COLORS.filter(c => c.startsWith(value))) }) },
            ({ color }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `color=${color}` } }] })
        );
        const many = Array.from({ length: MANY_TOTAL }, (_, i) => `item-${String(i).padStart(3, '0')}`);
        s.registerPrompt(
            'complete-many',
            { argsSchema: z.object({ n: completable(z.string(), value => many.filter(s => s.startsWith(value))) }) },
            ({ n }) => ({ messages: [{ role: 'user', content: { type: 'text', text: n } }] })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const small = await client.complete({
        ref: { type: 'ref/prompt', name: 'complete-color' },
        argument: { name: 'color', value: 're' }
    });

    expect(Array.isArray(small.completion.values)).toBe(true);
    expect(small.completion.values).toEqual(COLORS.filter(c => c.startsWith('re')));
    expect(small.completion.values.length).toBeLessThanOrEqual(100);
    expect(small.completion.total).toBe(small.completion.values.length);
    expect(small.completion.total).toBe(2);
    expect(small.completion.hasMore).toBe(false);

    const empty = await client.complete({
        ref: { type: 'ref/prompt', name: 'complete-color' },
        argument: { name: 'no-such-arg', value: '' }
    });

    expect(empty.completion.values).toEqual([]);
    expect(empty.completion.total).toBeUndefined();
    expect(empty.completion.hasMore).toBe(false);

    const many = await client.complete({
        ref: { type: 'ref/prompt', name: 'complete-many' },
        argument: { name: 'n', value: '' }
    });

    expect(many.completion.values).toHaveLength(100);
    expect(many.completion.values.every(v => typeof v === 'string')).toBe(true);
    expect(many.completion.values[0]).toBe('item-000');
    expect(many.completion.values[99]).toBe('item-099');
    expect(many.completion.total).toBe(MANY_TOTAL);
    expect(many.completion.hasMore).toBe(true);
});

verifies(
    'mcpserver:completion:capability-auto',
    async ({ transport }: TestArgs) => {
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerPrompt('non-completable', { argsSchema: z.object({ arg: z.string() }) }, ({ arg }) => ({
                messages: [{ role: 'user', content: { type: 'text', text: arg } }]
            }));
            s.registerResource(
                'plain-resource',
                new ResourceTemplate('plain://resource/{id}', { list: undefined }),
                { mimeType: 'text/plain' },
                (uri, { id }) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: `id=${id}` }] })
            );
            return s;
        };

        const client = newClient();
        await using _ = await wire(transport, makeServer, client);

        const caps = client.getServerCapabilities();
        expect(caps).toBeDefined();
        expect(caps?.completions).toBeUndefined();
        expect(caps?.prompts).toBeDefined();
        expect(caps?.resources).toBeDefined();

        await expect(
            client.complete({
                ref: { type: 'ref/prompt', name: 'non-completable' },
                argument: { name: 'arg', value: '' }
            })
        ).rejects.toThrow();
    },
    { title: 'mcpserver' }
);

verifies(
    'mcpserver:completion:capability-auto',
    async ({ transport }: TestArgs) => {
        const makeServer = () => {
            const s = new Server({ name: 's', version: '0' }, { capabilities: { prompts: {}, resources: {} } });
            s.setRequestHandler('prompts/list', () => ({ prompts: [{ name: 'plain', arguments: [] }] }));
            s.setRequestHandler('resources/list', () => ({ resources: [] }));
            s.setRequestHandler('resources/read', () => ({ contents: [] }));
            return s;
        };

        const client = newClient();
        await using _ = await wire(transport, makeServer, client);

        const caps = client.getServerCapabilities();
        expect(caps?.completions).toBeUndefined();
        expect(caps?.prompts).toBeDefined();
        expect(caps?.resources).toBeDefined();

        await expect(
            client.complete({
                ref: { type: 'ref/prompt', name: 'plain' },
                argument: { name: 'arg', value: '' }
            })
        ).rejects.toThrow();
    },
    { title: 'raw server' }
);
