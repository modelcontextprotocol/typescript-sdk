/**
 * Server-side multi-round-trip seam (M4.1):
 *
 * - a handler for tools/call, prompts/get, or resources/read returns an
 *   input-required result on a 2026-07-28-classified request and it reaches
 *   the wire as `resultType: 'input_required'` (validateToolOutput and the
 *   tools/call result schema are skipped for it; cache fields are never
 *   stamped on it);
 * - the guards: at-least-one re-check for hand-built results, the per-embedded
 *   -request `-32021` capability check against the request's OWN envelope
 *   capabilities, the server-bug guard (non-multi-round-trip methods, and any
 *   method on a 2025-era request, never put a mis-typed result on the wire);
 * - a UrlElicitationRequiredError escaping a handler on the modern era fails
 *   LOUDLY (clear steer to inputRequired.elicitUrl(...), never converted) —
 *   `-32042` never reaches the 2026-07-28 wire — while 2025-era traffic keeps
 *   today's `-32042` behavior;
 * - the push-style APIs loud-fail on 2026-era requests with the
 *   `inputRequired(...)` steer surfaced through the tools/call catch-all, with
 *   zero wire traffic emitted for the attempted server→client request;
 * - the write-once re-entry: a retried request's `inputResponses` reach the
 *   handler via ctx and the final result passes full validation.
 */
import type {
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResultResponse
} from '@modelcontextprotocol/core-internal';
import {
    acceptedContent,
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    InMemoryTransport,
    inputRequired,
    LATEST_PROTOCOL_VERSION,
    PROTOCOL_VERSION_META_KEY,
    setNegotiatedProtocolVersion,
    UrlElicitationRequiredError
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import { McpServer } from '../../src/server/mcp.js';
import type { ServerOptions } from '../../src/server/server.js';
import { Server } from '../../src/server/server.js';

const MODERN = '2026-07-28';

const envelope = (clientCapabilities: Record<string, unknown> = {}) => ({
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: 'mrtr-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: clientCapabilities
});

async function wire(server: McpServer | Server, options?: { era?: 'modern' | 'legacy' }) {
    const [peerTx, serverTx] = InMemoryTransport.createLinkedPair();
    const inbound: JSONRPCMessage[] = [];
    const waiters = new Map<string | number, (message: JSONRPCMessage) => void>();
    peerTx.onmessage = message => {
        inbound.push(message);
        const id = (message as { id?: string | number }).id;
        const waiter = id === undefined ? undefined : waiters.get(id);
        if (id !== undefined && waiter) {
            waiters.delete(id);
            waiter(message);
        }
    };
    await server.connect(serverTx);
    await peerTx.start();
    // Era is instance state: a serving entry binds the instance modern; for
    // these unit tests we bind directly via the package-internal setter (the
    // way createMcpHandler/serveStdio do).
    if (options?.era === 'modern') {
        setNegotiatedProtocolVersion(server instanceof Server ? server : server.server, MODERN);
    }

    const request = (message: JSONRPCRequest): Promise<JSONRPCMessage> =>
        new Promise(resolve => {
            waiters.set(message.id, resolve);
            void peerTx.send(message);
        });
    const notify = (message: JSONRPCNotification): Promise<void> => peerTx.send(message);
    return { request, notify, inbound, close: () => server.close() };
}

const modernToolCall = (
    id: number,
    name: string,
    args: Record<string, unknown> = {},
    options?: { clientCapabilities?: Record<string, unknown>; extraParams?: Record<string, unknown> }
): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
        _meta: envelope(options?.clientCapabilities ?? {}),
        name,
        arguments: args,
        ...options?.extraParams
    }
});

const legacyInitialize = (id: number): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'legacy-client', version: '1.0.0' } }
});

function resultOf(message: JSONRPCMessage): Record<string, unknown> {
    return (message as JSONRPCResultResponse).result as unknown as Record<string, unknown>;
}

function errorOf(message: JSONRPCMessage): { code: number; message: string; data?: unknown } {
    return (message as JSONRPCErrorResponse).error;
}

describe('input-required returns on the 2026-07-28 era', () => {
    it('a write-once tool returning inputRequired() reaches the wire as input_required and completes on the retry', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool(
            'deploy',
            { inputSchema: z.object({ env: z.string() }), outputSchema: z.object({ deployed: z.boolean() }) },
            async ({ env }, ctx) => {
                const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
                if (!confirmed?.confirm) {
                    return inputRequired({
                        inputRequests: {
                            confirm: inputRequired.elicit({
                                message: `Deploy to ${env}?`,
                                requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } } }
                            })
                        },
                        requestState: 'opaque-deploy-state'
                    });
                }
                return { content: [{ type: 'text', text: 'deployed' }], structuredContent: { deployed: true } };
            }
        );
        const { request, close } = await wire(server, { era: 'modern' });

        // First leg: input_required goes out, with no cache stamping and the
        // structured-content requirement skipped.
        const first = resultOf(
            await request(modernToolCall(1, 'deploy', { env: 'prod' }, { clientCapabilities: { elicitation: { form: {} } } }))
        );
        expect(first.resultType).toBe('input_required');
        expect(first.requestState).toBe('opaque-deploy-state');
        expect(first.inputRequests).toMatchObject({ confirm: { method: 'elicitation/create' } });
        expect(first.ttlMs).toBeUndefined();
        expect(first.cacheScope).toBeUndefined();
        expect(first.content).toBeUndefined();

        // Retry leg (fresh id, responses + byte-exact echo): full validation
        // applies to the completing result, which is stamped 'complete'.
        const second = resultOf(
            await request(
                modernToolCall(
                    2,
                    'deploy',
                    { env: 'prod' },
                    {
                        clientCapabilities: { elicitation: { form: {} } },
                        extraParams: {
                            inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
                            requestState: 'opaque-deploy-state'
                        }
                    }
                )
            )
        );
        expect(second.resultType).toBe('complete');
        expect(second.structuredContent).toEqual({ deployed: true });

        await close();
    });

    it('prompts/get and resources/read handlers can return input_required (no catch-all rewraps it)', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { prompts: {}, resources: {} } });
        server.registerPrompt('wizard', { argsSchema: z.object({}) }, async () => inputRequired({ requestState: 'prompt-state' }));
        server.registerResource('secret', 'file:///secret.txt', {}, async () => inputRequired({ requestState: 'resource-state' }));
        const { request, close } = await wire(server, { era: 'modern' });

        const promptResult = resultOf(
            await request({
                jsonrpc: '2.0',
                id: 1,
                method: 'prompts/get',
                params: { _meta: envelope(), name: 'wizard', arguments: {} }
            })
        );
        expect(promptResult.resultType).toBe('input_required');
        expect(promptResult.requestState).toBe('prompt-state');

        const resourceResult = resultOf(
            await request({
                jsonrpc: '2.0',
                id: 2,
                method: 'resources/read',
                params: { _meta: envelope(), uri: 'file:///secret.txt' }
            })
        );
        expect(resourceResult.resultType).toBe('input_required');
        expect(resourceResult.requestState).toBe('resource-state');
        expect(resourceResult.ttlMs).toBeUndefined();

        await close();
    });
});

describe('guards', () => {
    it('hand-built results missing both inputRequests and requestState fail loudly (at-least-one re-check)', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('broken', { inputSchema: z.object({}) }, async () => ({ resultType: 'input_required' }) as never);
        const { request, close } = await wire(server, { era: 'modern' });

        const answer = await request(modernToolCall(1, 'broken'));
        expect(errorOf(answer).code).toBe(-32_603);
        expect(JSON.stringify(answer)).not.toContain('"resultType":"input_required"');

        await close();
    });

    it('checks every embedded request against the capabilities the request itself declared (-32021 on violation)', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('ask', { inputSchema: z.object({}) }, async () =>
            inputRequired({
                inputRequests: {
                    confirm: inputRequired.elicit({ message: 'OK?', requestedSchema: { type: 'object', properties: {} } })
                }
            })
        );
        server.registerTool('open-url', { inputSchema: z.object({}) }, async () =>
            inputRequired({
                inputRequests: {
                    auth: inputRequired.elicitUrl({ message: 'Sign in', url: 'https://example.com' })
                }
            })
        );
        const { request, close } = await wire(server, { era: 'modern' });

        // No elicitation capability declared on the request → -32021 naming
        // the form sub-capability the embedded form-mode elicitation needs.
        const noCapability = await request(modernToolCall(1, 'ask', {}, { clientCapabilities: {} }));
        expect(errorOf(noCapability).code).toBe(-32_021);
        expect(errorOf(noCapability).data).toMatchObject({ requiredCapabilities: { elicitation: { form: {} } } });

        // Form-mode capability declared → the same tool is served.
        const withCapability = await request(modernToolCall(2, 'ask', {}, { clientCapabilities: { elicitation: { form: {} } } }));
        expect(resultOf(withCapability).resultType).toBe('input_required');

        // URL-mode embedded request requires elicitation.url specifically.
        const urlWithoutUrlCapability = await request(
            modernToolCall(3, 'open-url', {}, { clientCapabilities: { elicitation: { form: {} } } })
        );
        expect(errorOf(urlWithoutUrlCapability).code).toBe(-32_021);
        expect(errorOf(urlWithoutUrlCapability).data).toMatchObject({ requiredCapabilities: { elicitation: { url: {} } } });

        // Form-mode embedded request toward a URL-only client → -32021: modes
        // are sub-capabilities and the server must not send an undeclared one.
        const formTowardUrlOnly = await request(modernToolCall(4, 'ask', {}, { clientCapabilities: { elicitation: { url: {} } } }));
        expect(errorOf(formTowardUrlOnly).code).toBe(-32_021);
        expect(errorOf(formTowardUrlOnly).data).toMatchObject({ requiredCapabilities: { elicitation: { form: {} } } });

        // A bare `elicitation: {}` declaration is read as form support (the
        // pre-mode meaning of a bare declaration) → served.
        const bareElicitation = await request(modernToolCall(5, 'ask', {}, { clientCapabilities: { elicitation: {} } }));
        expect(resultOf(bareElicitation).resultType).toBe('input_required');

        await close();
    });

    it('a 2025-era request never sees an input_required result: the server fails loudly instead (server-bug guard)', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('deploy', { inputSchema: z.object({}) }, async () => inputRequired({ requestState: 'state' }));
        const { request, close } = await wire(server);

        await request(legacyInitialize(1));
        const answer = await request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'deploy', arguments: {} } });
        expect(errorOf(answer).code).toBe(-32_603);
        // The mis-typed result never reaches the wire: the answer is an error, not a result.
        expect((answer as { result?: unknown }).result).toBeUndefined();

        await close();
    });

    it('non-multi-round-trip methods can never emit input_required (server-bug guard)', async () => {
        const server = new Server({ name: 's', version: '1.0.0' }, { capabilities: { completions: {} } });
        server.setRequestHandler('completion/complete', async () => ({ resultType: 'input_required', requestState: 's' }) as never);
        const { request, close } = await wire(server, { era: 'modern' });

        const answer = await request({
            jsonrpc: '2.0',
            id: 1,
            method: 'completion/complete',
            params: {
                _meta: envelope(),
                ref: { type: 'ref/prompt', name: 'p' },
                argument: { name: 'a', value: 'v' }
            }
        });
        expect(errorOf(answer).code).toBe(-32_603);
        // The mis-typed result never reaches the wire: the answer is an error, not a result.
        expect((answer as { result?: unknown }).result).toBeUndefined();

        await close();
    });
});

describe('UrlElicitationRequiredError (the 2025-era -32042 idiom)', () => {
    const URL_PARAMS = { mode: 'url' as const, message: 'Sign in to continue', elicitationId: 'elicit-7', url: 'https://example.com/auth' };

    function buildUrlThrowingServer() {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('protected', { inputSchema: z.object({}) }, async () => {
            throw new UrlElicitationRequiredError([URL_PARAMS]);
        });
        return server;
    }

    it('fails LOUDLY on a 2026-era request with a clear inputRequired.elicitUrl(...) steer — never converted, never -32042', async () => {
        const { request, close } = await wire(buildUrlThrowingServer(), { era: 'modern' });

        const answer = await request(modernToolCall(1, 'protected', {}, { clientCapabilities: { elicitation: { url: {} } } }));
        expect(errorOf(answer).code).toBe(-32_603);
        expect(errorOf(answer).message).toContain('inputRequired.elicitUrl');
        expect(JSON.stringify(answer)).not.toContain('"resultType":"input_required"');
        // The -32042 error code never appears on the 2026-07-28 wire (the steer
        // text mentions it for migration; the wire error code is InternalError).
        expect(JSON.stringify(answer)).not.toContain('"code":-32042');

        await close();
    });

    it('keeps the exact -32042 behavior for 2025-era traffic', async () => {
        const { request, close } = await wire(buildUrlThrowingServer());

        await request(legacyInitialize(1));
        const answer = await request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'protected', arguments: {} } });
        const error = errorOf(answer);
        expect(error.code).toBe(-32_042);
        expect(error.data).toEqual({ elicitations: [URL_PARAMS] });

        await close();
    });
});

describe('requestState.verify hook', () => {
    function buildServer(options?: ServerOptions) {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} }, ...options });
        const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
        server.registerTool('deploy', { inputSchema: z.object({}) }, handler);
        return { server, handler };
    }

    const reentry = (id: number, requestState?: string) =>
        modernToolCall(id, 'deploy', {}, { extraParams: requestState === undefined ? {} : { requestState } });

    it('is called with the echoed state and the handler context, before the handler', async () => {
        const seen: Array<{ state: string; method: string }> = [];
        const { server, handler } = buildServer({
            requestState: { verify: (state, ctx) => void seen.push({ state, method: ctx.mcpReq.method }) }
        });
        const { request, close } = await wire(server, { era: 'modern' });

        const answer = resultOf(await request(reentry(1, 'signed-state')));
        expect(seen).toEqual([{ state: 'signed-state', method: 'tools/call' }]);
        expect(handler).toHaveBeenCalledOnce();
        expect(answer.content).toEqual([{ type: 'text', text: 'ok' }]);

        await close();
    });

    it('a throw becomes the frozen -32602 wire error (not an isError tool result); the reason goes to onerror only', async () => {
        const { server, handler } = buildServer({
            requestState: {
                verify: () => {
                    throw new Error('HMAC mismatch — granular reason');
                }
            }
        });
        const onerror = vi.fn();
        server.server.onerror = onerror;
        const { request, close } = await wire(server, { era: 'modern' });

        const answer = await request(reentry(1, 'tampered'));
        // Real JSON-RPC error (above the tools/call funnel), not a result.
        expect((answer as { result?: unknown }).result).toBeUndefined();
        const error = errorOf(answer);
        expect(error.code).toBe(-32_602);
        expect(error.message).toBe('Invalid or expired requestState');
        expect(error.data).toEqual({ reason: 'invalid_request_state' });
        // The granular reason never reaches the wire — onerror only.
        expect(JSON.stringify(answer)).not.toContain('HMAC mismatch');
        expect(onerror).toHaveBeenCalledOnce();
        expect(String(onerror.mock.calls[0]?.[0])).toContain('HMAC mismatch');
        expect(handler).not.toHaveBeenCalled();

        await close();
    });

    it('is not called when the request carries no requestState', async () => {
        const verify = vi.fn();
        const { server, handler } = buildServer({ requestState: { verify } });
        const { request, close } = await wire(server, { era: 'modern' });

        const answer = resultOf(await request(reentry(1)));
        expect(verify).not.toHaveBeenCalled();
        expect(handler).toHaveBeenCalledOnce();
        expect(answer.content).toEqual([{ type: 'text', text: 'ok' }]);

        await close();
    });

    it('not configured → today’s behavior (raw passthrough; the handler reads the state itself)', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        let seen: string | undefined;
        server.registerTool('deploy', { inputSchema: z.object({}) }, async (_args, ctx) => {
            seen = ctx.mcpReq.requestState;
            return { content: [{ type: 'text', text: 'ok' }] };
        });
        const { request, close } = await wire(server, { era: 'modern' });

        const answer = resultOf(await request(reentry(1, 'raw-state')));
        expect(seen).toBe('raw-state');
        expect(answer.content).toEqual([{ type: 'text', text: 'ok' }]);

        await close();
    });
});

describe('push-style APIs on 2026-era requests', () => {
    it('ctx.mcpReq.elicitInput rejects before any wire traffic and the catch-all surfaces the inputRequired() steer as isError', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('legacy-style', { inputSchema: z.object({}) }, async (_args, ctx) => {
            const answer = await ctx.mcpReq.elicitInput({ message: 'Name?', requestedSchema: { type: 'object', properties: {} } });
            return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
        });
        const { request, inbound, close } = await wire(server, { era: 'modern' });

        const answer = await request(modernToolCall(1, 'legacy-style', {}, { clientCapabilities: { elicitation: { form: {} } } }));
        const result = resultOf(answer);
        expect(result.isError).toBe(true);
        const text = JSON.stringify(result.content);
        expect(text).toContain('inputRequired(');

        // Zero wire traffic for the attempted server→client request: the only
        // message the peer ever received is the tools/call response itself.
        expect(inbound.filter(message => (message as { method?: string }).method === 'elicitation/create')).toHaveLength(0);
        expect(inbound).toHaveLength(1);

        await close();
    });
});
