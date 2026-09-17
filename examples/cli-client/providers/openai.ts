import OpenAI from 'openai';

import type { GenerateRequest, GenerateResult, LLMProvider, ToolCall } from './provider';
import { isRecord, partsToText } from './provider';

/**
 * Convert the provider-neutral request into Chat Completions parameters.
 *
 * The mapping every host writes for OpenAI-compatible APIs:
 * - MCP `inputSchema` passes straight through as the function `parameters` (JSON Schema).
 * - Assistant tool calls become `tool_calls` with JSON-encoded arguments; tool results become
 *   `role: 'tool'` messages keyed by `tool_call_id`.
 * - Chat Completions tool messages are text-only, so failures are prefixed with `[tool error]`
 *   and images are reduced to placeholders.
 */
export function toOpenAIRequest(request: GenerateRequest, model: string): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (request.system) {
        messages.push({ role: 'system', content: request.system });
    }
    for (const message of request.messages) {
        if (message.role === 'tool') {
            const text = partsToText(message.content);
            messages.push({
                role: 'tool',
                tool_call_id: message.toolCallId,
                content: message.isError ? `[tool error] ${text}` : text
            });
        } else if (message.role === 'assistant') {
            const toolCalls = (message.toolCalls ?? []).map(call => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: JSON.stringify(call.arguments) }
            }));
            const text = partsToText(message.content);
            // The API rejects assistant messages that carry neither content nor tool calls.
            if (!text && toolCalls.length === 0) continue;
            messages.push({
                role: 'assistant',
                content: text || null,
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
            });
        } else {
            messages.push({
                role: 'user',
                content: message.content.map(part =>
                    part.type === 'text'
                        ? { type: 'text' as const, text: part.text }
                        : { type: 'image_url' as const, image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
                )
            });
        }
    }
    return {
        model,
        messages,
        ...(request.maxTokens === undefined ? {} : { max_completion_tokens: request.maxTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...((request.tools ?? []).length > 0
            ? {
                  tools: (request.tools ?? []).map(tool => ({
                      type: 'function' as const,
                      function: { name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema }
                  }))
              }
            : {})
    };
}

/** Pull text + tool calls back out of a Chat Completions response. */
export function fromOpenAIResponse(response: OpenAI.Chat.Completions.ChatCompletion): GenerateResult {
    const choice = response.choices[0];
    const toolCalls: ToolCall[] = [];
    for (const call of choice?.message.tool_calls ?? []) {
        if (call.type !== 'function') continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(call.function.arguments || '{}');
        } catch {
            parsed = {};
        }
        toolCalls.push({ id: call.id, name: call.function.name, arguments: isRecord(parsed) ? parsed : {} });
    }
    const finishReason = choice?.finish_reason;
    const stopReason: GenerateResult['stopReason'] =
        finishReason === 'tool_calls'
            ? 'tool_use'
            : finishReason === 'length'
              ? 'max_tokens'
              : finishReason === 'stop'
                ? 'end_turn'
                : 'other';
    return { text: choice?.message.content ?? '', toolCalls, stopReason, model: response.model };
}

/**
 * Works against api.openai.com by default; point `OPENAI_BASE_URL` at any Chat-Completions
 * compatible endpoint (Gemini's compatibility layer, Ollama, vLLM, …) to reuse this mapping.
 */
export class OpenAIProvider implements LLMProvider {
    readonly name = 'openai';
    private readonly client: OpenAI;
    private model?: string;

    constructor(model?: string) {
        if (!process.env.OPENAI_API_KEY) {
            throw new Error('OPENAI_API_KEY is not set — export it or pick a different --provider');
        }
        this.client = new OpenAI({ baseURL: process.env.OPENAI_BASE_URL });
        this.model = model ?? process.env.OPENAI_MODEL;
    }

    /**
     * Model ids change faster than examples do, so nothing is hardcoded here: unless pinned
     * via `--model` / `OPENAI_MODEL`, ask the API for its model list and use the newest
     * mainline `gpt-<version>` model (the mid-tier one — not -pro, -mini, or -nano variants).
     */
    private async resolveModel(): Promise<string> {
        if (this.model) return this.model;
        const mainline = /^gpt-\d+(?:\.\d+)?$/;
        let newest: { id: string; created: number } | undefined;
        for await (const model of this.client.models.list()) {
            if (mainline.test(model.id) && (!newest || model.created > newest.created)) {
                newest = model;
            }
        }
        if (!newest) {
            throw new Error('No mainline gpt-<version> model found on the OpenAI API — pass --model or set OPENAI_MODEL');
        }
        this.model = newest.id;
        return this.model;
    }

    async generate(request: GenerateRequest): Promise<GenerateResult> {
        const model = await this.resolveModel();
        const response = await this.client.chat.completions.create(toOpenAIRequest(request, model));
        return fromOpenAIResponse(response);
    }
}
