/**
 * The client-side multi-round-trip engine end to end against a scripted
 * modern (2026-07-28) server: auto-fulfilment via the already-registered
 * handlers, fresh request ids per leg, byte-exact requestState echo, bare
 * (never wrapped) inputResponses, multi-round flows, the round cap, manual
 * mode, and the synthesized handler context contract.
 */
import type { ElicitResult, JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';

import { Client } from '../../src/client/client';
import type { ClientOptions } from '../../src/client/client';

const MODERN = '2026-07-28';

const ELICIT_ENTRY = {
    method: 'elicitation/create',
    params: { mode: 'form', message: 'What is your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } }
};

interface ScriptedServer {
    clientTx: InMemoryTransport;
    written: JSONRPCMessage[];
    toolCalls: JSONRPCRequest[];
}

/**
 * Scripted modern server: negotiates 2026-07-28 via server/discover and
 * answers tools/call from the provided responder.
 */
async function scriptedModernServer(respondToToolCall: (request: JSONRPCRequest, call: number) => unknown): Promise<ScriptedServer> {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const written: JSONRPCMessage[] = [];
    const toolCalls: JSONRPCRequest[] = [];
    serverTx.onmessage = message => {
        written.push(message);
        const request = message as JSONRPCRequest;
        if (request.id === undefined) return;
        if (request.method === 'server/discover') {
            void serverTx.send({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                    resultType: 'complete',
                    supportedVersions: [MODERN],
                    capabilities: { tools: {} },
                    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'scripted-mrtr-server', version: '1.0.0' } }
                }
            });
            return;
        }
        if (request.method === 'tools/call') {
            toolCalls.push(request);
            void serverTx.send({
                jsonrpc: '2.0',
                id: request.id,
                result: respondToToolCall(request, toolCalls.length)
            } as Parameters<typeof serverTx.send>[0]);
        }
    };
    await serverTx.start();
    return { clientTx, written, toolCalls };
}

function makeClient(options?: ClientOptions): Client {
    return new Client(
        { name: 'mrtr-engine-client', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: MODERN } }, capabilities: { elicitation: { form: {} } }, ...options }
    );
}

const COMPLETE_RESULT = { resultType: 'complete', content: [{ type: 'text', text: 'deployed' }] };

describe('auto-fulfilment (default on)', () => {
    it('fulfils an elicitation via the registered handler and retries with a fresh id, bare responses, and a byte-exact requestState echo', async () => {
        const { clientTx, toolCalls } = await scriptedModernServer((request, call) => {
            if (call === 1) {
                return { resultType: 'input_required', inputRequests: { github_login: ELICIT_ENTRY }, requestState: 'opaque-✓-state' };
            }
            // The retry must carry the responses; echo checked below.
            expect(request.params).toMatchObject({ name: 'deploy' });
            return COMPLETE_RESULT;
        });

        const client = makeClient();
        const handled: unknown[] = [];
        client.setRequestHandler('elicitation/create', async request => {
            handled.push(request.params);
            return { action: 'accept', content: { name: 'octocat' } } satisfies ElicitResult;
        });
        await client.connect(clientTx);

        const result = await client.callTool({ name: 'deploy', arguments: { env: 'prod' } });
        expect(result.content).toEqual([{ type: 'text', text: 'deployed' }]);
        expect('resultType' in result).toBe(false);

        // The handler saw the embedded request params.
        expect(handled).toHaveLength(1);
        expect(handled[0]).toMatchObject({ mode: 'form', message: 'What is your name?' });

        // Two independent wire legs with fresh (different) ids.
        expect(toolCalls).toHaveLength(2);
        expect(toolCalls[0]!.id).not.toEqual(toolCalls[1]!.id);

        // The retry carries the original params, the BARE response (no
        // {method, result} wrapper), and the byte-exact requestState echo.
        const retryParams = toolCalls[1]!.params as Record<string, unknown>;
        expect(retryParams.name).toBe('deploy');
        expect(retryParams.arguments).toEqual({ env: 'prod' });
        expect(retryParams.inputResponses).toEqual({ github_login: { action: 'accept', content: { name: 'octocat' } } });
        expect(retryParams.requestState).toBe('opaque-✓-state');

        await client.close();
    });

    it('keeps the loop going across multiple rounds and omits requestState when a round carries none', async () => {
        const { clientTx, toolCalls } = await scriptedModernServer((_request, call) => {
            if (call === 1) {
                return { resultType: 'input_required', inputRequests: { first: ELICIT_ENTRY }, requestState: 'state-1' };
            }
            if (call === 2) {
                return { resultType: 'input_required', inputRequests: { second: ELICIT_ENTRY } };
            }
            return COMPLETE_RESULT;
        });

        const client = makeClient();
        client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { name: 'octocat' } }));
        await client.connect(clientTx);

        const result = await client.callTool({ name: 'deploy', arguments: {} });
        expect(result.content).toEqual([{ type: 'text', text: 'deployed' }]);
        expect(toolCalls).toHaveLength(3);

        const secondRetry = toolCalls[2]!.params as Record<string, unknown>;
        expect(Object.keys(secondRetry.inputResponses as Record<string, unknown>)).toEqual(['second']);
        // The second input_required carried no requestState — the retry MUST NOT include one.
        expect('requestState' in secondRetry).toBe(false);

        await client.close();
    });

    it('exhausting the round cap raises the typed rounds-exceeded error carrying the last result', async () => {
        const { clientTx, toolCalls } = await scriptedModernServer(() => ({
            resultType: 'input_required',
            inputRequests: { again: ELICIT_ENTRY },
            requestState: 'still-going'
        }));

        const client = makeClient({ inputRequired: { maxRounds: 2 } });
        client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { name: 'octocat' } }));
        await client.connect(clientTx);

        const outcome = client.callTool({ name: 'deploy', arguments: {} });
        await expect(outcome).rejects.toSatisfy((error: unknown) => {
            expect(error).toBeInstanceOf(SdkError);
            const typed = error as SdkError;
            expect(typed.code).toBe(SdkErrorCode.InputRequiredRoundsExceeded);
            expect(typed.data).toMatchObject({ rounds: 2, lastResult: { requestState: 'still-going' } });
            return true;
        });
        // Cap 2 ⇒ the original call plus exactly two retries reached the wire... no:
        // the cap counts ROUNDS (retries); round 3 is never started, so the wire
        // saw the original call + 2 retries.
        expect(toolCalls).toHaveLength(3);

        await client.close();
    });

    it('fails the call with a typed error when a required handler is not registered (reject, do not guess)', async () => {
        const { clientTx } = await scriptedModernServer(() => ({
            resultType: 'input_required',
            inputRequests: { sample: { method: 'sampling/createMessage', params: { messages: [], maxTokens: 5 } } }
        }));

        const client = makeClient();
        await client.connect(clientTx);

        await expect(client.callTool({ name: 'deploy', arguments: {} })).rejects.toMatchObject({
            code: SdkErrorCode.CapabilityNotSupported,
            data: { key: 'sample', method: 'sampling/createMessage' }
        });

        await client.close();
    });

    it('validates a forked, tool-bearing embedded sampling response against the 2026 in-band response schema', async () => {
        const SAMPLING_WITH_TOOLS_ENTRY = {
            method: 'sampling/createMessage',
            params: {
                messages: [{ role: 'user', content: { type: 'text', text: 'What is the weather in Berlin?' } }],
                maxTokens: 200,
                tools: [{ name: 'get_weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }]
            }
        };
        // Forked 2026 vocabulary: array content with a tool_use block and a
        // tool_result block whose structuredContent is NOT an object (the
        // 2026 anchor allows any value there; the 2025 result schemas do not).
        // This pins that the embedded response is validated against the era's
        // in-band response schema, mirroring the request-side selection.
        const TOOL_BEARING_RESPONSE = {
            model: 'test-model-1',
            role: 'assistant' as const,
            stopReason: 'toolUse',
            content: [
                { type: 'tool_use' as const, name: 'get_weather', id: 'call-1', input: { city: 'Berlin' } },
                {
                    type: 'tool_result' as const,
                    toolUseId: 'call-0',
                    content: [{ type: 'text' as const, text: '21°C' }],
                    structuredContent: 21
                }
            ]
        };
        const { clientTx, toolCalls } = await scriptedModernServer((_request, call) =>
            call === 1 ? { resultType: 'input_required', inputRequests: { weather: SAMPLING_WITH_TOOLS_ENTRY } } : COMPLETE_RESULT
        );

        const client = makeClient({ capabilities: { sampling: { tools: {} } } });
        // The non-object structuredContent is deliberately outside the 2025
        // result types (it is the 2026 fork) — hence the cast.
        client.setRequestHandler('sampling/createMessage', async () => TOOL_BEARING_RESPONSE as never);
        await client.connect(clientTx);

        const result = await client.callTool({ name: 'deploy', arguments: {} });
        expect(result.content).toEqual([{ type: 'text', text: 'deployed' }]);

        // The retry carries the bare tool-bearing response unchanged.
        expect(toolCalls).toHaveLength(2);
        const retryParams = toolCalls[1]!.params as { inputResponses?: Record<string, unknown> };
        expect(retryParams.inputResponses?.weather).toEqual(TOOL_BEARING_RESPONSE);

        await client.close();
    });

    it('counts the first wire leg against maxTotalTimeout (the budget bounds the whole flow)', async () => {
        let now = 1_000_000;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            const { clientTx, toolCalls } = await scriptedModernServer((_request, call) => {
                // The first leg alone "takes" longer than the whole-flow budget.
                now += 10_000;
                return call === 1 ? { resultType: 'input_required', inputRequests: { github_login: ELICIT_ENTRY } } : COMPLETE_RESULT;
            });

            const client = makeClient();
            client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { name: 'octocat' } }));
            await client.connect(clientTx);

            await expect(
                client.callTool({ name: 'deploy', arguments: {} }, { timeout: 60_000, maxTotalTimeout: 5_000 })
            ).rejects.toMatchObject({ code: SdkErrorCode.RequestTimeout, data: { maxTotalTimeout: 5_000 } });
            // The flow failed before any retry reached the wire.
            expect(toolCalls).toHaveLength(1);

            await client.close();
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('fails fast with a typed error when input_required carries neither inputRequests nor requestState', async () => {
        const { clientTx, toolCalls } = await scriptedModernServer(() => ({ resultType: 'input_required' }));

        const client = makeClient();
        client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { name: 'octocat' } }));
        await client.connect(clientTx);

        await expect(client.callTool({ name: 'deploy', arguments: {} })).rejects.toMatchObject({
            code: SdkErrorCode.InvalidResult,
            data: { method: 'tools/call', violation: 'input-required-missing-both' }
        });
        // Fail fast: the original params are never resent until the cap runs out.
        expect(toolCalls).toHaveLength(1);

        await client.close();
    });

    it('fails the call with a typed error for an unknown embedded request kind', async () => {
        const { clientTx } = await scriptedModernServer(() => ({
            resultType: 'input_required',
            inputRequests: { weird: { method: 'tasks/create', params: {} } }
        }));

        const client = makeClient();
        await client.connect(clientTx);

        await expect(client.callTool({ name: 'deploy', arguments: {} })).rejects.toMatchObject({
            code: SdkErrorCode.InvalidResult,
            data: { key: 'weird', method: 'tasks/create' }
        });

        await client.close();
    });

    it('gives the embedded handler the synthesized context: correlation-only id, chained signal, send/notify unavailable', async () => {
        const { clientTx } = await scriptedModernServer((_request, call) =>
            call === 1 ? { resultType: 'input_required', inputRequests: { github_login: ELICIT_ENTRY } } : COMPLETE_RESULT
        );

        const client = makeClient();
        const seenCtx: unknown[] = [];
        client.setRequestHandler('elicitation/create', async (_request, ctx) => {
            seenCtx.push(ctx);
            expect(ctx.mcpReq.id).toBe('github_login');
            expect(ctx.mcpReq.method).toBe('elicitation/create');
            expect(ctx.mcpReq.signal.aborted).toBe(false);
            expect(() => ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 1, progress: 1 } })).toThrow(
                /not available/
            );
            expect(() => ctx.mcpReq.send({ method: 'ping' })).toThrow(/not available/);
            return { action: 'accept', content: { name: 'octocat' } };
        });
        await client.connect(clientTx);

        await client.callTool({ name: 'deploy', arguments: {} });
        expect(seenCtx).toHaveLength(1);

        await client.close();
    });
});

describe('manual mode', () => {
    it('autoFulfill: false surfaces input_required as a typed error (no retries hit the wire)', async () => {
        const { clientTx, toolCalls } = await scriptedModernServer(() => ({
            resultType: 'input_required',
            inputRequests: { github_login: ELICIT_ENTRY }
        }));

        const client = makeClient({ inputRequired: { autoFulfill: false } });
        client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { name: 'octocat' } }));
        await client.connect(clientTx);

        await expect(client.callTool({ name: 'deploy', arguments: {} })).rejects.toMatchObject({
            code: SdkErrorCode.UnsupportedResultType,
            data: { resultType: 'input_required', method: 'tools/call' }
        });
        expect(toolCalls).toHaveLength(1);

        await client.close();
    });

    it('allowInputRequired: true hands the input-required value back to the caller, who can retry manually', async () => {
        const { clientTx, toolCalls } = await scriptedModernServer((_request, call) =>
            call === 1
                ? { resultType: 'input_required', inputRequests: { github_login: ELICIT_ENTRY }, requestState: 'manual-state' }
                : COMPLETE_RESULT
        );

        const client = makeClient({ inputRequired: { autoFulfill: false } });
        await client.connect(clientTx);

        const first = (await client.callTool({ name: 'deploy', arguments: {} }, { allowInputRequired: true })) as unknown as Record<
            string,
            unknown
        >;
        expect(first.resultType).toBe('input_required');
        expect(first.requestState).toBe('manual-state');

        // The caller drives the retry itself: same params + responses + echo.
        const second = await client.callTool({
            name: 'deploy',
            arguments: {},
            inputResponses: { github_login: { action: 'accept', content: { name: 'octocat' } } },
            requestState: first.requestState as string
        } as Parameters<Client['callTool']>[0]);
        expect(second.content).toEqual([{ type: 'text', text: 'deployed' }]);
        expect(toolCalls).toHaveLength(2);
        expect(toolCalls[0]!.id).not.toEqual(toolCalls[1]!.id);

        await client.close();
    });
});
