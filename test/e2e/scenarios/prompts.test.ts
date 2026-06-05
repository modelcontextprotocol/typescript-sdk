/**
 * Self-contained test bodies for the prompts surface.
 *
 * Each export is a {@link TestCase}: it builds its own server (via a factory),
 * builds its own client, wires them with {@link wire}, and asserts. Function
 * names mirror the requirement id in camelCase; a `Raw` suffix marks
 * a low-level {@link Server} variant where the behavior under test differs by
 * tier.
 */

import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { Client } from '../../../src/client/index.js';
import { Server } from '../../../src/server/index.js';
import { McpServer, type RegisteredPrompt } from '../../../src/server/mcp.js';
import {
    ErrorCode,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    McpError,
    PromptListChangedNotificationSchema
} from '../../../src/types.js';

import { wire } from '../helpers/index.js';
import type { TestArgs } from '../types.js';
import { verifies } from '../helpers/verifies.js';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const TINY_WAV_BASE64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const TINY_BLOB_BASE64 = 'SGVsbG8sIE1DUCE=';

const newClient = () => new Client({ name: 'c', version: '0' });

function summarizeServer(): McpServer {
    const s = new McpServer({ name: 's', version: '0' });
    s.registerPrompt('summarize', { description: 'Summarize the provided text.', argsSchema: { text: z.string() } }, ({ text }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: `Summarize the following text:\n${text}` } }]
    }));
    return s;
}

function explainCommitServer(): McpServer {
    const s = new McpServer({ name: 's', version: '0' });
    s.registerPrompt('explain-last-commit', { description: 'Explain the most recent git commit.' }, () => ({
        messages: [{ role: 'user', content: { type: 'text', text: 'Explain the most recent commit in this repository.' } }]
    }));
    return s;
}

verifies('prompts:capability:declared', async ({ transport, protocolVersion }: TestArgs) => {
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, explainCommitServer, client);

    const caps = client.getServerCapabilities();
    expect(caps?.prompts).toBeDefined();
    expect(caps?.prompts?.listChanged).toBe(true);
});

verifies('prompts:list:basic', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerPrompt('summarize', { description: 'Summarize the provided text.', argsSchema: { text: z.string() } }, ({ text }) => ({
            messages: [{ role: 'user', content: { type: 'text', text: `Summarize the following text:\n${text}` } }]
        }));
        s.registerPrompt(
            'code-review',
            {
                description: 'Review a code snippet in the given language, optionally focused on one aspect.',
                argsSchema: { language: z.enum(['ts', 'py']), focus: z.string().optional() }
            },
            ({ language, focus }) => ({
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: focus
                                ? `Review the following ${language} code, focusing on ${focus}:`
                                : `Review the following ${language} code:`
                        }
                    }
                ]
            })
        );
        s.registerPrompt('explain-last-commit', { description: 'Explain the most recent git commit.' }, () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'Explain the most recent commit in this repository.' } }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const result = await client.listPrompts();

    expect(result.prompts).toHaveLength(3);
    expect(result.prompts.map(p => p.name).sort()).toEqual(['code-review', 'explain-last-commit', 'summarize']);

    expect(result.prompts.find(p => p.name === 'summarize')).toMatchObject({
        name: 'summarize',
        description: 'Summarize the provided text.',
        arguments: [{ name: 'text', required: true }]
    });

    const codeReview = result.prompts.find(p => p.name === 'code-review');
    expect(codeReview?.description).toBe('Review a code snippet in the given language, optionally focused on one aspect.');
    expect(codeReview?.arguments).toEqual([
        { name: 'language', required: true },
        { name: 'focus', required: false }
    ]);

    const explain = result.prompts.find(p => p.name === 'explain-last-commit');
    expect(explain?.description).toBe('Explain the most recent git commit.');
    expect(explain?.arguments ?? []).toHaveLength(0);
});

verifies(
    'prompts:list:pagination',
    async ({ transport, protocolVersion }: TestArgs) => {
        const TOTAL = 25;
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            for (let i = 0; i < TOTAL; i++) {
                s.registerPrompt(`bulk_${String(i).padStart(2, '0')}`, {}, () => ({ messages: [] }));
            }
            return s;
        };
        const client = newClient();
        await using _ = await wire({ transport, protocolVersion }, makeServer, client);

        const first = await client.listPrompts();
        expect(first.prompts.length).toBeLessThan(TOTAL);
        expect(first.nextCursor).toBeDefined();

        const seen = new Set(first.prompts.map(p => p.name));
        let result = first;
        let pages = 1;
        while (result.nextCursor !== undefined) {
            result = await client.listPrompts({ cursor: result.nextCursor });
            for (const p of result.prompts) seen.add(p.name);
            pages++;
            expect(pages).toBeLessThan(50);
        }
        expect(seen.size).toBe(TOTAL);
        expect(pages).toBeGreaterThan(1);
    },
    { title: 'mcpserver' }
);

verifies(
    'prompts:list:pagination',
    async ({ transport, protocolVersion }: TestArgs) => {
        const TOTAL = 25;
        const PAGE = 10;
        const all = Array.from({ length: TOTAL }, (_, i) => `prompt_${String(i).padStart(2, '0')}`);
        const cursorsReceived: Array<string | undefined> = [];

        const makeServer = () => {
            const s = new Server({ name: 's', version: '0' }, { capabilities: { prompts: {} } });
            s.setRequestHandler(ListPromptsRequestSchema, req => {
                cursorsReceived.push(req.params?.cursor);
                const start = req.params?.cursor === undefined ? 0 : parseInt(req.params.cursor, 10);
                const slice = all.slice(start, start + PAGE);
                return {
                    prompts: slice.map(name => ({ name })),
                    nextCursor: start + PAGE < TOTAL ? String(start + PAGE) : undefined
                };
            });
            s.setRequestHandler(GetPromptRequestSchema, req => ({
                messages: [{ role: 'user', content: { type: 'text', text: req.params.name } }]
            }));
            return s;
        };
        const client = newClient();
        await using _ = await wire({ transport, protocolVersion }, makeServer, client);

        const seen = new Set<string>();
        const cursorsSent: string[] = [];
        let pages = 0;
        let result = await client.listPrompts();
        expect(result.nextCursor).toBeDefined();
        for (;;) {
            for (const p of result.prompts) {
                expect(seen.has(p.name)).toBe(false);
                seen.add(p.name);
            }
            pages++;
            if (result.nextCursor === undefined) break;
            cursorsSent.push(result.nextCursor);
            result = await client.listPrompts({ cursor: result.nextCursor });
            expect(pages).toBeLessThan(50);
        }

        expect(pages).toBe(3);
        expect(seen.size).toBe(TOTAL);
        for (const name of all) expect(seen.has(name)).toBe(true);

        expect(cursorsReceived).toEqual([undefined, '10', '20']);
        expect(cursorsSent).toEqual(['10', '20']);
    },
    { title: 'raw server' }
);

verifies('prompts:list-changed', async ({ transport, protocolVersion }: TestArgs) => {
    let server!: McpServer;
    const makeServer = () => {
        server = new McpServer({ name: 's', version: '0' });
        server.registerPrompt('seed', {}, () => ({ messages: [] }));
        return server;
    };

    let listChanged = 0;
    const client = newClient();
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
        listChanged++;
    });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    expect((await client.listPrompts()).prompts).toHaveLength(1);

    const handle = server.registerPrompt('dynamic-probe', {}, () => ({ messages: [] }));
    await vi.waitFor(() => expect(listChanged).toBeGreaterThanOrEqual(1));
    expect((await client.listPrompts()).prompts).toHaveLength(2);
    const afterAdd = listChanged;

    handle.remove();
    await vi.waitFor(() => expect(listChanged).toBeGreaterThan(afterAdd));
    expect((await client.listPrompts()).prompts).toHaveLength(1);
});

verifies('prompts:get:no-args', async ({ transport, protocolVersion }: TestArgs) => {
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, explainCommitServer, client);

    const result = await client.getPrompt({ name: 'explain-last-commit' });

    expect(result.messages).toEqual([
        { role: 'user', content: { type: 'text', text: 'Explain the most recent commit in this repository.' } }
    ]);
});

verifies('prompts:get:with-args', async ({ transport, protocolVersion }: TestArgs) => {
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, summarizeServer, client);

    const result = await client.getPrompt({
        name: 'summarize',
        arguments: { text: 'The quick brown fox jumps over the lazy dog.' }
    });

    expect(result.messages).toEqual([
        {
            role: 'user',
            content: { type: 'text', text: 'Summarize the following text:\nThe quick brown fox jumps over the lazy dog.' }
        }
    ]);
});

verifies('prompts:get:multi-message', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerPrompt('geography-quiz', { description: 'A short multi-turn geography quiz.' }, () => ({
            messages: [
                { role: 'user', content: { type: 'text', text: 'What is the capital of France?' } },
                { role: 'assistant', content: { type: 'text', text: 'The capital of France is Paris.' } },
                { role: 'user', content: { type: 'text', text: 'And of Italy?' } }
            ]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const result = await client.getPrompt({ name: 'geography-quiz' });

    expect(result.messages).toEqual([
        { role: 'user', content: { type: 'text', text: 'What is the capital of France?' } },
        { role: 'assistant', content: { type: 'text', text: 'The capital of France is Paris.' } },
        { role: 'user', content: { type: 'text', text: 'And of Italy?' } }
    ]);
});

verifies('prompts:get:missing-required-args', async ({ transport, protocolVersion }: TestArgs) => {
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, summarizeServer, client);

    await expect(client.getPrompt({ name: 'summarize', arguments: {} })).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
        message: expect.stringMatching(/text|required|invalid/i)
    });
});

verifies('prompts:get:unknown-name', async ({ transport, protocolVersion }: TestArgs) => {
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, explainCommitServer, client);

    await expect(client.getPrompt({ name: 'no-such-prompt' })).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
        message: expect.stringMatching(/no-such-prompt|unknown|not found/i)
    });
});

verifies('prompts:get:content:image', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerPrompt('describe-image', {}, () => ({
            messages: [
                { role: 'user', content: { type: 'text', text: 'Describe what you see in this image.' } },
                { role: 'user', content: { type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' } }
            ]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const result = await client.getPrompt({ name: 'describe-image' });

    expect(result.messages).toEqual([
        { role: 'user', content: { type: 'text', text: 'Describe what you see in this image.' } },
        { role: 'user', content: { type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' } }
    ]);
});

verifies('prompts:get:content:audio', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerPrompt('transcribe-audio', {}, () => ({
            messages: [
                { role: 'user', content: { type: 'text', text: 'Transcribe the following audio clip.' } },
                { role: 'user', content: { type: 'audio', data: TINY_WAV_BASE64, mimeType: 'audio/wav' } }
            ]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const result = await client.getPrompt({ name: 'transcribe-audio' });

    expect(result.messages).toEqual([
        { role: 'user', content: { type: 'text', text: 'Transcribe the following audio clip.' } },
        { role: 'user', content: { type: 'audio', data: TINY_WAV_BASE64, mimeType: 'audio/wav' } }
    ]);
});

verifies('prompts:get:content:embedded-resource', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerPrompt('review-file', { argsSchema: { kind: z.enum(['text', 'blob']) } }, ({ kind }) => ({
            messages: [
                { role: 'user', content: { type: 'text', text: 'Review the attached file.' } },
                {
                    role: 'user',
                    content:
                        kind === 'text'
                            ? {
                                  type: 'resource',
                                  resource: { uri: 'file:///fixture.txt', mimeType: 'text/plain', text: 'embedded fixture text' }
                              }
                            : {
                                  type: 'resource',
                                  resource: { uri: 'file:///fixture.bin', mimeType: 'application/octet-stream', blob: TINY_BLOB_BASE64 }
                              }
                }
            ]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const text = await client.getPrompt({ name: 'review-file', arguments: { kind: 'text' } });
    expect(text.messages).toEqual([
        { role: 'user', content: { type: 'text', text: 'Review the attached file.' } },
        {
            role: 'user',
            content: { type: 'resource', resource: { uri: 'file:///fixture.txt', mimeType: 'text/plain', text: 'embedded fixture text' } }
        }
    ]);

    const blob = await client.getPrompt({ name: 'review-file', arguments: { kind: 'blob' } });
    expect(blob.messages).toEqual([
        { role: 'user', content: { type: 'text', text: 'Review the attached file.' } },
        {
            role: 'user',
            content: {
                type: 'resource',
                resource: { uri: 'file:///fixture.bin', mimeType: 'application/octet-stream', blob: TINY_BLOB_BASE64 }
            }
        }
    ]);
});

verifies('mcpserver:prompt:args-validation', async ({ transport, protocolVersion }: TestArgs) => {
    const handlerCalls = { n: 0 };
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerPrompt(
            'code-review',
            { argsSchema: { language: z.enum(['ts', 'py']), focus: z.string().optional() } },
            ({ language }) => {
                handlerCalls.n++;
                return { messages: [{ role: 'user', content: { type: 'text', text: `Review the following ${language} code:` } }] };
            }
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const ok = await client.getPrompt({ name: 'code-review', arguments: { language: 'ts' } });
    expect(ok.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Review the following ts code:' } }]);
    expect(handlerCalls.n).toBe(1);

    await expect(client.getPrompt({ name: 'code-review', arguments: { language: 'rust' } })).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
        message: expect.stringMatching(/invalid arguments.*code-review/i)
    });
    expect(handlerCalls.n).toBe(1);

    await expect(client.getPrompt({ name: 'code-review', arguments: {} })).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
        message: expect.stringMatching(/invalid arguments/i)
    });
    expect(handlerCalls.n).toBe(1);
});

verifies('mcpserver:prompt:optional-args', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerPrompt('summarize', { argsSchema: { text: z.string(), max_words: z.string().optional() } }, ({ text, max_words }) => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: max_words
                            ? `Summarize the following text in at most ${max_words} words:\n${text}`
                            : `Summarize the following text:\n${text}`
                    }
                }
            ]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const withOpt = await client.getPrompt({ name: 'summarize', arguments: { text: 'lorem ipsum', max_words: '10' } });
    expect(withOpt.messages).toEqual([
        { role: 'user', content: { type: 'text', text: 'Summarize the following text in at most 10 words:\nlorem ipsum' } }
    ]);

    const withoutOpt = await client.getPrompt({ name: 'summarize', arguments: { text: 'lorem ipsum' } });
    expect(withoutOpt.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Summarize the following text:\nlorem ipsum' } }]);
});

verifies('mcpserver:prompt:duplicate-name', async ({ transport, protocolVersion }: TestArgs) => {
    let dupError: unknown;
    const makeServer = () => {
        const s = explainCommitServer();
        s.registerPrompt('fresh', {}, () => ({ messages: [] }));
        try {
            s.registerPrompt('explain-last-commit', {}, () => ({ messages: [] }));
        } catch (e) {
            dupError = e;
        }
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    expect(dupError).toBeInstanceOf(Error);
    expect(String(dupError)).toMatch(/already registered/i);

    const prompts = (await client.listPrompts()).prompts;
    expect(prompts.filter(p => p.name === 'explain-last-commit')).toHaveLength(1);
    expect(prompts.map(p => p.name)).toContain('fresh');
    const r = await client.getPrompt({ name: 'explain-last-commit' });
    expect(r.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Explain the most recent commit in this repository.' } }]);
});

verifies('mcpserver:prompt:handle-update-remove', async ({ transport, protocolVersion }: TestArgs) => {
    let handle!: RegisteredPrompt;
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        handle = s.registerPrompt('probe', { description: 'v1' }, () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'v1' } }]
        }));
        return s;
    };

    let listChanged = 0;
    const client = newClient();
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
        listChanged++;
    });
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    expect((await client.listPrompts()).prompts).toHaveLength(1);
    const before = (await client.listPrompts()).prompts.find(p => p.name === 'probe')!;
    expect(before.description).toBe('v1');
    expect((await client.getPrompt({ name: 'probe' })).messages).toEqual([{ role: 'user', content: { type: 'text', text: 'v1' } }]);

    handle.update({
        description: 'v2',
        callback: () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'v2' } }] })
    });

    await vi.waitFor(() => expect(listChanged).toBeGreaterThanOrEqual(1));
    expect((await client.listPrompts()).prompts).toHaveLength(1);

    const after = (await client.listPrompts()).prompts.find(p => p.name === 'probe')!;
    expect(after.description).toBe('v2');

    const r = await client.getPrompt({ name: 'probe' });
    expect(r.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'v2' } }]);

    const beforeRemove = listChanged;
    handle.remove();
    await vi.waitFor(() => expect(listChanged).toBeGreaterThan(beforeRemove));
    expect((await client.listPrompts()).prompts).toHaveLength(0);

    await expect(client.getPrompt({ name: 'probe' })).rejects.toBeInstanceOf(McpError);
    expect((await client.listPrompts()).prompts.find(p => p.name === 'probe')).toBeUndefined();
});

verifies('mcpserver:prompt:legacy-overload', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.prompt('legacy-prompt', 'Legacy prompt overload (name, description, cb).', () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'Explain the project README.' } }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const { prompts } = await client.listPrompts();
    const listed = prompts.find(p => p.name === 'legacy-prompt');
    expect(listed).toBeDefined();
    expect(listed!.description).toBe('Legacy prompt overload (name, description, cb).');
    expect(listed!.arguments ?? []).toEqual([]);

    const result = await client.getPrompt({ name: 'legacy-prompt' });
    expect(result.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Explain the project README.' } }]);
});
