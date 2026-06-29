/**
 * The legacy `input_required` shim (write-once handlers on 2025-era
 * sessions):
 *
 * - an MRTR-native handler returning `input_required` on a 2025-era
 *   sessionful connection has each embedded request sent as a REAL
 *   server→client request (`elicitation/create`, `sampling/createMessage`,
 *   `roots/list`) through the existing senders, stamped with the originating
 *   request's id, and is re-entered with the collected `inputResponses`
 *   until a final result;
 * - round semantics mirror the modern client driver: `inputResponses` are
 *   REPLACED each round (never accumulated), `requestState` is echoed
 *   byte-exact and re-verified by the configured hook each round,
 *   requestState-only rounds are paced, and the round cap counts handler
 *   re-entries (default 8);
 * - the shim's OWN capability pre-check (never gated on
 *   `enforceStrictCapabilities`) reads the initialize-declared capabilities:
 *   capability-less clients — including per-request stateless legacy
 *   instances, which never see an initialize — get a clean, typed refusal
 *   before any wire traffic, never a hang;
 * - failures surface per family: tools/call → `isError` tool results;
 *   prompts/get and resources/read → JSON-RPC errors;
 * - every leg carries the explicit human-paced timeout (600s default, NOT
 *   the 60s protocol default) with resetTimeoutOnProgress;
 * - the shim emits NO progress of its own: the originating token is the
 *   handler's single must-increase stream, and the shim never adds a second
 *   author to it.
 */
import type { JSONRPCRequest, RequestId } from '@modelcontextprotocol/core-internal';
import { acceptedContent, inputRequired, inputResponse } from '@modelcontextprotocol/core-internal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import { errorOf, legacyInitialize, resultOf, toolText, wireLegacy } from './legacyShimHarness';
import { McpServer } from '../../src/server/mcp';
import { Server } from '../../src/server/server';

/** A sessionful legacy connection serving one write-once elicitation tool. */
async function elicitingToolServer(options?: ConstructorParameters<typeof McpServer>[1]) {
    const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} }, ...options });
    const seenResponses: Array<Record<string, unknown> | undefined> = [];
    server.registerTool('deploy', { inputSchema: z.object({ env: z.string() }) }, async ({ env }, ctx) => {
        seenResponses.push(ctx.mcpReq.inputResponses);
        const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
        if (!confirmed?.confirm) {
            return inputRequired({
                inputRequests: {
                    confirm: inputRequired.elicit({
                        message: `Deploy to ${env}?`,
                        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
                    })
                }
            });
        }
        return { content: [{ type: 'text', text: `deployed to ${env}` }] };
    });
    return { server, seenResponses };
}

const callDeploy = (id: number, meta?: Record<string, unknown>): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'deploy', arguments: { env: 'prod' }, ...(meta !== undefined && { _meta: meta }) }
});

afterEach(() => {
    vi.useRealTimers();
});

describe('legacy shim: write-once fulfilment on a sessionful 2025-era connection', () => {
    it('fulfils an elicitation round as a REAL elicitation/create request and re-enters the handler to a final result', async () => {
        const { server, seenResponses } = await elicitingToolServer();
        const wire = await wireLegacy(server);
        wire.respond('elicitation/create', () => ({ action: 'accept', content: { confirm: true } }));

        await wire.request(legacyInitialize(1, { elicitation: { form: {} } }));
        const answer = await wire.request(callDeploy(2));

        expect(resultOf(answer).isError).toBeUndefined();
        expect(toolText(answer)).toBe('deployed to prod');
        // The mis-typed input_required result never reached the wire.
        expect(resultOf(answer).resultType).toBeUndefined();

        // A real wire request went out, form-mode, with the handler's params.
        const legs = wire.peerRequests('elicitation/create');
        expect(legs).toHaveLength(1);
        expect(legs[0]!.params).toMatchObject({ mode: 'form', message: 'Deploy to prod?' });

        // Stream association: the leg is stamped with the ORIGINATING request id.
        const [legOptions] = wire.sentOptionsFor('elicitation/create');
        expect(legOptions?.relatedRequestId).toBe(2);

        // First entry had no responses; the re-entry carried the bare response.
        expect(seenResponses).toEqual([undefined, { confirm: { action: 'accept', content: { confirm: true } } }]);

        await wire.close();
    });

    it('fulfils sampling and roots requests in one round, concurrently, as bare response objects', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        let secondEntry: Record<string, unknown> | undefined;
        server.registerTool('plan', { inputSchema: z.object({}) }, async (_args, ctx) => {
            if (ctx.mcpReq.inputResponses === undefined) {
                return inputRequired({
                    inputRequests: {
                        ideas: inputRequired.createMessage({
                            messages: [{ role: 'user', content: { type: 'text', text: 'ideas?' } }],
                            maxTokens: 100
                        }),
                        workspace: inputRequired.listRoots()
                    }
                });
            }
            secondEntry = ctx.mcpReq.inputResponses;
            const ideas = inputResponse(ctx.mcpReq.inputResponses, 'ideas');
            const text =
                ideas.kind === 'sampling' && !Array.isArray(ideas.result.content) && ideas.result.content.type === 'text'
                    ? ideas.result.content.text
                    : undefined;
            const roots = inputResponse(ctx.mcpReq.inputResponses, 'workspace');
            return {
                content: [
                    { type: 'text', text: `ideas: ${text}` },
                    { type: 'text', text: `roots: ${roots.kind === 'roots' ? roots.roots.map(root => root.uri).join(',') : 'none'}` }
                ]
            };
        });
        const wire = await wireLegacy(server);
        wire.respond('sampling/createMessage', () => ({
            role: 'assistant',
            content: { type: 'text', text: 'idea-1' },
            model: 'test-model'
        }));
        wire.respond('roots/list', () => ({ roots: [{ uri: 'file:///workspace', name: 'ws' }] }));

        await wire.request(legacyInitialize(1, { sampling: {}, roots: {} }));
        const answer = await wire.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'plan', arguments: {} } });

        expect(toolText(answer)).toBe('ideas: idea-1\nroots: file:///workspace');
        expect(wire.peerRequests('sampling/createMessage')).toHaveLength(1);
        expect(wire.peerRequests('roots/list')).toHaveLength(1);
        // Bare response objects — exactly the shape a modern retry carries.
        expect(secondEntry).toEqual({
            ideas: { role: 'assistant', content: { type: 'text', text: 'idea-1' }, model: 'test-model' },
            workspace: { roots: [{ uri: 'file:///workspace', name: 'ws' }] }
        });

        await wire.close();
    });

    it('REPLACES inputResponses each round (driver parity — never accumulates) and echoes requestState byte-exact', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        const entries: Array<{ responses: Record<string, unknown> | undefined; state: string | undefined }> = [];
        server.registerTool('two-step', { inputSchema: z.object({}) }, async (_args, ctx) => {
            entries.push({ responses: ctx.mcpReq.inputResponses, state: ctx.mcpReq.requestState<string>() });
            if (ctx.mcpReq.requestState<string>() === undefined) {
                return inputRequired({
                    inputRequests: {
                        first: inputRequired.elicit({ message: 'one?', requestedSchema: { type: 'object', properties: {} } })
                    },
                    requestState: 'opaque-round-1'
                });
            }
            if (ctx.mcpReq.requestState<string>() === 'opaque-round-1') {
                return inputRequired({
                    inputRequests: {
                        second: inputRequired.elicit({ message: 'two?', requestedSchema: { type: 'object', properties: {} } })
                    },
                    requestState: 'opaque-round-2'
                });
            }
            return { content: [{ type: 'text', text: 'done' }] };
        });
        const wire = await wireLegacy(server);
        wire.respond('elicitation/create', request => ({
            action: 'accept',
            content: { answered: (request.params as { message: string }).message }
        }));

        await wire.request(legacyInitialize(1, { elicitation: { form: {} } }));
        const answer = await wire.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'two-step', arguments: {} } });

        expect(toolText(answer)).toBe('done');
        expect(entries).toHaveLength(3);
        expect(entries[0]).toEqual({ responses: undefined, state: undefined });
        // Round 1's response under its key; round 1's state echoed byte-exact.
        expect(entries[1]!.state).toBe('opaque-round-1');
        expect(Object.keys(entries[1]!.responses!)).toEqual(['first']);
        // Round 2 REPLACED the map: only round 2's key is present.
        expect(entries[2]!.state).toBe('opaque-round-2');
        expect(Object.keys(entries[2]!.responses!)).toEqual(['second']);

        await wire.close();
    });

    it('serves prompts/get write-once handlers through the same loop', async () => {
        const server = new Server({ name: 's', version: '1.0.0' }, { capabilities: { prompts: {} } });
        server.setRequestHandler('prompts/get', async (_request, ctx) => {
            const name = acceptedContent<{ name: string }>(ctx.mcpReq.inputResponses, 'name');
            if (name === undefined) {
                return inputRequired({
                    inputRequests: {
                        name: inputRequired.elicit({ message: 'Name?', requestedSchema: { type: 'object', properties: {} } })
                    }
                });
            }
            return { messages: [{ role: 'user', content: { type: 'text', text: `hello ${name.name}` } }] };
        });
        const wire = await wireLegacy(server);
        wire.respond('elicitation/create', () => ({ action: 'accept', content: { name: 'ada' } }));

        await wire.request(legacyInitialize(1, { elicitation: { form: {} } }));
        const answer = await wire.request({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'greeting' } });

        const messages = resultOf(answer).messages as Array<{ content: { text: string } }>;
        expect(messages[0]!.content.text).toBe('hello ada');

        await wire.close();
    });
});

describe('legacy shim: round cap (default 8, counts handler re-entries)', () => {
    function alwaysHungryServer(options?: ConstructorParameters<typeof McpServer>[1]) {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {}, prompts: {} }, ...options });
        let invocations = 0;
        server.registerTool('hungry', { inputSchema: z.object({}) }, async () => {
            invocations += 1;
            return inputRequired({
                inputRequests: { more: inputRequired.elicit({ message: 'more?', requestedSchema: { type: 'object', properties: {} } }) }
            });
        });
        return { server, invocations: () => invocations };
    }

    it('tools/call exhaustion surfaces as an isError tool result', async () => {
        const { server, invocations } = alwaysHungryServer({ inputRequired: { maxRounds: 2 } });
        const wire = await wireLegacy(server);
        wire.respond('elicitation/create', () => ({ action: 'accept', content: {} }));

        await wire.request(legacyInitialize(1, { elicitation: { form: {} } }));
        const answer = await wire.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hungry', arguments: {} } });

        expect(resultOf(answer).isError).toBe(true);
        expect(toolText(answer)).toContain('still required input after 2 rounds');
        // First invocation + 2 re-entries (the cap counts re-entries).
        expect(invocations()).toBe(3);
        expect(wire.peerRequests('elicitation/create')).toHaveLength(2);

        await wire.close();
    });

    it('prompts/get exhaustion surfaces as a JSON-RPC error', async () => {
        const server = new Server({ name: 's', version: '1.0.0' }, { capabilities: { prompts: {} }, inputRequired: { maxRounds: 1 } });
        server.setRequestHandler('prompts/get', async () =>
            inputRequired({
                inputRequests: { more: inputRequired.elicit({ message: 'more?', requestedSchema: { type: 'object', properties: {} } }) }
            })
        );
        const wire = await wireLegacy(server);
        wire.respond('elicitation/create', () => ({ action: 'accept', content: {} }));

        await wire.request(legacyInitialize(1, { elicitation: { form: {} } }));
        const answer = await wire.request({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'p' } });

        expect(errorOf(answer).code).toBe(-32_603);
        expect(errorOf(answer).message).toContain('still required input after 1 rounds');

        await wire.close();
    });
});

describe('legacy shim: capability pre-check (the shim’s own, never enforceStrictCapabilities-gated)', () => {
    it('refuses cleanly when the client declared no elicitation capability — no wire traffic, isError for tools/call', async () => {
        const { server } = await elicitingToolServer();
        const wire = await wireLegacy(server);

        await wire.request(legacyInitialize(1, {}));
        const answer = await wire.request(callDeploy(2));

        expect(resultOf(answer).isError).toBe(true);
        expect(toolText(answer)).toContain("Cannot request input 'confirm' (elicitation/create)");
        // The refusal happened BEFORE any wire traffic.
        expect(wire.peerRequests('elicitation/create')).toHaveLength(0);

        await wire.close();
    });

    it('reads a bare `elicitation: {}` declaration as form support (the pre-mode 2025 meaning — same rule as the modern -32021 gate)', async () => {
        const { server } = await elicitingToolServer();
        const wire = await wireLegacy(server);
        wire.respond('elicitation/create', () => ({ action: 'accept', content: { confirm: true } }));

        await wire.request(legacyInitialize(1, { elicitation: {} }));
        const answer = await wire.request(callDeploy(2));

        expect(toolText(answer)).toBe('deployed to prod');
        expect(wire.peerRequests('elicitation/create')).toHaveLength(1);

        await wire.close();
    });

    it('URL-mode elicitation requires elicitation.url specifically', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('signin', { inputSchema: z.object({}) }, async (_args, ctx) => {
            if (ctx.mcpReq.inputResponses === undefined) {
                return inputRequired({
                    inputRequests: { auth: inputRequired.elicitUrl({ message: 'Sign in', url: 'https://example.com/auth' }) }
                });
            }
            return { content: [{ type: 'text', text: 'ok' }] };
        });
        const wire = await wireLegacy(server);

        await wire.request(legacyInitialize(1, { elicitation: { form: {} } }));
        const answer = await wire.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'signin', arguments: {} } });

        expect(resultOf(answer).isError).toBe(true);
        expect(toolText(answer)).toContain("Cannot request input 'auth' (elicitation/create)");

        await wire.close();
    });

    it('sampling with tools requires sampling.tools; prompts/resources refusals surface as JSON-RPC errors', async () => {
        const server = new Server({ name: 's', version: '1.0.0' }, { capabilities: { resources: {} } });
        server.setRequestHandler('resources/read', async () =>
            inputRequired({
                inputRequests: {
                    pick: inputRequired.createMessage({
                        messages: [{ role: 'user', content: { type: 'text', text: 'pick' } }],
                        maxTokens: 10,
                        tools: [{ name: 'chooser', inputSchema: { type: 'object' } }]
                    })
                }
            })
        );
        const wire = await wireLegacy(server);

        await wire.request(legacyInitialize(1, { sampling: {} }));
        const answer = await wire.request({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'res://x' } });

        expect(errorOf(answer).code).toBe(-32_603);
        expect(errorOf(answer).message).toContain("Cannot request input 'pick' (sampling/createMessage)");

        await wire.close();
    });

    it('degrades to a clean refusal on an instance that never saw an initialize (the stateless legacy posture) — no hang', async () => {
        // Per-request stateless legacy serving builds a fresh instance per
        // POST: no initialize handshake ever runs, so no client capabilities
        // exist and there is no return path for server→client requests. The
        // shim's structural gate refuses before any send is attempted.
        const { server } = await elicitingToolServer();
        const wire = await wireLegacy(server);

        const answer = await wire.request(callDeploy(2));

        expect(resultOf(answer).isError).toBe(true);
        expect(toolText(answer)).toContain('per-request legacy serving cannot receive server-to-client requests');
        expect(wire.peerRequests('elicitation/create')).toHaveLength(0);

        await wire.close();
    });
});

describe('legacy shim: leg failures and validation', () => {
    it('a failed leg (peer answers an error) maps per family — tools/call → isError', async () => {
        const { server } = await elicitingToolServer();
        const wire = await wireLegacy(server);
        wire.respond('elicitation/create', () => ({ __error: { code: -32_000, message: 'user closed the window' } }));

        await wire.request(legacyInitialize(1, { elicitation: { form: {} } }));
        const answer = await wire.request(callDeploy(2));

        expect(resultOf(answer).isError).toBe(true);
        expect(toolText(answer)).toContain("Fulfilling input required by 'tools/call' failed");
        expect(toolText(answer)).toContain('user closed the window');

        await wire.close();
    });

    it('elicitation accepted content reaches the handler UNVALIDATED (modern-driver parity: the handler re-prompts, the call never dies)', async () => {
        // On the 2026 era the client driver passes accepted content through
        // without requestedSchema validation — the handler validates with the
        // schema-aware acceptedContent overload and can re-issue the request.
        // The shim must behave identically or the same handler dies on legacy
        // where it recovers on modern.
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        const seen: Array<unknown> = [];
        server.registerTool('deploy', { inputSchema: z.object({}) }, async (_args, ctx) => {
            seen.push(ctx.mcpReq.inputResponses?.['confirm']);
            const confirmed = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', z.object({ confirm: z.boolean() }));
            if (confirmed?.confirm !== true) {
                return inputRequired({
                    inputRequests: {
                        confirm: inputRequired.elicit({
                            message: 'Deploy?',
                            requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
                        })
                    }
                });
            }
            return { content: [{ type: 'text', text: 'deployed' }] };
        });
        const wire = await wireLegacy(server);
        // First answer violates the schema (string), second conforms.
        let calls = 0;
        wire.respond('elicitation/create', () =>
            ++calls === 1 ? { action: 'accept', content: { confirm: 'yes' } } : { action: 'accept', content: { confirm: true } }
        );

        await wire.request(legacyInitialize(1, { elicitation: { form: {} } }));
        const answer = await wire.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'deploy', arguments: {} } });

        // The malformed content reached the handler (bare, unvalidated), the
        // handler re-asked, and the flow completed — no isError.
        expect(resultOf(answer).isError).toBeUndefined();
        expect(toolText(answer)).toBe('deployed');
        expect(seen).toEqual([
            undefined,
            { action: 'accept', content: { confirm: 'yes' } },
            { action: 'accept', content: { confirm: true } }
        ]);

        await wire.close();
    });

    it('a hand-built embedded request without params is a server bug and fails loudly (-32603), not a leg failure', async () => {
        const server = new Server({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.setRequestHandler(
            'tools/call',
            async () =>
                ({
                    resultType: 'input_required',
                    inputRequests: { s: { method: 'sampling/createMessage' } }
                }) as never
        );
        const wire = await wireLegacy(server);

        await wire.request(legacyInitialize(1, { sampling: {} }));
        const answer = await wire.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x', arguments: {} } });

        expect(errorOf(answer).code).toBe(-32_603);
        expect(errorOf(answer).message).toContain('without params');
        expect(wire.peerRequests('sampling/createMessage')).toHaveLength(0);

        await wire.close();
    });

    it('URL-mode legs synthesize the elicitationId the 2025-11-25 wire requires (the 2026 in-band shape has none)', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('signin', { inputSchema: z.object({}) }, async (_args, ctx) => {
            const view = inputResponse(ctx.mcpReq.inputResponses, 'auth');
            if (view.kind !== 'elicit' || view.action !== 'accept') {
                return inputRequired({
                    inputRequests: { auth: inputRequired.elicitUrl({ message: 'Sign in', url: 'https://example.com/auth' }) }
                });
            }
            return { content: [{ type: 'text', text: 'authorized' }] };
        });
        const wire = await wireLegacy(server);
        wire.respond('elicitation/create', () => ({ action: 'accept' }));

        await wire.request(legacyInitialize(1, { elicitation: { url: {} } }));
        const answer = await wire.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'signin', arguments: {} } });

        expect(resultOf(answer).isError).toBeUndefined();
        expect(toolText(answer)).toBe('authorized');
        // The leg satisfied the 2025-11-25 schema: mode url + a synthesized id.
        const legs = wire.peerRequests('elicitation/create');
        expect(legs).toHaveLength(1);
        const legParams = legs[0]!.params as { mode: string; elicitationId?: unknown };
        expect(legParams.mode).toBe('url');
        expect(typeof legParams.elicitationId).toBe('string');
        expect((legParams.elicitationId as string).length).toBeGreaterThan(0);

        await wire.close();
    });

    it('a declined elicitation is NOT a failure: the bare decline response reaches the handler', async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('ask', { inputSchema: z.object({}) }, async (_args, ctx) => {
            if (ctx.mcpReq.inputResponses === undefined) {
                return inputRequired({
                    inputRequests: { q: inputRequired.elicit({ message: 'sure?', requestedSchema: { type: 'object', properties: {} } }) }
                });
            }
            const view = inputResponse(ctx.mcpReq.inputResponses, 'q');
            return { content: [{ type: 'text', text: `user said: ${view.kind === 'elicit' ? view.action : 'nothing'}` }] };
        });
        const wire = await wireLegacy(server);
        wire.respond('elicitation/create', () => ({ action: 'decline' }));

        await wire.request(legacyInitialize(1, { elicitation: { form: {} } }));
        const answer = await wire.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask', arguments: {} } });

        expect(resultOf(answer).isError).toBeUndefined();
        expect(toolText(answer)).toBe('user said: decline');

        await wire.close();
    });
});

describe('legacy shim: timeouts (per-leg 600s default, NOT the 60s protocol default)', () => {
    it('a leg outlives the 60s protocol default and completes after it', async () => {
        vi.useFakeTimers();
        const { server } = await elicitingToolServer();
        const wire = await wireLegacy(server);

        // Defer the answer: capture the leg id, answer manually after
        // advancing past the 60s protocol default.
        let legId: RequestId | undefined;
        wire.respond('elicitation/create', request => {
            legId = request.id;
            return { __defer: true };
        });

        await wire.request(legacyInitialize(1, { elicitation: { form: {} } }));
        const pending = wire.request(callDeploy(2));

        // Let the leg go out.
        await vi.advanceTimersByTimeAsync(1);
        expect(legId).toBeDefined();

        // 65 seconds: past the 60s protocol default — the leg must still be alive.
        await vi.advanceTimersByTimeAsync(65_000);

        await wire.answerFromPeer(legId!, { action: 'accept', content: { confirm: true } });

        await vi.advanceTimersByTimeAsync(1);
        const answer = await pending;
        expect(toolText(answer)).toBe('deployed to prod');

        await wire.close();
    });

    it('a client reporting progress against the leg resets the leg timeout (resetTimeoutOnProgress is live: the leg carries a progressToken)', async () => {
        vi.useFakeTimers();
        const { server } = await elicitingToolServer({ inputRequired: { roundTimeoutMs: 1000 } });
        const wire = await wireLegacy(server);

        let legId: RequestId | undefined;
        let legProgressToken: unknown;
        wire.respond('elicitation/create', request => {
            legId = request.id;
            legProgressToken = (request.params as { _meta?: { progressToken?: unknown } })._meta?.progressToken;
            return { __defer: true };
        });

        await wire.request(legacyInitialize(1, { elicitation: { form: {} } }));
        const pending = wire.request(callDeploy(2));

        await vi.advanceTimersByTimeAsync(1);
        expect(legId).toBeDefined();
        // The leg carries a token — without one, no progress could ever
        // reference it and resetTimeoutOnProgress would be inert.
        expect(legProgressToken).toBeDefined();

        // 600ms in (timeout 1000ms): client reports progress → reset.
        await vi.advanceTimersByTimeAsync(600);
        await wire.notifyFromPeer({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken: legProgressToken as string | number, progress: 1 }
        });
        // Another 600ms (1200ms total — past the original deadline, within
        // the reset one): the leg must still be alive.
        await vi.advanceTimersByTimeAsync(600);
        await wire.answerFromPeer(legId!, { action: 'accept', content: { confirm: true } });

        await vi.advanceTimersByTimeAsync(1);
        const answer = await pending;
        expect(toolText(answer)).toBe('deployed to prod');

        await wire.close();
    });

    it('a configured roundTimeoutMs bounds the leg and maps per family', async () => {
        vi.useFakeTimers();
        const { server } = await elicitingToolServer({ inputRequired: { roundTimeoutMs: 100 } });
        const wire = await wireLegacy(server);
        wire.respond('elicitation/create', () => ({ __defer: true }) as never);

        await wire.request(legacyInitialize(1, { elicitation: { form: {} } }));
        const pending = wire.request(callDeploy(2));

        await vi.advanceTimersByTimeAsync(150);
        const answer = await pending;

        expect(resultOf(answer).isError).toBe(true);
        expect(toolText(answer)).toContain("Fulfilling input required by 'tools/call' failed");

        await wire.close();
    });
});

describe('legacy shim: progress (the shim never writes to the originating token)', () => {
    it('emits NO synthetic progress, even across a multi-round flow whose originating request carried a progressToken', async () => {
        // The originating token is the handler's single must-increase stream.
        // The shim deliberately adds no second author to it: a 2025 client
        // watching a multi-round flow sees exactly what a hand-written 2025
        // push-style handler would have produced — silence unless the handler
        // itself reports progress.
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('two-rounds', { inputSchema: z.object({}) }, async (_args, ctx) => {
            const state = ctx.mcpReq.requestState<string>();
            if (state === undefined) {
                return inputRequired({
                    inputRequests: { a: inputRequired.elicit({ message: 'a?', requestedSchema: { type: 'object', properties: {} } }) },
                    requestState: 'r1'
                });
            }
            if (state === 'r1') {
                return inputRequired({
                    inputRequests: { b: inputRequired.elicit({ message: 'b?', requestedSchema: { type: 'object', properties: {} } }) },
                    requestState: 'r2'
                });
            }
            return { content: [{ type: 'text', text: 'done' }] };
        });
        const wire = await wireLegacy(server);
        wire.respond('elicitation/create', () => ({ action: 'accept', content: {} }));

        await wire.request(legacyInitialize(1, { elicitation: { form: {} } }));
        const answer = await wire.request({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'two-rounds', arguments: {}, _meta: { progressToken: 'tok-7' } }
        });

        expect(toolText(answer)).toBe('done');
        expect(wire.notifications.filter(notification => notification.method === 'notifications/progress')).toHaveLength(0);

        await wire.close();
    });

    it("the handler's own progress on the originating token passes through untouched across re-entries", async () => {
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('working', { inputSchema: z.object({}) }, async (_args, ctx) => {
            const progressToken = ctx.mcpReq._meta?.progressToken as string;
            if (ctx.mcpReq.inputResponses === undefined) {
                await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: 1 } });
                return inputRequired({
                    inputRequests: { q: inputRequired.elicit({ message: 'q?', requestedSchema: { type: 'object', properties: {} } }) }
                });
            }
            await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: 2 } });
            return { content: [{ type: 'text', text: 'done' }] };
        });
        const wire = await wireLegacy(server);
        wire.respond('elicitation/create', () => ({ action: 'accept', content: {} }));

        await wire.request(legacyInitialize(1, { elicitation: { form: {} } }));
        await wire.request({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'working', arguments: {}, _meta: { progressToken: 'tok-m' } }
        });

        const progress = wire.notifications
            .filter(notification => notification.method === 'notifications/progress')
            .map(notification => (notification.params as { progress: number }).progress);
        // Exactly the handler's values, in order, with nothing interleaved —
        // the stream stays monotonic because it has one author.
        expect(progress).toEqual([1, 2]);

        await wire.close();
    });
});

describe('legacy shim: requestState-only rounds are paced (driver parity)', () => {
    it('waits ~250ms before re-entering on a requestState-only round', async () => {
        vi.useFakeTimers();
        const server = new McpServer({ name: 's', version: '1.0.0' }, { capabilities: { tools: {} } });
        const entryTimes: number[] = [];
        server.registerTool('shed', { inputSchema: z.object({}) }, async (_args, ctx) => {
            entryTimes.push(Date.now());
            if (ctx.mcpReq.requestState<string>() === undefined) {
                return inputRequired({ requestState: 'wait' });
            }
            return { content: [{ type: 'text', text: 'ready' }] };
        });
        const wire = await wireLegacy(server);

        await wire.request(legacyInitialize(1, {}));
        const pending = wire.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'shed', arguments: {} } });

        await vi.advanceTimersByTimeAsync(1);
        expect(entryTimes).toHaveLength(1);
        // 249ms in: still pacing.
        await vi.advanceTimersByTimeAsync(248);
        expect(entryTimes).toHaveLength(1);
        // 250ms: re-entered.
        await vi.advanceTimersByTimeAsync(2);
        expect(entryTimes).toHaveLength(2);

        const answer = await pending;
        expect(toolText(answer)).toBe('ready');

        await wire.close();
    });
});

describe('legacy shim: requestState verification each round (deny-on-error, frozen -32602)', () => {
    it('runs the configured verify hook on every echoed round and hands the decoded payload to the typed accessor', async () => {
        const verified: string[] = [];
        const server = new McpServer(
            { name: 's', version: '1.0.0' },
            {
                capabilities: { tools: {} },
                requestState: {
                    verify: state => {
                        verified.push(state);
                        return JSON.parse(state) as unknown;
                    }
                }
            }
        );
        const decodedSeen: Array<unknown> = [];
        server.registerTool('phased', { inputSchema: z.object({}) }, async (_args, ctx) => {
            const state = ctx.mcpReq.requestState<{ phase: string }>();
            decodedSeen.push(state);
            if (state === undefined) {
                return inputRequired({
                    inputRequests: { q: inputRequired.elicit({ message: 'q?', requestedSchema: { type: 'object', properties: {} } }) },
                    requestState: JSON.stringify({ phase: 'second' })
                });
            }
            return { content: [{ type: 'text', text: `phase was ${state.phase}` }] };
        });
        const wire = await wireLegacy(server);
        wire.respond('elicitation/create', () => ({ action: 'accept', content: {} }));

        await wire.request(legacyInitialize(1, { elicitation: { form: {} } }));
        const answer = await wire.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'phased', arguments: {} } });

        expect(toolText(answer)).toBe('phase was second');
        expect(verified).toEqual([JSON.stringify({ phase: 'second' })]);
        expect(decodedSeen).toEqual([undefined, { phase: 'second' }]);

        await wire.close();
    });

    it('a verify-hook rejection mid-loop answers the frozen -32602 (never per-family-mapped, exactly as a modern wire retry)', async () => {
        const server = new McpServer(
            { name: 's', version: '1.0.0' },
            {
                capabilities: { tools: {} },
                requestState: {
                    verify: () => {
                        throw new Error('expired');
                    }
                }
            }
        );
        server.registerTool('phased', { inputSchema: z.object({}) }, async () => inputRequired({ requestState: 'sealed-state' }));
        const wire = await wireLegacy(server);

        await wire.request(legacyInitialize(1, {}));
        const answer = await wire.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'phased', arguments: {} } });

        expect(errorOf(answer).code).toBe(-32_602);
        expect(errorOf(answer).message).toBe('Invalid or expired requestState');
        expect(errorOf(answer).data).toMatchObject({ reason: 'invalid_request_state' });

        await wire.close();
    });
});

describe('legacy shim: construction-time knob validation', () => {
    it('rejects nonsense knob values loudly', () => {
        expect(() => new Server({ name: 's', version: '1' }, { inputRequired: { maxRounds: 0 } })).toThrow(RangeError);
        expect(() => new Server({ name: 's', version: '1' }, { inputRequired: { maxRounds: 1.5 } })).toThrow(RangeError);
        expect(() => new Server({ name: 's', version: '1' }, { inputRequired: { roundTimeoutMs: -1 } })).toThrow(RangeError);
        expect(() => new Server({ name: 's', version: '1' }, { inputRequired: { roundTimeoutMs: Number.NaN } })).toThrow(RangeError);
    });
});
