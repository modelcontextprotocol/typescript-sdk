/**
 * Self-contained test bodies for the tools surface.
 *
 * Each export is a {@link TestCase}: it builds its own server (via a factory),
 * builds its own client, wires them with {@link wire}, and asserts. There are
 * no shared fixture imports; helpers local to multiple bodies live at the top
 * of this file.
 *
 * `wire()` takes a *factory* because that's the production shape: per-session
 * HTTP creates a fresh server per session, stateless per request. Bodies that
 * inspect server-side state therefore declare the recorder *outside* the
 * factory so every server instance closes over the same array. Bodies that
 * need a specific instance handle (e.g. to call `.update()`) capture it via
 * `let server!: McpServer` and rely on `requirements/tools.ts` to mark
 * `skipOn` for stateless where the captured ref is not the one serving
 * subsequent requests.
 *
 * Function names mirror the requirement id in camelCase; a `Raw` suffix marks
 * a low-level {@link Server} variant where the behavior under test differs by
 * tier.
 */

import { Client } from '@modelcontextprotocol/client';
import type { JsonSchemaType } from '@modelcontextprotocol/core-internal';
import type {
    CreateMessageRequest,
    CreateMessageResult,
    ElicitRequest,
    JSONRPCMessage,
    RegisteredTool,
    RequestId,
    Tool
} from '@modelcontextprotocol/server';
import { McpServer, ProtocolError, ProtocolErrorCode, Server, UrlElicitationRequiredError } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { wire } from '../helpers/index';
import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const TINY_WAV_BASE64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const TINY_BLOB_BASE64 = 'SGVsbG8sIE1DUCE=';

/** Raw JSON Schema 2020-12 inputSchema used by the `Raw` schema-preservation tests. */
const JSON_SCHEMA_2020_12_INPUT = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object' as const,
    properties: { point: { $ref: '#/$defs/Point' } },
    required: ['point'],
    additionalProperties: false,
    $defs: {
        Point: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
            additionalProperties: false
        }
    }
};

/** Plain client with no extra capabilities declared. */
const newClient = () => new Client({ name: 'c', version: '0' });

/** Wire-delivered schemas arrive as plain JSON objects; this runtime check narrows them to the validator's input type. */
function isJsonSchemaObject(schema: unknown): schema is JsonSchemaType {
    return typeof schema === 'object' && schema !== null && !Array.isArray(schema);
}

/** McpServer factory that registers `echo` — the smallest useful server. */
function echoServer(): McpServer {
    const s = new McpServer({ name: 's', version: '0' });
    s.registerTool(
        'echo',
        { description: 'Echoes the input text back as a text content block.', inputSchema: z.object({ text: z.string() }) },
        ({ text }) => ({ content: [{ type: 'text', text }] })
    );
    return s;
}

/** McpServer factory carrying the structured/output-schema fixture set. */
function schemaServer(): McpServer {
    const s = new McpServer({ name: 's', version: '0' });
    s.registerTool(
        'structured',
        { inputSchema: z.object({ n: z.number() }), outputSchema: z.object({ doubled: z.number().int() }) },
        ({ n }) => ({ structuredContent: { doubled: n * 2 }, content: [{ type: 'text', text: JSON.stringify({ doubled: n * 2 }) }] })
    );
    s.registerTool(
        'structured-mismatch',
        { inputSchema: z.object({}), outputSchema: z.object({ value: z.number() }) },
        // intentionally invalid structuredContent (tests server-side validation rejects it)
        () => ({ structuredContent: { value: 'not-a-number' }, content: [] })
    );
    s.registerTool('structured-missing', { inputSchema: z.object({}), outputSchema: z.object({ value: z.number() }) }, () => ({
        content: [{ type: 'text', text: 'handler-body-no-structured' }]
    }));
    s.registerTool('structured-error-skip', { inputSchema: z.object({}), outputSchema: z.object({ value: z.number() }) }, () => ({
        isError: true,
        content: [{ type: 'text', text: 'handler-returned-isError' }]
    }));
    return s;
}

/** Low-level Server factory listing/calling a single hand-authored JSON-Schema-2020-12 tool. */
function rawJsonSchemaServer(): Server {
    const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
    s.setRequestHandler('tools/list', () => ({
        tools: [{ name: 'json-schema', description: 'raw 2020-12 schema', inputSchema: JSON_SCHEMA_2020_12_INPUT }]
    }));
    s.setRequestHandler('tools/call', req => {
        const { x, y } = (req.params.arguments as { point: { x: number; y: number } }).point;
        return { content: [{ type: 'text', text: `(${x}, ${y})` }] };
    });
    return s;
}

/** Low-level Server factory with output-schema fixtures and NO server-side validation. */
function rawSchemaServer(): Server {
    const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
    const outputSchema: Tool['outputSchema'] = { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] };
    s.setRequestHandler('tools/list', () => ({
        tools: [
            {
                name: 'structured',
                inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
                outputSchema: { type: 'object', properties: { doubled: { type: 'integer' } } }
            },
            { name: 'structured-mismatch', inputSchema: { type: 'object' }, outputSchema },
            { name: 'structured-missing', inputSchema: { type: 'object' }, outputSchema },
            { name: 'structured-error-skip', inputSchema: { type: 'object' }, outputSchema }
        ]
    }));
    s.setRequestHandler('tools/call', req => {
        switch (req.params.name) {
            case 'structured': {
                const n = (req.params.arguments as { n: number }).n;
                return { structuredContent: { doubled: n * 2 }, content: [{ type: 'text', text: JSON.stringify({ doubled: n * 2 }) }] };
            }
            case 'structured-mismatch': {
                // intentionally invalid structuredContent (tests client-side validation rejects it)
                return { structuredContent: { value: 'not-a-number' }, content: [] };
            }
            case 'structured-missing': {
                return { content: [{ type: 'text', text: 'handler-body-no-structured' }] };
            }
            case 'structured-error-skip': {
                return { isError: true, content: [{ type: 'text', text: 'handler-returned-isError' }] };
            }
            default: {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `unknown tool ${req.params.name}`);
            }
        }
    });
    return s;
}

verifies('tools:call:content:text', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, echoServer, client);

    const r = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: 'hi' }]);
});

verifies('tools:call:content:image', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('image', { inputSchema: z.object({}) }, () => ({
            content: [{ type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'image', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' }]);
});

verifies('tools:call:content:audio', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('audio', { inputSchema: z.object({}) }, () => ({
            content: [{ type: 'audio', data: TINY_WAV_BASE64, mimeType: 'audio/wav' }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'audio', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'audio', data: TINY_WAV_BASE64, mimeType: 'audio/wav' }]);
});

verifies('tools:call:content:embedded-resource', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('embedded-resource', { inputSchema: z.object({ kind: z.enum(['text', 'blob']) }) }, ({ kind }) => ({
            content: [
                {
                    type: 'resource',
                    resource:
                        kind === 'text'
                            ? { uri: 'file:///fixture.txt', mimeType: 'text/plain', text: 'embedded fixture text' }
                            : { uri: 'file:///fixture.bin', mimeType: 'application/octet-stream', blob: TINY_BLOB_BASE64 }
                }
            ]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const text = await client.callTool({ name: 'embedded-resource', arguments: { kind: 'text' } });
    expect(text.content).toEqual([
        { type: 'resource', resource: { uri: 'file:///fixture.txt', mimeType: 'text/plain', text: 'embedded fixture text' } }
    ]);

    const blob = await client.callTool({ name: 'embedded-resource', arguments: { kind: 'blob' } });
    expect(blob.content).toEqual([
        { type: 'resource', resource: { uri: 'file:///fixture.bin', mimeType: 'application/octet-stream', blob: TINY_BLOB_BASE64 } }
    ]);
});

verifies('tools:call:content:resource-link', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('resource-link', { inputSchema: z.object({}) }, () => ({
            content: [
                {
                    type: 'resource_link',
                    uri: 'file:///linked.txt',
                    name: 'linked.txt',
                    description: 'A linked (not embedded) resource',
                    mimeType: 'text/plain'
                }
            ]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'resource-link', arguments: {} });
    expect(r.content).toEqual([
        {
            type: 'resource_link',
            uri: 'file:///linked.txt',
            name: 'linked.txt',
            description: 'A linked (not embedded) resource',
            mimeType: 'text/plain'
        }
    ]);
});

verifies('tools:call:content:mixed', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('mixed-content', { inputSchema: z.object({}) }, () => ({
            content: [
                { type: 'text', text: 'first' },
                { type: 'image', mimeType: 'image/png', data: TINY_PNG_BASE64 },
                { type: 'resource', resource: { uri: 'file:///mixed.txt', mimeType: 'text/plain', text: 'inlined' } },
                { type: 'text', text: 'last' }
            ]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'mixed-content', arguments: {} });
    expect(r.content).toEqual([
        { type: 'text', text: 'first' },
        { type: 'image', mimeType: 'image/png', data: TINY_PNG_BASE64 },
        { type: 'resource', resource: { uri: 'file:///mixed.txt', mimeType: 'text/plain', text: 'inlined' } },
        { type: 'text', text: 'last' }
    ]);
});

verifies('tools:call:sampling-roundtrip', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('ask-llm', { inputSchema: z.object({ prompt: z.string() }) }, async ({ prompt }) => {
            const reply = await s.server.createMessage({
                messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
                maxTokens: 100
            });
            if (reply.content.type !== 'text') throw new Error('expected text content');
            return { content: [{ type: 'text', text: `model said: ${reply.content.text}` }] };
        });
        return s;
    };

    const received: CreateMessageRequest[] = [];
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { sampling: {} } });
    client.setRequestHandler('sampling/createMessage', async req => {
        received.push(req);
        return {
            model: 'stub-model',
            role: 'assistant',
            stopReason: 'endTurn',
            content: { type: 'text', text: 'pong' }
        } satisfies CreateMessageResult;
    });

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'ask-llm', arguments: { prompt: 'ping' } });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: 'model said: pong' }]);

    expect(received).toHaveLength(1);
    const samplingRequest = received[0];
    if (samplingRequest === undefined) throw new Error('expected a sampling request to have been received');
    expect(samplingRequest.params.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'ping' } }]);
    expect(samplingRequest.params.maxTokens).toBe(100);
});

verifies('tools:call:elicitation-roundtrip', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('ask-name', { inputSchema: z.object({}) }, async () => {
            const ans = await s.server.elicitInput({
                mode: 'form',
                message: 'What is your name?',
                requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
            });
            const name = ans.action === 'accept' && typeof ans.content?.name === 'string' ? ans.content.name : '<declined>';
            return { content: [{ type: 'text', text: `Hello, ${name}` }] };
        });
        return s;
    };

    const received: ElicitRequest[] = [];
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler('elicitation/create', async req => {
        received.push(req);
        return { action: 'accept', content: { name: 'Ada' } };
    });

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'ask-name', arguments: {} });

    expect(received).toHaveLength(1);
    const elicitRequest = received[0];
    if (elicitRequest === undefined) throw new Error('expected an elicitation request to have been received');
    expect(elicitRequest.method).toBe('elicitation/create');
    expect(elicitRequest.params).toMatchObject({
        mode: 'form',
        message: 'What is your name?',
        requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
    });

    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: 'Hello, Ada' }]);
});

verifies('tools:call:logging-mid-execution', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' }, { capabilities: { logging: {} } });
        s.registerTool('log-then-ok', { inputSchema: z.object({}) }, async (_args, ctx) => {
            await ctx.mcpReq.notify({
                method: 'notifications/message',
                params: { level: 'warning', logger: 'tools-test', data: 'work in progress' }
            });
            return { content: [{ type: 'text', text: 'logged' }] };
        });
        return s;
    };

    const logs: Array<{ level: string; logger?: string; data: unknown }> = [];
    const client = newClient();
    client.setNotificationHandler('notifications/message', n => {
        logs.push(n.params);
    });

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'log-then-ok', arguments: {} });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'warning', logger: 'tools-test', data: 'work in progress' });
    expect(r.content).toEqual([{ type: 'text', text: 'logged' }]);
});

verifies('tools:call:progress', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('progress', { inputSchema: z.object({ steps: z.number().int().positive() }) }, async ({ steps }, ctx) => {
            const token = ctx.mcpReq._meta?.progressToken;
            if (token !== undefined) {
                for (let i = 1; i <= steps; i++) {
                    await ctx.mcpReq.notify({
                        method: 'notifications/progress',
                        params: { progressToken: token, progress: i, total: steps, message: `step ${i}/${steps}` }
                    });
                }
            }
            return { content: [{ type: 'text', text: `done after ${steps} steps` }] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const steps = 3;
    const received: Array<{ progress: number; total?: number; message?: string }> = [];
    let receivedAtResolve = -1;

    const r = await client
        .callTool(
            { name: 'progress', arguments: { steps } },
            { onprogress: p => received.push({ progress: p.progress, total: p.total, message: p.message }) }
        )
        .then(res => {
            receivedAtResolve = received.length;
            return res;
        });

    expect(receivedAtResolve).toBe(steps);
    expect(received).toEqual([
        { progress: 1, total: steps, message: 'step 1/3' },
        { progress: 2, total: steps, message: 'step 2/3' },
        { progress: 3, total: steps, message: 'step 3/3' }
    ]);
    expect(r.content).toEqual([{ type: 'text', text: `done after ${steps} steps` }]);
});

verifies('tools:call:concurrent', async ({ transport }: TestArgs) => {
    // Both handlers park on a shared release barrier after recording that they started; a server
    // that dispatched calls sequentially would never start the second handler before the first
    // returns, so the started-length wait below would time out instead of passing.
    let releaseBoth!: () => void;
    const release = new Promise<void>(resolve => {
        releaseBoth = resolve;
    });
    // Recorders live OUTSIDE the factory so every server instance (stateless makes one per request) shares them.
    const started: string[] = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('lookup-order-status', { inputSchema: z.object({ orderId: z.string() }) }, async ({ orderId }) => {
            started.push(orderId);
            await release;
            return { content: [{ type: 'text', text: `order ${orderId}: shipped` }] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const settled: string[] = [];
    const firstCall = client.callTool({ name: 'lookup-order-status', arguments: { orderId: 'order-1001' } }).then(r => {
        settled.push('order-1001');
        return r;
    });
    const secondCall = client.callTool({ name: 'lookup-order-status', arguments: { orderId: 'order-2002' } }).then(r => {
        settled.push('order-2002');
        return r;
    });

    // Both handlers are running at the same time before either is allowed to finish.
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(started.toSorted()).toEqual(['order-1001', 'order-2002']);
    expect(settled).toEqual([]);

    releaseBoth();
    const [first, second] = await Promise.all([firstCall, secondCall]);

    // Each caller receives the response correlated to its own request, not the other one's.
    expect(first.isError).toBeFalsy();
    expect(first.content).toEqual([{ type: 'text', text: 'order order-1001: shipped' }]);
    expect(second.isError).toBeFalsy();
    expect(second.content).toEqual([{ type: 'text', text: 'order order-2002: shipped' }]);
    expect(settled.toSorted()).toEqual(['order-1001', 'order-2002']);
});

verifies('tools:call:is-error', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('returns-is-error', { inputSchema: z.object({ message: z.string() }) }, ({ message }) => ({
            isError: true,
            content: [{ type: 'text', text: message }]
        }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    // Tap inbound wire messages so we can assert the JSON-RPC envelope shape.
    const inbound: JSONRPCMessage[] = [];
    const original = client.transport!.onmessage;
    client.transport!.onmessage = (m, e) => {
        inbound.push(m);
        original?.(m, e);
    };

    const r = await client.callTool({ name: 'returns-is-error', arguments: { message: 'tool-level failure' } });

    // API layer: callTool resolves with the error body.
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: 'text', text: 'tool-level failure' }]);

    // Wire layer: the reply for this call is a result envelope, never `error`.
    const reply = inbound.find(m => 'id' in m && 'result' in m);
    expect(reply).toBeDefined();
    expect(reply).not.toHaveProperty('error');
    expect((reply as { result: { isError?: boolean } }).result.isError).toBe(true);

    client.transport!.onmessage = original;
});

verifies(
    'tools:call:unknown-name',
    async ({ transport }: TestArgs) => {
        // Spec: unknown tool is a protocol error → JSON-RPC error envelope, so
        // callTool() rejects. Known SDK gap: McpServer's catch wraps it as
        // {isError:true} instead — this body asserts the spec-correct behavior.
        const client = newClient();
        await using _ = await wire(transport, echoServer, client);

        const call = client.callTool({ name: 'no-such-tool', arguments: {} });
        await expect(call).rejects.toBeInstanceOf(ProtocolError);
        const err = await call.catch(error => error as ProtocolError);
        expect(err.code).toBe(ProtocolErrorCode.InvalidParams);
        expect(err.message).toMatch(/no-such-tool|unknown|not found/i);
    },
    { title: 'mcpserver' }
);

verifies(
    'tools:call:unknown-name',
    async ({ transport }: TestArgs) => {
        const makeServer = () => {
            const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
            s.setRequestHandler('tools/list', () => ({
                tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }]
            }));
            s.setRequestHandler('tools/call', req => {
                if (req.params.name === 'echo') {
                    return { content: [{ type: 'text', text: String(req.params.arguments?.text ?? '') }] };
                }
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${req.params.name} not found`);
            });
            return s;
        };
        const client = newClient();
        await using _ = await wire(transport, makeServer, client);

        const ok = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
        expect(ok.content).toEqual([{ type: 'text', text: 'hi' }]);

        const call = client.callTool({ name: 'no-such-tool', arguments: {} });
        await expect(call).rejects.toBeInstanceOf(ProtocolError);
        const err = await call.catch(error => error as ProtocolError);
        expect(err.code).toBe(ProtocolErrorCode.InvalidParams);
    },
    { title: 'raw server' }
);

verifies('tools:call:structured-content', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, schemaServer, client);

    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'structured');
    if (!tool?.outputSchema) throw new Error('outputSchema missing');
    expect(tool.outputSchema).toMatchObject({ type: 'object', properties: { doubled: { type: 'integer' } } });

    const r = await client.callTool({ name: 'structured', arguments: { n: 7 } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ doubled: 14 });
    expect(r.content).toEqual([{ type: 'text', text: JSON.stringify({ doubled: 14 }) }]);

    // structuredContent satisfies the *advertised* outputSchema.
    if (!isJsonSchemaObject(tool.outputSchema)) throw new Error('advertised outputSchema is not a JSON Schema object');
    const validate = new AjvJsonSchemaValidator().getValidator(tool.outputSchema);
    const v = validate(r.structuredContent);
    expect(v.valid, v.errorMessage).toBe(true);
});

verifies('tools:call:structured-content:text-mirror', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, schemaServer, client);

    const r = await client.callTool({ name: 'structured', arguments: { n: 21 } });
    expect(r.structuredContent).toEqual({ doubled: 42 });
    expect(r.content).toContainEqual({ type: 'text', text: JSON.stringify({ doubled: 42 }) });
});

verifies(['client:output-schema:validate', 'client:output-schema:missing-structured'], async ({ transport }: TestArgs) => {
    // Client-side validation is only observable when the server does NOT
    // pre-validate (raw Server) — McpServer would intercept first.
    const client = newClient();
    await using _ = await wire(transport, rawSchemaServer, client);

    // Prime the validator cache.
    const { tools } = await client.listTools();
    for (const name of ['structured', 'structured-mismatch', 'structured-missing']) {
        expect(tools.find(t => t.name === name)?.outputSchema).toMatchObject({ type: 'object' });
    }

    const ok = await client.callTool({ name: 'structured', arguments: { n: 3 } });
    expect(ok.structuredContent).toEqual({ doubled: 6 });

    const mismatch = client.callTool({ name: 'structured-mismatch', arguments: {} });
    await expect(mismatch).rejects.toBeInstanceOf(ProtocolError);
    await expect(mismatch).rejects.toThrow(/output schema|structured content/i);

    const missing = client.callTool({ name: 'structured-missing', arguments: {} });
    await expect(missing).rejects.toBeInstanceOf(ProtocolError);
    await expect(missing).rejects.toThrow(/did not return structured content/i);
});

verifies('client:output-schema:skip-on-error', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, schemaServer, client);

    const { tools } = await client.listTools();
    expect(tools.find(t => t.name === 'structured-error-skip')?.outputSchema).toMatchObject({
        type: 'object',
        properties: { value: { type: 'number' } }
    });

    const r = await client.callTool({ name: 'structured-error-skip', arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(r.content).toEqual([{ type: 'text', text: 'handler-returned-isError' }]);
});

verifies('typescript:mcpserver:output-schema:server-validate', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, schemaServer, client);

    // Cold call — no listTools() — so any validation observed is server-side.
    const r = await client.callTool({ name: 'structured-mismatch', arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(r.content).toEqual([{ type: 'text', text: expect.stringMatching(/Output validation error.*structured-mismatch/i) }]);
});

verifies('mcpserver:output-schema:missing-structured', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, schemaServer, client);

    const r = await client.callTool({ name: 'structured-missing', arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(r.content).toEqual([{ type: 'text', text: expect.stringMatching(/Output validation error/i) }]);
    expect(r.content).not.toEqual([{ type: 'text', text: 'handler-body-no-structured' }]);

    // Postcondition: the tool really did advertise an outputSchema.
    const { tools } = await client.listTools();
    expect(tools.find(t => t.name === 'structured-missing')?.outputSchema).toMatchObject({
        type: 'object',
        properties: { value: { type: 'number' } }
    });
});

verifies('mcpserver:output-schema:skip-on-error', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, schemaServer, client);

    const { tools } = await client.listTools();
    expect(tools.find(t => t.name === 'structured-error-skip')?.outputSchema).toMatchObject({
        type: 'object',
        properties: { value: { type: 'number' } }
    });

    const r = await client.callTool({ name: 'structured-error-skip', arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: 'text', text: 'handler-returned-isError' }]);
    expect(r.structuredContent).toBeUndefined();
});

verifies('tools:list:basic', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'echo',
            { description: 'Echoes the input text back as a text content block.', inputSchema: z.object({ text: z.string() }) },
            ({ text }) => ({ content: [{ type: 'text', text }] })
        );
        s.registerTool('second', { description: 'Another tool.', inputSchema: z.object({}) }, () => ({ content: [] }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(2);
    for (const t of tools) {
        expect(typeof t.name).toBe('string');
        expect(t.inputSchema).toMatchObject({ type: 'object' });
    }
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['echo', 'second']));
    expect(tools.find(t => t.name === 'echo')).toMatchObject({
        name: 'echo',
        description: 'Echoes the input text back as a text content block.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
    });
});

verifies('tools:list:metadata', async ({ transport }: TestArgs) => {
    const annotated: Tool = {
        name: 'annotated',
        title: 'Annotated Tool',
        description: 'Carries every optional listing field.',
        inputSchema: { type: 'object' },
        annotations: {
            title: 'Annotated Tool',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        },
        _meta: { 'example.com/fixture': true },
        execution: { taskSupport: 'forbidden' },
        icons: [{ src: 'https://example.com/tool.png', mimeType: 'image/png', sizes: ['48x48'] }]
    };
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler('tools/list', () => ({ tools: [annotated] }));
        s.setRequestHandler('tools/call', () => ({ content: [] }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'annotated');
    expect(tool).toBeDefined();
    expect(tool!.title).toBe('Annotated Tool');
    expect(tool!.annotations).toEqual(annotated.annotations);
    expect(tool!._meta).toEqual({ 'example.com/fixture': true });
    expect(tool!.execution).toEqual({ taskSupport: 'forbidden' });
    expect(tool!.icons).toEqual([{ src: 'https://example.com/tool.png', mimeType: 'image/png', sizes: ['48x48'] }]);
});

verifies(
    'tools:list:pagination',
    async ({ transport }: TestArgs) => {
        const TOTAL = 25;
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            for (let i = 0; i < TOTAL; i++) {
                s.registerTool(`bulk_${String(i).padStart(2, '0')}`, { inputSchema: z.object({}) }, () => ({ content: [] }));
            }
            return s;
        };
        const client = newClient();
        await using _ = await wire(transport, makeServer, client);

        // No-arg listTools() auto-aggregates every page.
        const all = await client.listTools();
        expect(all.tools.length).toBe(TOTAL);
        expect(all.nextCursor).toBeUndefined();
        expect(new Set(all.tools.map(t => t.name)).size).toBe(TOTAL);
    },
    { title: 'mcpserver' }
);

verifies(
    'tools:list:pagination',
    async ({ transport }: TestArgs) => {
        const TOTAL = 25;
        const PAGE = 10;
        const all = Array.from({ length: TOTAL }, (_, i) => `bulk_${String(i).padStart(2, '0')}`);
        // Recorder lives OUTSIDE the factory so every server instance shares it.
        const cursorsReceived: Array<string | undefined> = [];

        const makeServer = () => {
            const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
            s.setRequestHandler('tools/list', req => {
                cursorsReceived.push(req.params?.cursor);
                const start = req.params?.cursor === undefined ? 0 : Number.parseInt(req.params.cursor, 10);
                const slice = all.slice(start, start + PAGE);
                return {
                    tools: slice.map(name => ({ name, inputSchema: { type: 'object' as const } })),
                    nextCursor: start + PAGE < TOTAL ? String(start + PAGE) : undefined
                };
            });
            s.setRequestHandler('tools/call', () => ({ content: [] }));
            return s;
        };
        const client = newClient();
        await using _ = await wire(transport, makeServer, client);

        // No-arg listTools() auto-aggregates every page; the server receives
        // the cursor walk verbatim (protocol-level pagination is what is
        // verified here).
        const result = await client.listTools();
        expect(result.nextCursor).toBeUndefined();
        const seen = new Set(result.tools.map(t => t.name));
        expect(seen.size).toBe(TOTAL);
        for (const name of all) expect(seen.has(name)).toBe(true);
        expect(cursorsReceived).toEqual([undefined, '10', '20']);

        // Explicit cursor → one raw page (per-page path).
        const page = await client.listTools({ cursor: '10' });
        expect(page.tools.length).toBe(PAGE);
        expect(page.nextCursor).toBe('20');
    },
    { title: 'raw server' }
);

verifies('tools:list-changed', async ({ transport }: TestArgs) => {
    let server!: McpServer;
    const makeServer = () => {
        server = new McpServer({ name: 's', version: '0' });
        server.registerTool('seed', { inputSchema: z.object({}) }, () => ({ content: [] }));
        return server;
    };

    let listChanged = 0;
    const client = newClient();
    client.setNotificationHandler('notifications/tools/list_changed', () => {
        listChanged++;
    });

    await using _ = await wire(transport, makeServer, client);

    const initialList = await client.listTools();
    expect(initialList.tools.length).toBe(1);

    const handle = server.registerTool('dynamic-probe', { inputSchema: z.object({}) }, () => ({ content: [] }));
    await vi.waitFor(() => expect(listChanged).toBeGreaterThanOrEqual(1));
    const listAfterAdd = await client.listTools();
    expect(listAfterAdd.tools.length).toBe(2);
    const afterAdd = listChanged;

    handle.remove();
    await vi.waitFor(() => expect(listChanged).toBeGreaterThan(afterAdd));
    const listAfterRemove = await client.listTools();
    expect(listAfterRemove.tools.length).toBe(1);
});

verifies('tools:capability:declared', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        // Ctor declares only `tools: {}`. McpServer.registerTool must derive
        // `listChanged: true` itself via registerCapabilities.
        const s = new McpServer({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.registerTool('echo', { inputSchema: z.object({}) }, () => ({ content: [] }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const caps = client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(caps?.tools?.listChanged).toBe(true);
});

verifies('tools:input-schema:json-schema-2020-12', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, rawJsonSchemaServer, client);

    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'json-schema');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({ type: 'object' });

    const r = await client.callTool({ name: 'json-schema', arguments: { point: { x: 3, y: 4 } } });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: '(3, 4)' }]);
});

verifies('tools:input-schema:preserve-defs', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, rawJsonSchemaServer, client);

    const { tools } = await client.listTools();
    const schema = tools.find(t => t.name === 'json-schema')!.inputSchema as Record<string, unknown>;

    expect(schema.$defs).toEqual(JSON_SCHEMA_2020_12_INPUT.$defs);
    expect(schema.properties).toEqual({ point: { $ref: '#/$defs/Point' } });
    expect(schema).not.toHaveProperty('definitions');
});

verifies('tools:input-schema:preserve-schema-dialect', async ({ transport }: TestArgs) => {
    // Two distinct dialects must round-trip verbatim — guards against the
    // SDK's listing path stamping a single default $schema onto every schema.
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler('tools/list', () => ({
            tools: [
                { name: 'draft07', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' } },
                { name: 'v2020', inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' } }
            ]
        }));
        s.setRequestHandler('tools/call', () => ({ content: [] }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const { tools } = await client.listTools();
    const draft07 = tools.find(t => t.name === 'draft07')!.inputSchema.$schema;
    const v2020 = tools.find(t => t.name === 'v2020')!.inputSchema.$schema;
    expect(draft07).toBe('http://json-schema.org/draft-07/schema#');
    expect(v2020).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(draft07).not.toBe(v2020);
});

verifies('tools:input-schema:preserve-additional-properties', async ({ transport }: TestArgs) => {
    // Three explicit values must round-trip verbatim — guards against the
    // SDK's listing path stamping a single constant onto every schema.
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler('tools/list', () => ({
            tools: [
                { name: 'strict', inputSchema: { type: 'object', additionalProperties: false } },
                { name: 'open', inputSchema: { type: 'object', additionalProperties: true } },
                { name: 'absent', inputSchema: { type: 'object' } }
            ]
        }));
        s.setRequestHandler('tools/call', () => ({ content: [] }));
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const { tools } = await client.listTools();
    const get = (name: string) => tools.find(t => t.name === name)!.inputSchema as Record<string, unknown>;
    expect(get('strict').additionalProperties).toBe(false);
    expect(get('open').additionalProperties).toBe(true);
    expect(get('absent')).not.toHaveProperty('additionalProperties');
    expect(get('strict').additionalProperties).not.toBe(get('open').additionalProperties);
});

verifies('typescript:mcpserver:tool:handler-throws', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('throws', { inputSchema: z.object({ message: z.string() }) }, ({ message }) => {
            throw new Error(message);
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'throws', arguments: { message: 'kaboom' } });
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: 'text', text: 'kaboom' }]);
});

verifies('mcpserver:tool:duplicate-name', async ({ transport }: TestArgs) => {
    let dupError: unknown;
    const makeServer = () => {
        const s = echoServer();
        // Positive control: a fresh name registers fine.
        s.registerTool('fresh', { inputSchema: z.object({}) }, () => ({ content: [] }));
        // Duplicate throws at registration time.
        try {
            s.registerTool('echo', { inputSchema: z.object({}) }, () => ({ content: [] }));
        } catch (error) {
            dupError = error;
        }
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    expect(dupError).toBeInstanceOf(Error);
    expect(String(dupError)).toMatch(/already registered/i);

    // Original survives the failed duplicate registration.
    const { tools } = await client.listTools();
    expect(tools.filter(t => t.name === 'echo')).toHaveLength(1);
    expect(tools.map(t => t.name)).toContain('fresh');
    const r = await client.callTool({ name: 'echo', arguments: { text: 'still here' } });
    expect(r.content).toEqual([{ type: 'text', text: 'still here' }]);
});

verifies('mcpserver:tool:handle-update', async ({ transport }: TestArgs) => {
    let handle!: RegisteredTool;
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        handle = s.registerTool('echo', { description: 'v1', inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        return s;
    };

    let listChanged = 0;
    const client = newClient();
    client.setNotificationHandler('notifications/tools/list_changed', () => {
        listChanged++;
    });
    await using _ = await wire(transport, makeServer, client);

    const beforeResult = await client.listTools();
    const beforeList = beforeResult.tools;
    expect(beforeList.length).toBe(1);
    const before = beforeList.find(t => t.name === 'echo')!;
    expect(before.description).toBe('v1');
    expect(before.inputSchema.properties).toHaveProperty('text');
    const beforeCall = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(beforeCall.content).toEqual([{ type: 'text', text: 'hi' }]);

    handle.update({
        description: 'v2 — replaced via RegisteredTool.update()',
        paramsSchema: z.object({}),
        callback: () => ({ content: [{ type: 'text', text: 'echo-v2-handler' }] })
    });

    await vi.waitFor(() => expect(listChanged).toBeGreaterThanOrEqual(1));

    const afterResult = await client.listTools();
    const afterList = afterResult.tools;
    expect(afterList.length).toBe(1);
    const after = afterList.find(t => t.name === 'echo')!;
    expect(after.description).toBe('v2 — replaced via RegisteredTool.update()');
    expect(after.inputSchema.properties ?? {}).not.toHaveProperty('text');

    const r = await client.callTool({ name: 'echo', arguments: {} });
    expect(r.content).toEqual([{ type: 'text', text: 'echo-v2-handler' }]);
});

verifies('mcpserver:tool:input-validation', async ({ transport }: TestArgs) => {
    // Shared across factory calls so stateless still observes the count.
    const handlerCalls = { n: 0 };
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('typed', { inputSchema: z.object({ prompt: z.string() }) }, () => {
            handlerCalls.n++;
            return { content: [{ type: 'text', text: 'ran' }] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const ok = await client.callTool({ name: 'typed', arguments: { prompt: 'hello' } });
    expect(ok.isError).toBeFalsy();
    expect(handlerCalls.n).toBe(1);

    const wrongType = await client.callTool({ name: 'typed', arguments: { prompt: 123 } });
    expect(wrongType.isError).toBe(true);
    expect(wrongType.content).toEqual([{ type: 'text', text: expect.stringMatching(/invalid|validation/i) }]);
    expect(handlerCalls.n).toBe(1);

    const missing = await client.callTool({ name: 'typed', arguments: {} });
    expect(missing.isError).toBe(true);
    expect(missing.content).toEqual([{ type: 'text', text: expect.stringMatching(/invalid|validation|required/i) }]);
    expect(handlerCalls.n).toBe(1);
});

verifies('mcpserver:tool:naming-validation', async ({ transport }: TestArgs) => {
    const INVALID = ['has space', 'has/slash', 'has:colon', 'naïve'] as const;
    const VALID = ['A.b-c_1', 'snake_case_ok'] as const;

    const warnedFor: string[] = [];
    const cleanFor: string[] = [];

    const makeServer = () => {
        const s = echoServer();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            for (const name of [...INVALID, ...VALID]) {
                warn.mockClear();
                s.registerTool(name, { inputSchema: z.object({}) }, () => ({ content: [] }));
                if (warn.mock.calls.some(c => c.some(a => String(a).includes(name)))) {
                    warnedFor.push(name);
                } else if (warn.mock.calls.length === 0) {
                    cleanFor.push(name);
                }
            }
        } finally {
            warn.mockRestore();
        }
        return s;
    };

    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    for (const bad of INVALID) expect(warnedFor).toContain(bad);
    for (const good of VALID) expect(cleanFor).toContain(good);

    const listed = await client.listTools();
    const names = listed.tools.map(t => t.name);
    for (const good of VALID) expect(names).toContain(good);
});

verifies('mcpserver:tool:url-elicitation-error', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('needs-auth', { inputSchema: z.object({}) }, () => {
            throw new UrlElicitationRequiredError([
                {
                    mode: 'url',
                    message: 'Please sign in to continue.',
                    elicitationId: 'fixture-url-elicit-1',
                    url: 'https://example.com/auth?state=fixture'
                }
            ]);
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const err = await client.callTool({ name: 'needs-auth', arguments: {} }).catch((error: unknown) => error);
    if (!(err instanceof UrlElicitationRequiredError)) {
        throw new Error(`expected UrlElicitationRequiredError, got ${JSON.stringify(err)}`);
    }
    expect(err.code).toBe(ProtocolErrorCode.UrlElicitationRequired);
    expect(err.elicitations).toEqual([
        {
            mode: 'url',
            message: 'Please sign in to continue.',
            elicitationId: 'fixture-url-elicit-1',
            url: 'https://example.com/auth?state=fixture'
        }
    ]);
});

/** Zod union/intersection/transform/preprocess/pipe schemas: discoverable in tools/list and validate+coerce before the handler. */
verifies('typescript:mcpserver:tool:schema-variants', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'zod-union',
            {
                inputSchema: z.discriminatedUnion('kind', [
                    z.object({ kind: z.literal('a'), a: z.string() }),
                    z.object({ kind: z.literal('b'), b: z.number() })
                ])
            },
            args => ({
                content: [{ type: 'text', text: args.kind === 'a' ? `a:${args.a}` : `b:${args.b}` }]
            })
        );
        s.registerTool(
            'zod-intersection',
            { inputSchema: z.intersection(z.object({ left: z.string() }), z.object({ right: z.string() })) },
            ({ left, right }) => ({ content: [{ type: 'text', text: `${left}|${right}` }] })
        );
        s.registerTool(
            'zod-nested',
            { inputSchema: z.object({ outer: z.object({ inner: z.object({ value: z.number() }) }) }) },
            ({ outer }) => ({ content: [{ type: 'text', text: String(outer.inner.value) }] })
        );
        s.registerTool(
            'zod-coerce',
            {
                inputSchema: z.object({
                    n: z
                        .preprocess(v => (typeof v === 'string' ? v.trim() : v), z.string())
                        .transform(Number)
                        .pipe(z.number().int().nonnegative())
                })
            },
            ({ n }) => ({ content: [{ type: 'text', text: `coerced:${n}` }] })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const unionA = await client.callTool({ name: 'zod-union', arguments: { kind: 'a', a: 'hello' } });
    expect(unionA.content).toEqual([{ type: 'text', text: 'a:hello' }]);
    const unionB = await client.callTool({ name: 'zod-union', arguments: { kind: 'b', b: 42 } });
    expect(unionB.content).toEqual([{ type: 'text', text: 'b:42' }]);
    const intersection = await client.callTool({ name: 'zod-intersection', arguments: { left: 'L', right: 'R' } });
    expect(intersection.content).toEqual([{ type: 'text', text: 'L|R' }]);
    const nested = await client.callTool({ name: 'zod-nested', arguments: { outer: { inner: { value: 5 } } } });
    expect(nested.content).toEqual([{ type: 'text', text: '5' }]);
    const coerced = await client.callTool({ name: 'zod-coerce', arguments: { n: '  7  ' } });
    expect(coerced.content).toEqual([{ type: 'text', text: 'coerced:7' }]);

    // Rejections — proves parse() actually runs for each shape.
    const unionRejected = await client.callTool({ name: 'zod-union', arguments: { kind: 'a', a: 123 } });
    expect(unionRejected.isError).toBe(true);
    const intersectionRejected = await client.callTool({ name: 'zod-intersection', arguments: { left: 'L' } });
    expect(intersectionRejected.isError).toBe(true);
    const nestedRejected = await client.callTool({ name: 'zod-nested', arguments: { outer: { inner: { value: 'x' } } } });
    expect(nestedRejected.isError).toBe(true);
    const coerceRejected = await client.callTool({ name: 'zod-coerce', arguments: { n: '-3' } });
    expect(coerceRejected.isError).toBe(true);
});

verifies('typescript:mcpserver:tool:extra', async ({ transport }: TestArgs) => {
    // Asserts the always-present RequestHandlerExtra fields. authInfo /
    // requestInfo need a bearer-auth host (not provided by `wire()`); see
    // hosting tests for those. Recorder lives outside the factory so every
    // server instance writes to the same slot.
    const seen: Array<{ sessionId?: string; requestId: RequestId; hasSignal: boolean; hasSend: boolean }> = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('report-extra', { inputSchema: z.object({}) }, (_a, ctx) => {
            seen.push({
                sessionId: ctx.sessionId,
                requestId: ctx.mcpReq.id,
                hasSignal: ctx.mcpReq.signal instanceof AbortSignal,
                hasSend: typeof ctx.mcpReq.notify === 'function' && typeof ctx.mcpReq.send === 'function'
            });
            return { content: [] };
        });
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    await client.callTool({ name: 'report-extra', arguments: {} });
    await client.callTool({ name: 'report-extra', arguments: {} });
    expect(seen).toHaveLength(2);

    for (const r of seen) {
        expect(['string', 'number']).toContain(typeof r.requestId);
        expect(r.hasSignal).toBe(true);
        expect(r.hasSend).toBe(true);
        const clientSessionId = client.transport?.sessionId;
        if (clientSessionId !== undefined) expect(r.sessionId).toBe(clientSessionId);
    }
    const [firstCallSeen, secondCallSeen] = seen;
    if (firstCallSeen === undefined || secondCallSeen === undefined) throw new Error('expected both calls to be recorded');
    expect(secondCallSeen.requestId).not.toBe(firstCallSeen.requestId);
});

verifies('mcpserver:tool:metadata-roundtrip', async ({ transport }: TestArgs) => {
    // registerTool's public config carries title, description, annotations and _meta (no icons field), so those are asserted verbatim.
    const annotations = {
        title: 'Annotated Echo',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
    };
    const meta = { 'example.com/source': 'metadata-roundtrip-fixture', 'example.com/revision': 3 };
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'annotated-echo',
            {
                title: 'Annotated Echo',
                description: 'Echo tool carrying every metadata field registerTool accepts.',
                inputSchema: z.object({ text: z.string() }),
                annotations,
                _meta: meta
            },
            ({ text }) => ({ content: [{ type: 'text', text }] })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    if (tool === undefined) throw new Error('expected the registered tool to be listed');
    expect(tool.name).toBe('annotated-echo');
    expect(tool.title).toBe('Annotated Echo');
    expect(tool.description).toBe('Echo tool carrying every metadata field registerTool accepts.');
    expect(tool.annotations).toEqual(annotations);
    expect(tool._meta).toEqual(meta);
});
