/**
 * Acceptance: a realistic write-once tool — a brainstorming flow written as
 * a 2026-style `requestState` phase machine with NO era branch and NO
 * push-style arm — served to a 2025-era client through the legacy shim. The
 * multi-round conversation (count elicitation → custom count follow-up →
 * sampling) completes over real server→client requests, with the HMAC
 * requestState codec verifying state each round.
 */
import type { CallToolResult, ElicitRequestFormParams, InputRequiredResult, JSONRPCRequest } from '@modelcontextprotocol/core-internal';
import { acceptedContent, inputRequired, inputResponse } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { McpServer } from '../../src/server/mcp';
import { createRequestStateCodec } from '../../src/server/requestStateCodec';
import { legacyInitialize, resultOf, toolText, wireLegacy } from './legacyShimHarness';

type BrainstormState =
    | { step: 'awaiting-count' }
    | { step: 'awaiting-custom-count'; topic: string }
    | { step: 'awaiting-ideas'; topic: string; count: number };

const BRAINSTORM_COUNT_SCHEMA: ElicitRequestFormParams['requestedSchema'] = {
    type: 'object',
    properties: {
        theme: { type: 'string', title: 'Theme for the invented tasks', default: "an engineer's week in hell" },
        count: { type: 'string', title: 'How many tasks should I invent?', enum: ['5', '10', '20', '50', 'custom'] }
    },
    required: ['count']
};

const BRAINSTORM_CUSTOM_COUNT_SCHEMA: ElicitRequestFormParams['requestedSchema'] = {
    type: 'object',
    properties: {
        customCount: { type: 'integer', title: 'Custom amount', minimum: 1, maximum: 100 }
    },
    required: ['customCount']
};

function buildBrainstormSampling(topic: string, wanted: number) {
    return {
        systemPrompt: 'You invent short, funny todo items for a given theme. Reply with one task per line, no numbering, no commentary.',
        messages: [
            { role: 'user' as const, content: { type: 'text' as const, text: `Invent ${wanted} todo tasks for the theme "${topic}".` } }
        ],
        maxTokens: Math.min(200 + wanted * 40, 1500)
    };
}

function parseBrainstormCount(raw: unknown): number | undefined {
    const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : Number.NaN;
    return Number.isInteger(value) && value >= 1 && value <= 100 ? value : undefined;
}

function elicitAction(response: unknown): string {
    const view = inputResponse({ response }, 'response');
    return view.kind === 'elicit' ? view.action : 'cancel';
}

// Userland content convenience over the discriminated reader — text
// extraction is the handler's own one-liner, not SDK surface.
function sampledText(responses: Record<string, unknown> | undefined, key: string): string | undefined {
    const view = inputResponse(responses, key);
    if (view.kind !== 'sampling') return undefined;
    const blocks = Array.isArray(view.result.content) ? view.result.content : [view.result.content];
    const text = blocks.find((block): block is { type: 'text'; text: string } => block.type === 'text');
    return text?.text;
}

describe('acceptance: chat-cli brainstorm_tasks written once, served to a 2025 client', () => {
    async function buildBrainstormServer() {
        const stateCodec = createRequestStateCodec<BrainstormState>({ key: 'brainstorm-acceptance-test-key-32bytes!!' });
        const added: string[] = [];
        const server = new McpServer(
            { name: 'todos', version: '1.0.0' },
            { capabilities: { tools: {} }, requestState: { verify: stateCodec.verify } }
        );

        // The 2026-style requestState phase machine — the ONLY arm; no
        // 2025 push-style branch exists anywhere in this handler.
        server.registerTool(
            'brainstorm_tasks',
            { inputSchema: z.object({ theme: z.string().optional() }) },
            async ({ theme }, ctx): Promise<CallToolResult | InputRequiredResult> => {
                const fallbackTopic = theme ?? "an engineer's week in hell";
                const resolveTopic = (raw: unknown): string =>
                    typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : fallbackTopic;
                const countMessage = 'Let me invent some tasks for the board.';

                const finish = (ideasText: string, wanted: number, topic: string): CallToolResult => {
                    const titles = ideasText
                        .split('\n')
                        .map(line => line.replace(/^[-*\d.\s]+/, '').trim())
                        .filter(line => line.length > 0)
                        .slice(0, wanted);
                    if (titles.length === 0) {
                        return { content: [{ type: 'text', text: 'The model did not return any task ideas.' }], isError: true };
                    }
                    added.push(...titles.map(title => `${title} [${topic}]`));
                    return { content: [{ type: 'text', text: `Added ${titles.length} brainstormed task(s)` }] };
                };
                const declined = (action: string): CallToolResult => ({
                    content: [{ type: 'text', text: `Nothing added (user answered: ${action}).` }]
                });

                const state = ctx.mcpReq.requestState<BrainstormState>();
                const askForIdeas = async (count: number, topic: string): Promise<InputRequiredResult> =>
                    inputRequired({
                        inputRequests: { ideas: inputRequired.createMessage(buildBrainstormSampling(topic, count)) },
                        requestState: await stateCodec.mint({ step: 'awaiting-ideas', topic, count })
                    });

                switch (state?.step) {
                    case undefined: {
                        return inputRequired({
                            inputRequests: {
                                count: inputRequired.elicit({ message: countMessage, requestedSchema: BRAINSTORM_COUNT_SCHEMA })
                            },
                            requestState: await stateCodec.mint({ step: 'awaiting-count' })
                        });
                    }
                    case 'awaiting-count': {
                        const response = ctx.mcpReq.inputResponses?.['count'];
                        const accepted = acceptedContent<{ count?: string; theme?: string }>(ctx.mcpReq.inputResponses, 'count');
                        if (accepted === undefined) return declined(elicitAction(response));
                        const topic = resolveTopic(accepted.theme);
                        if (accepted.count === 'custom') {
                            return inputRequired({
                                inputRequests: {
                                    customCount: inputRequired.elicit({
                                        message: 'How many exactly?',
                                        requestedSchema: BRAINSTORM_CUSTOM_COUNT_SCHEMA
                                    })
                                },
                                requestState: await stateCodec.mint({ step: 'awaiting-custom-count', topic })
                            });
                        }
                        const wanted = parseBrainstormCount(accepted.count);
                        if (wanted === undefined) return declined('cancel');
                        return askForIdeas(wanted, topic);
                    }
                    case 'awaiting-custom-count': {
                        const response = ctx.mcpReq.inputResponses?.['customCount'];
                        const accepted = acceptedContent<{ customCount?: number }>(ctx.mcpReq.inputResponses, 'customCount');
                        const wanted = parseBrainstormCount(accepted?.customCount);
                        if (wanted === undefined) return declined(elicitAction(response));
                        return askForIdeas(wanted, state.topic);
                    }
                    case 'awaiting-ideas': {
                        return finish(sampledText(ctx.mcpReq.inputResponses, 'ideas') ?? '', state.count, state.topic);
                    }
                }
            }
        );
        return { server, added };
    }

    const callBrainstorm = (id: number): JSONRPCRequest => ({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'brainstorm_tasks', arguments: { theme: 'release week' } }
    });

    it('runs the full elicit→custom-count→sampling conversation over a 2025 session', async () => {
        const { server, added } = await buildBrainstormServer();
        const wire = await wireLegacy(server);

        wire.respond('elicitation/create', request => {
            const message = (request.params as { message: string }).message;
            if (message === 'How many exactly?') {
                return { action: 'accept', content: { customCount: 2 } };
            }
            return { action: 'accept', content: { count: 'custom', theme: 'release week' } };
        });
        wire.respond('sampling/createMessage', () => ({
            role: 'assistant',
            content: { type: 'text', text: 'Ship the changelog\nApologize to CI' },
            model: 'test-model'
        }));

        await wire.request(legacyInitialize(1, { elicitation: { form: {} }, sampling: {} }));
        const answer = await wire.request(callBrainstorm(2));

        expect(resultOf(answer).isError).toBeUndefined();
        expect(toolText(answer)).toBe('Added 2 brainstormed task(s)');
        expect(added).toEqual(['Ship the changelog [release week]', 'Apologize to CI [release week]']);

        // The conversation really happened over the wire: two elicitations
        // (count, then custom count), then one sampling request.
        expect(wire.peerRequests('elicitation/create')).toHaveLength(2);
        expect(wire.peerRequests('sampling/createMessage')).toHaveLength(1);

        await wire.close();
    });

    it('surfaces a decline as the tool result the handler chose', async () => {
        const { server, added } = await buildBrainstormServer();
        const wire = await wireLegacy(server);
        wire.respond('elicitation/create', () => ({ action: 'decline' }));

        await wire.request(legacyInitialize(1, { elicitation: { form: {} }, sampling: {} }));
        const answer = await wire.request(callBrainstorm(2));

        expect(toolText(answer)).toBe('Nothing added (user answered: decline).');
        expect(added).toEqual([]);

        await wire.close();
    });
});
