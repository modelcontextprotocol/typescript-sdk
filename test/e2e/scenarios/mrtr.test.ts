/**
 * Multi round-trip requests (SEP-2322, protocol revision 2026-07-28) through
 * the public surface: a write-once tool returning inputRequired() is
 * fulfilled by the client's registered elicitation handler and retried with
 * fresh ids + a byte-exact requestState echo; push-style server→client APIs
 * loud-fail on 2026-era requests with the inputRequired() steer; URL-mode
 * elicitation rides the flow with zero -32042 on the 2026 wire; the
 * auto-fulfilment driver is bounded by inputRequired.maxRounds; and 2025-era
 * serving keeps the exact -32042 behavior (the freeze cell).
 *
 * The 2026-era cells run on the entryModern arm (per-request modern hosting);
 * raw wire facts are asserted on the arm-recorded HTTP exchanges.
 */
import { Client, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { acceptedContent, inputRequired, McpServer, ProtocolError, UrlElicitationRequiredError } from '@modelcontextprotocol/server';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import type { Wired } from '../helpers/index';
import { wire } from '../helpers/index';
import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

/** Every JSON-RPC request the wired client POSTed for the given method, in order. */
function recordedRequests(wired: Wired, method: string): Array<Record<string, unknown>> {
    const requests: Array<Record<string, unknown>> = [];
    for (const exchange of wired.httpLog ?? []) {
        if (exchange.requestBody === undefined) continue;
        try {
            const parsed = JSON.parse(exchange.requestBody) as Record<string, unknown>;
            if (parsed.method === method) requests.push(parsed);
        } catch {
            // Not a JSON body (e.g. an empty notification POST) — skip it.
        }
    }
    return requests;
}

/** All recorded HTTP bytes (request bodies + response bodies) concatenated, for absence assertions. */
async function allRecordedBytes(wired: Wired): Promise<string> {
    const responses = await Promise.all((wired.httpLog ?? []).map(exchange => exchange.response.text()));
    const requests = (wired.httpLog ?? []).map(exchange => exchange.requestBody ?? '');
    return [...requests, ...responses].join('\n');
}

const CONFIRM_SCHEMA = { type: 'object' as const, properties: { confirm: { type: 'boolean' as const } }, required: ['confirm'] };

verifies('typescript:mrtr:tools-call:write-once-roundtrip', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const server = new McpServer({ name: 'mrtr-server', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('deploy', { inputSchema: z.object({ env: z.string() }) }, async ({ env }, ctx) => {
            const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
            if (!confirmed?.confirm) {
                return inputRequired({
                    inputRequests: { confirm: inputRequired.elicit({ message: `Deploy to ${env}?`, requestedSchema: CONFIRM_SCHEMA }) },
                    requestState: 'opaque-deploy-state'
                });
            }
            return { content: [{ type: 'text', text: `deployed to ${env}` }] };
        });
        return server;
    };

    const client = new Client({ name: 'mrtr-client', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
    const handled: unknown[] = [];
    client.setRequestHandler('elicitation/create', async request => {
        handled.push(request.params);
        return { action: 'accept', content: { confirm: true } };
    });

    await using wired = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'deploy', arguments: { env: 'prod' } });
    expect(result.content).toEqual([{ type: 'text', text: 'deployed to prod' }]);
    expect('resultType' in result).toBe(false);

    // The registered handler fulfilled the embedded elicitation.
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ mode: 'form', message: 'Deploy to prod?' });

    // Two independent wire legs with fresh ids; the retry carries the bare
    // response and the byte-exact requestState echo alongside the original params.
    const toolCalls = recordedRequests(wired, 'tools/call');
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]!.id).not.toEqual(toolCalls[1]!.id);
    const retryParams = toolCalls[1]!.params as Record<string, unknown>;
    expect(retryParams.name).toBe('deploy');
    expect(retryParams.arguments).toEqual({ env: 'prod' });
    expect(retryParams.requestState).toBe('opaque-deploy-state');
    expect(retryParams.inputResponses).toEqual({ confirm: { action: 'accept', content: { confirm: true } } });
});

verifies('typescript:mrtr:push-api:loud-fail-2026', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const server = new McpServer({ name: 'mrtr-server', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('legacy-style', { inputSchema: z.object({}) }, async (_args, ctx) => {
            // The pre-2026 pattern: pushing a server→client elicitation request.
            const answer = await ctx.mcpReq.elicitInput({ message: 'Name?', requestedSchema: { type: 'object', properties: {} } });
            return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
        });
        return server;
    };

    const client = new Client({ name: 'mrtr-client', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: {} }));

    await using wired = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'legacy-style', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('inputRequired(');

    // The attempted server→client request never produced wire traffic: no
    // elicitation/create request appears in any recorded exchange.
    const bytes = await allRecordedBytes(wired);
    expect(bytes).not.toContain('"method":"elicitation/create"');
});

verifies('typescript:mrtr:url-elicitation:no-32042-on-2026', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const server = new McpServer({ name: 'mrtr-server', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('protected', { inputSchema: z.object({}) }, async (_args, ctx) => {
            if (ctx.mcpReq.inputResponses?.['auth'] !== undefined) {
                return { content: [{ type: 'text', text: 'authorized' }] };
            }
            // The 2026-07-28 idiom: return an embedded URL-mode elicitation
            // (the 2025-style throw is not converted on this era).
            return inputRequired({
                inputRequests: {
                    auth: inputRequired.elicitUrl({
                        message: 'Sign in to continue',
                        url: 'https://example.com/auth'
                    })
                }
            });
        });
        return server;
    };

    const client = new Client({ name: 'mrtr-client', version: '1.0.0' }, { capabilities: { elicitation: { url: {} } } });
    const seenUrlRequests: unknown[] = [];
    client.setRequestHandler('elicitation/create', async request => {
        seenUrlRequests.push(request.params);
        // URL mode: the user completes the interaction out of band; the
        // response carries no content.
        return { action: 'accept' };
    });

    await using wired = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'protected', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'authorized' }]);
    expect(seenUrlRequests).toHaveLength(1);
    expect(seenUrlRequests[0]).toMatchObject({ mode: 'url', url: 'https://example.com/auth' });

    // The -32042 error code never appears on the 2026 wire; the
    // input_required result is what travelled instead.
    const bytes = await allRecordedBytes(wired);
    expect(bytes).not.toContain('32042');
    expect(bytes).toContain('"resultType":"input_required"');
});

verifies('typescript:mrtr:rounds-cap', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const server = new McpServer({ name: 'mrtr-server', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('insatiable', { inputSchema: z.object({}) }, async () =>
            inputRequired({
                inputRequests: { more: inputRequired.elicit({ message: 'More input?', requestedSchema: CONFIRM_SCHEMA }) },
                requestState: 'never-enough'
            })
        );
        return server;
    };

    const client = new Client(
        { name: 'mrtr-client', version: '1.0.0' },
        { capabilities: { elicitation: { form: {} } }, inputRequired: { maxRounds: 2 } }
    );
    client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { confirm: true } }));

    await using wired = await wire(transport, makeServer, client);

    const outcome = await client.callTool({ name: 'insatiable', arguments: {} }).then(
        value => ({ resolved: value as unknown }),
        error => ({ rejected: error as unknown })
    );
    expect('rejected' in outcome, 'the call must not resolve').toBe(true);
    const rejection = (outcome as { rejected: unknown }).rejected;
    expect(rejection).toBeInstanceOf(SdkError);
    expect((rejection as SdkError).code).toBe(SdkErrorCode.InputRequiredRoundsExceeded);
    expect((rejection as SdkError).data).toMatchObject({ rounds: 2, lastResult: { requestState: 'never-enough' } });

    // The cap bounded the wire traffic: the original call plus exactly two retries.
    expect(recordedRequests(wired, 'tools/call')).toHaveLength(3);
});

// 2026-era siblings of the push-style sampling/elicitation/roots round-trips:
// each body returns inputRequired() with an embedded request, the client
// auto-fulfilment driver dispatches it to the locally registered handler, and
// the retried tool handler reads the response from ctx.mcpReq.inputResponses.

verifies('sampling:mrtr:create:basic', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const server = new McpServer({ name: 'mrtr-sampling', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('summarize', { inputSchema: z.object({ text: z.string() }) }, async ({ text }, ctx) => {
            const completion = ctx.mcpReq.inputResponses?.['llm'] as
                | { role: string; content: { type: string; text: string }; model: string; stopReason: string }
                | undefined;
            if (completion === undefined) {
                return inputRequired({
                    inputRequests: {
                        llm: inputRequired.createMessage({
                            messages: [{ role: 'user', content: { type: 'text', text: `Summarize: ${text}` } }],
                            maxTokens: 64
                        })
                    }
                });
            }
            return { structuredContent: { completion }, content: [{ type: 'text', text: completion.content.text }] };
        });
        return server;
    };

    const seen: unknown[] = [];
    const client = new Client({ name: 'mrtr-client', version: '1.0.0' }, { capabilities: { sampling: {} } });
    client.setRequestHandler('sampling/createMessage', async request => {
        seen.push(request.params);
        return { role: 'assistant', content: { type: 'text', text: 'a brief summary' }, model: 'stub-model', stopReason: 'endTurn' };
    });

    await using wired = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'summarize', arguments: { text: 'hello world' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
        completion: { role: 'assistant', content: { type: 'text', text: 'a brief summary' }, model: 'stub-model', stopReason: 'endTurn' }
    });

    // The embedded request reached the registered handler exactly once.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ messages: [{ role: 'user', content: { type: 'text', text: 'Summarize: hello world' } }] });

    // Two independent wire legs: original + retry carrying the bare response.
    const toolCalls = recordedRequests(wired, 'tools/call');
    expect(toolCalls).toHaveLength(2);
    const retryParams = toolCalls[1]!.params as Record<string, unknown>;
    expect(retryParams.inputResponses).toMatchObject({
        llm: { role: 'assistant', content: { type: 'text', text: 'a brief summary' }, model: 'stub-model', stopReason: 'endTurn' }
    });
});

verifies(
    ['sampling:mrtr:create:model-preferences', 'sampling:mrtr:create:system-prompt', 'sampling:mrtr:create:include-context'],
    async ({ transport }: TestArgs) => {
        const PREFS = { hints: [{ name: 'stub-model' }], costPriority: 0.2, speedPriority: 0.5, intelligencePriority: 0.9 };
        const makeServer = () => {
            const server = new McpServer({ name: 'mrtr-sampling', version: '1.0.0' }, { capabilities: { tools: {} } });
            server.registerTool('ask', { inputSchema: z.object({}) }, async (_args, ctx) => {
                if (ctx.mcpReq.inputResponses?.['llm'] !== undefined) {
                    return { content: [{ type: 'text', text: 'ok' }] };
                }
                return inputRequired({
                    inputRequests: {
                        llm: inputRequired.createMessage({
                            messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
                            maxTokens: 16,
                            systemPrompt: 'You are a terse assistant.',
                            includeContext: 'none',
                            modelPreferences: PREFS
                        })
                    }
                });
            });
            return server;
        };

        const seen: Array<Record<string, unknown>> = [];
        const client = new Client({ name: 'mrtr-client', version: '1.0.0' }, { capabilities: { sampling: {} } });
        client.setRequestHandler('sampling/createMessage', async request => {
            seen.push(request.params as Record<string, unknown>);
            return { role: 'assistant', content: { type: 'text', text: 'hi' }, model: 'stub-model', stopReason: 'endTurn' };
        });

        await using _ = await wire(transport, makeServer, client);

        const result = await client.callTool({ name: 'ask', arguments: {} });
        expect(result.isError).toBeFalsy();
        expect(seen).toHaveLength(1);
        expect(seen[0]?.systemPrompt).toBe('You are a terse assistant.');
        expect(seen[0]?.includeContext).toBe('none');
        expect(seen[0]?.modelPreferences).toEqual(PREFS);
    }
);

verifies('elicitation:mrtr:form:basic', async ({ transport }: TestArgs) => {
    const SCHEMA = {
        type: 'object' as const,
        properties: { name: { type: 'string' as const, description: 'Your name' } },
        required: ['name']
    };
    const makeServer = () => {
        const server = new McpServer({ name: 'mrtr-elicit', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('greet', { inputSchema: z.object({}) }, async (_args, ctx) => {
            const answered = acceptedContent<{ name: string }>(ctx.mcpReq.inputResponses, 'who');
            if (answered === undefined) {
                return inputRequired({
                    inputRequests: { who: inputRequired.elicit({ message: 'What is your name?', requestedSchema: SCHEMA }) }
                });
            }
            return { content: [{ type: 'text', text: `hello ${answered.name}` }] };
        });
        return server;
    };

    const seen: unknown[] = [];
    const client = new Client({ name: 'mrtr-client', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler('elicitation/create', async request => {
        seen.push(request.params);
        return { action: 'accept', content: { name: 'Ada' } };
    });

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'greet', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'hello Ada' }]);

    // The embedded request delivered message + schema exactly as sent.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ mode: 'form', message: 'What is your name?', requestedSchema: SCHEMA });
});

verifies('elicitation:mrtr:form:action:decline', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const server = new McpServer({ name: 'mrtr-elicit', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('ask', { inputSchema: z.object({}) }, async (_args, ctx) => {
            const responses = ctx.mcpReq.inputResponses;
            if (responses === undefined) {
                return inputRequired({
                    inputRequests: { confirm: inputRequired.elicit({ message: 'Proceed?', requestedSchema: CONFIRM_SCHEMA }) }
                });
            }
            const raw = responses['confirm'] as { action: string; content?: unknown };
            return {
                structuredContent: { action: raw.action, accepted: acceptedContent(responses, 'confirm') !== undefined },
                content: []
            };
        });
        return server;
    };

    const client = new Client({ name: 'mrtr-client', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler('elicitation/create', async () => ({ action: 'decline' }));

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'ask', arguments: {} });
    expect(result.structuredContent).toEqual({ action: 'decline', accepted: false });
});

verifies('elicitation:mrtr:form:action:cancel', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const server = new McpServer({ name: 'mrtr-elicit', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('ask', { inputSchema: z.object({}) }, async (_args, ctx) => {
            const responses = ctx.mcpReq.inputResponses;
            if (responses === undefined) {
                return inputRequired({
                    inputRequests: { confirm: inputRequired.elicit({ message: 'Proceed?', requestedSchema: CONFIRM_SCHEMA }) }
                });
            }
            const raw = responses['confirm'] as { action: string; content?: unknown };
            return {
                structuredContent: { action: raw.action, accepted: acceptedContent(responses, 'confirm') !== undefined },
                content: []
            };
        });
        return server;
    };

    const client = new Client({ name: 'mrtr-client', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler('elicitation/create', async () => ({ action: 'cancel' }));

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'ask', arguments: {} });
    expect(result.structuredContent).toEqual({ action: 'cancel', accepted: false });
});

verifies('elicitation:mrtr:form:schema:primitives', async ({ transport }: TestArgs) => {
    const SCHEMA = {
        type: 'object' as const,
        properties: {
            email: { type: 'string' as const, format: 'email' as const },
            age: { type: 'integer' as const },
            score: { type: 'number' as const },
            subscribe: { type: 'boolean' as const }
        },
        required: ['email']
    };
    const makeServer = () => {
        const server = new McpServer({ name: 'mrtr-elicit', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('signup', { inputSchema: z.object({}) }, async (_args, ctx) => {
            if (ctx.mcpReq.inputResponses?.['form'] !== undefined) {
                return { content: [{ type: 'text', text: 'ok' }] };
            }
            return inputRequired({
                inputRequests: { form: inputRequired.elicit({ message: 'Sign up', requestedSchema: SCHEMA }) }
            });
        });
        return server;
    };

    const seen: unknown[] = [];
    const client = new Client({ name: 'mrtr-client', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler('elicitation/create', async request => {
        seen.push(request.params);
        return { action: 'accept', content: { email: 'ada@example.com', age: 36, score: 0.9, subscribe: true } };
    });

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'signup', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ requestedSchema: SCHEMA });
});

verifies('roots:mrtr:list:basic', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const server = new McpServer({ name: 'mrtr-roots', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('list-roots', { inputSchema: z.object({}) }, async (_args, ctx) => {
            const answered = ctx.mcpReq.inputResponses?.['roots'] as { roots: Array<{ uri: string; name?: string }> } | undefined;
            if (answered === undefined) {
                return inputRequired({ inputRequests: { roots: inputRequired.listRoots() } });
            }
            return { structuredContent: { roots: answered.roots }, content: [] };
        });
        return server;
    };

    const seen: Array<{ method: string }> = [];
    const client = new Client({ name: 'mrtr-client', version: '1.0.0' }, { capabilities: { roots: {} } });
    client.setRequestHandler('roots/list', async request => {
        seen.push({ method: request.method });
        return {
            roots: [{ uri: 'file:///home/user/projects/myproject', name: 'My Project' }, { uri: 'file:///home/user/repos/backend' }]
        };
    });

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'list-roots', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('roots/list');
    expect(result.structuredContent).toEqual({
        roots: [{ uri: 'file:///home/user/projects/myproject', name: 'My Project' }, { uri: 'file:///home/user/repos/backend' }]
    });
});

verifies('roots:mrtr:list:empty', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const server = new McpServer({ name: 'mrtr-roots', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('list-roots', { inputSchema: z.object({}) }, async (_args, ctx) => {
            const answered = ctx.mcpReq.inputResponses?.['roots'] as { roots: unknown[] } | undefined;
            if (answered === undefined) {
                return inputRequired({ inputRequests: { roots: inputRequired.listRoots() } });
            }
            return { structuredContent: { count: answered.roots.length }, content: [] };
        });
        return server;
    };

    const client = new Client({ name: 'mrtr-client', version: '1.0.0' }, { capabilities: { roots: {} } });
    client.setRequestHandler('roots/list', async () => ({ roots: [] }));

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'list-roots', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ count: 0 });
});

verifies('typescript:mrtr:legacy-shim:write-once-on-2025', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const server = new McpServer({ name: 'shim-server', version: '1.0.0' }, { capabilities: { tools: {} } });
        // The SAME write-once shape as the 2026 cell — no era branch: the
        // legacy shim converts the embedded request into a real
        // elicitation/create over the session and re-enters the handler.
        server.registerTool('deploy', { inputSchema: z.object({ env: z.string() }) }, async ({ env }, ctx) => {
            const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
            if (!confirmed?.confirm) {
                return inputRequired({
                    inputRequests: { confirm: inputRequired.elicit({ message: `Deploy to ${env}?`, requestedSchema: CONFIRM_SCHEMA }) },
                    requestState: 'shim-opaque-state'
                });
            }
            return { content: [{ type: 'text', text: `deployed to ${env} (state ${ctx.mcpReq.requestState<string>()})` }] };
        });
        return server;
    };

    const client = new Client({ name: 'shim-client', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
    const elicitations: Array<Record<string, unknown>> = [];
    client.setRequestHandler('elicitation/create', async request => {
        elicitations.push(request.params as Record<string, unknown>);
        return { action: 'accept', content: { confirm: true } };
    });

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'deploy', arguments: { env: 'prod' } });
    expect(result.isError).toBeUndefined();
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe('deployed to prod (state shim-opaque-state)');

    // A REAL elicitation/create reached the client's registered handler.
    expect(elicitations).toHaveLength(1);
    expect(elicitations[0]).toMatchObject({ mode: 'form', message: 'Deploy to prod?' });
});

verifies('typescript:mrtr:legacy-32042-freeze', async ({ transport }: TestArgs) => {
    const URL_PARAMS = {
        mode: 'url' as const,
        message: 'Sign in to continue',
        elicitationId: 'auth-legacy',
        url: 'https://example.com/auth'
    };
    const makeServer = () => {
        const server = new McpServer({ name: 'legacy-url-server', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('protected', { inputSchema: z.object({}) }, async () => {
            throw new UrlElicitationRequiredError([URL_PARAMS]);
        });
        return server;
    };
    const client = new Client({ name: 'legacy-url-client', version: '1.0.0' }, { capabilities: { elicitation: { url: {} } } });

    await using _ = await wire(transport, makeServer, client);

    const outcome = await client.callTool({ name: 'protected', arguments: {} }).then(
        value => ({ resolved: value as unknown }),
        error => ({ rejected: error as unknown })
    );
    expect('rejected' in outcome, 'the -32042 error must surface, not a result').toBe(true);
    const rejection = (outcome as { rejected: unknown }).rejected;
    expect(rejection).toBeInstanceOf(ProtocolError);
    expect((rejection as ProtocolError).code).toBe(-32_042);
    expect((rejection as ProtocolError).data).toEqual({ elicitations: [URL_PARAMS] });
});
