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
import { $ZodError } from 'zod/v4/core';

import { Client } from '../../../src/client/index.js';
import { Server } from '../../../src/server/index.js';
import { completable } from '../../../src/server/completable.js';
import { McpServer, ResourceTemplate } from '../../../src/server/mcp.js';
import {
    CompleteRequestSchema,
    CompleteResultSchema,
    ErrorCode,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    McpError,
    ReadResourceRequestSchema
} from '../../../src/types.js';

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
        { argsSchema: { color: completable(z.string(), value => COLORS.filter(c => c.startsWith(value))) } },
        ({ color }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `color=${color}` } }] })
    );
    return s;
}

verifies('completion:capability:declared', async ({ transport, protocolVersion }: TestArgs) => {
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, colorCompletionServer, client);

    const caps = client.getServerCapabilities();
    expect(caps?.completions).toBeDefined();
    expect(typeof caps?.completions).toBe('object');

    const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'complete-color' },
        argument: { name: 'color', value: '' }
    });
    expect(Array.isArray(result.completion.values)).toBe(true);
});

verifies('completion:complete:not-supported', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerPrompt('summarize-code', { argsSchema: { code: z.string() } }, ({ code }) => ({
            messages: [{ role: 'user', content: { type: 'text', text: `Summarize the following code:\n${code}` } }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const caps = client.getServerCapabilities();
    expect(caps).toBeDefined();
    expect(caps?.completions).toBeUndefined();
    expect(caps?.prompts).toBeDefined();

    // Raw request bypasses any client-side capability gating, so the rejection observed is the server's own.
    await expect(
        client.request(
            {
                method: 'completion/complete',
                params: { ref: { type: 'ref/prompt', name: 'summarize-code' }, argument: { name: 'code', value: 'co' } }
            },
            CompleteResultSchema
        )
    ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
});

verifies('completion:context-arguments', async ({ transport, protocolVersion }: TestArgs) => {
    const MEMBERS_BY_DEPARTMENT: Record<string, readonly string[]> = {
        engineering: ['Alice', 'Bob'],
        sales: ['David', 'Eve']
    };
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
        s.registerPrompt(
            'team-greeting',
            {
                argsSchema: {
                    department: completable(z.string(), value => Object.keys(MEMBERS_BY_DEPARTMENT).filter(d => d.startsWith(value))),
                    name: completable(z.string(), (value, context) => {
                        const department = context?.arguments?.department;
                        if (!department || typeof department !== 'string') return [];
                        return (MEMBERS_BY_DEPARTMENT[department] ?? []).filter(n => n.startsWith(value));
                    })
                }
            },
            ({ department, name }) => ({
                messages: [{ role: 'user', content: { type: 'text', text: `Hello ${name} (${department})` } }]
            })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

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

    // ref/prompt arm: context.arguments must reach PROMPT completion callbacks too
    // (the server routes prompt completion separately from resource completion, so
    // the resource arm above cannot stand in for it). Disjoint results per context
    // prove the callback saw the resolved department value.
    const engineering = await client.complete({
        ref: { type: 'ref/prompt', name: 'team-greeting' },
        argument: { name: 'name', value: '' },
        context: { arguments: { department: 'engineering' } }
    });
    expect(engineering.completion.values).toEqual(['Alice', 'Bob']);

    const sales = await client.complete({
        ref: { type: 'ref/prompt', name: 'team-greeting' },
        argument: { name: 'name', value: '' },
        context: { arguments: { department: 'sales' } }
    });
    expect(sales.completion.values).toEqual(['David', 'Eve']);
    expect(engineering.completion.values).not.toEqual(sales.completion.values);

    const promptBare = await client.complete({
        ref: { type: 'ref/prompt', name: 'team-greeting' },
        argument: { name: 'name', value: '' }
    });
    expect(promptBare.completion.values).toEqual([]);
});

verifies(
    'completion:error:invalid-ref',
    async ({ transport, protocolVersion }: TestArgs) => {
        const client = newClient();
        await using _ = await wire({ transport, protocolVersion }, colorCompletionServer, client);

        await expect(
            client.complete({ ref: { type: 'ref/prompt', name: 'no-such-prompt' }, argument: { name: 'whatever', value: '' } })
        ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });

        await expect(
            client.complete({ ref: { type: 'ref/resource', uri: 'nosuchscheme://nowhere/{x}' }, argument: { name: 'x', value: '' } })
        ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    },
    { title: 'mcpserver' }
);

verifies(
    'completion:error:invalid-ref',
    async ({ transport, protocolVersion }: TestArgs) => {
        const makeServer = () => {
            const s = new Server({ name: 's', version: '0' }, { capabilities: { completions: {} } });
            s.setRequestHandler(CompleteRequestSchema, req => {
                if (req.params.ref.type === 'ref/prompt' && req.params.ref.name === 'known') {
                    return { completion: { values: ['ok'] } };
                }
                throw new McpError(ErrorCode.InvalidParams, `No completion target: ${JSON.stringify(req.params.ref)}`);
            });
            return s;
        };
        const client = newClient();
        await using _ = await wire({ transport, protocolVersion }, makeServer, client);

        const known = await client.complete({ ref: { type: 'ref/prompt', name: 'known' }, argument: { name: 'a', value: '' } });
        expect(known.completion.values).toEqual(['ok']);

        await expect(
            client.complete({ ref: { type: 'ref/prompt', name: 'no-such-prompt' }, argument: { name: 'a', value: '' } })
        ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    },
    { title: 'raw server' }
);

verifies('completion:prompt-arg', async ({ transport, protocolVersion }: TestArgs) => {
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, colorCompletionServer, client);

    const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'complete-color' },
        argument: { name: 'color', value: 're' }
    });

    const expected = COLORS.filter(c => c.startsWith('re'));
    expect(result.completion.values).toEqual(expected);
    expect(result.completion.hasMore ?? false).toBe(false);
});

verifies('completion:resource-template-arg', async ({ transport, protocolVersion }: TestArgs) => {
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
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

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

verifies('completion:result-shape', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerPrompt(
            'complete-color',
            { argsSchema: { color: completable(z.string(), value => COLORS.filter(c => c.startsWith(value))) } },
            ({ color }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `color=${color}` } }] })
        );
        const many = Array.from({ length: MANY_TOTAL }, (_, i) => `item-${String(i).padStart(3, '0')}`);
        s.registerPrompt(
            'complete-many',
            { argsSchema: { n: completable(z.string(), value => many.filter(s => s.startsWith(value))) } },
            ({ n }) => ({ messages: [{ role: 'user', content: { type: 'text', text: n } }] })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

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

verifies('typescript:completion:values:client-cap', async ({ transport, protocolVersion }: TestArgs) => {
    // completion:result-shape proves McpServer truncates at 100 SERVER-side, so an
    // over-cap result never crosses the wire there. This low-level Server returns
    // however many values are asked for, exposing the CLIENT-side strictness of
    // CompleteResultSchema (values capped at 100).
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { completions: {} } });
        s.setRequestHandler(CompleteRequestSchema, req => {
            const count = Number(req.params.argument.value);
            return { completion: { values: Array.from({ length: count }, (_, i) => `v${i}`) } };
        });
        return s;
    };
    const client = newClient();
    // The 101-value result deliberately violates CompleteResultSchema on the wire.
    await using _ = await wire({ transport, protocolVersion }, makeServer, client, { strictValidation: false });

    // Positive control: exactly 100 values parse and resolve.
    const atCap = await client.complete({ ref: { type: 'ref/prompt', name: 'p' }, argument: { name: 'a', value: '100' } });
    expect(atCap.completion.values).toHaveLength(100);

    // 101 values fail the client-side result parse: the raw validator error crosses
    // the boundary (never a wrapped McpError) with a too_big issue on values.
    const err: unknown = await client.complete({ ref: { type: 'ref/prompt', name: 'p' }, argument: { name: 'a', value: '101' } }).then(
        () => undefined,
        (e: unknown) => e
    );
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(McpError);
    expect(err).toBeInstanceOf($ZodError);
    expect(((err as { issues?: Array<{ code: string }> }).issues ?? []).map(i => i.code)).toContain('too_big');
});

verifies(
    'mcpserver:completion:capability-auto',
    async ({ transport, protocolVersion }: TestArgs) => {
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerPrompt('non-completable', { argsSchema: { arg: z.string() } }, ({ arg }) => ({
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
        await using _ = await wire({ transport, protocolVersion }, makeServer, client);

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
    async ({ transport, protocolVersion }: TestArgs) => {
        const makeServer = () => {
            const s = new Server({ name: 's', version: '0' }, { capabilities: { prompts: {}, resources: {} } });
            s.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [{ name: 'plain', arguments: [] }] }));
            s.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
            s.setRequestHandler(ReadResourceRequestSchema, () => ({ contents: [] }));
            return s;
        };

        const client = newClient();
        await using _ = await wire({ transport, protocolVersion }, makeServer, client);

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
