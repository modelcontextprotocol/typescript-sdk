import type { GenerateRequest, GenerateResult, LLMProvider, ToolCall } from './provider';

export interface ScriptedTurn {
    /** Optional inspection hook — the e2e driver uses it to assert on the request the host built. */
    expect?: (request: GenerateRequest) => void;
    text?: string;
    toolCalls?: ToolCall[];
}

/**
 * Replays a fixed sequence of assistant turns. No keys, no network — this is what CI runs
 * (`client.ts`) and what `--provider scripted` gives you locally. Each `generate()` call
 * consumes the next turn in order; because the MCP sampling handler goes through the same
 * provider, sampling requests consume turns too.
 */
export class ScriptedProvider implements LLMProvider {
    readonly name = 'scripted';
    private next = 0;

    constructor(private readonly turns: ScriptedTurn[] = []) {}

    /** Turns that have not been consumed yet (the e2e driver asserts this reaches 0). */
    get remaining(): number {
        return Math.max(0, this.turns.length - this.next);
    }

    generate(request: GenerateRequest): Promise<GenerateResult> {
        const turn = this.turns[this.next++];
        if (!turn) {
            return Promise.resolve({
                text: '(scripted provider has no turns left — run with --provider anthropic|openai|gemini for a real model)',
                toolCalls: [],
                stopReason: 'end_turn',
                model: 'scripted'
            });
        }
        turn.expect?.(request);
        const toolCalls = turn.toolCalls ?? [];
        return Promise.resolve({
            text: turn.text ?? '',
            toolCalls,
            stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
            model: 'scripted'
        });
    }
}
