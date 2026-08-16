import Anthropic from '@anthropic-ai/sdk';

import type { ChatMessage, ContentPart, GenerateRequest, GenerateResult, LLMProvider, ToolCall } from './provider';
import { isRecord } from './provider';

/** One provider-neutral content part → one Anthropic block (text passthrough, supported images, placeholder otherwise). */
function partToBlock(part: ContentPart): Anthropic.TextBlockParam | Anthropic.ImageBlockParam {
    if (part.type === 'text') {
        return { type: 'text', text: part.text };
    }
    if (
        part.mimeType === 'image/jpeg' ||
        part.mimeType === 'image/png' ||
        part.mimeType === 'image/gif' ||
        part.mimeType === 'image/webp'
    ) {
        return { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } };
    }
    return { type: 'text', text: `[image omitted: unsupported media type ${part.mimeType}]` };
}

function toContentBlocks(message: ChatMessage): Anthropic.ContentBlockParam[] {
    return message.content.filter(part => part.type !== 'text' || part.text.length > 0).map(part => partToBlock(part));
}

/**
 * Convert the provider-neutral request into Anthropic Messages API parameters.
 *
 * The mapping every host writes for the Anthropic Messages API:
 * - MCP tool definitions pass straight through — `inputSchema` is already JSON Schema.
 * - Assistant tool calls become `tool_use` blocks; tool results become `tool_result` blocks
 *   inside a *user* message, and results for parallel tool calls must share one user message.
 * - `isError` from MCP becomes `is_error` so the model knows the call failed.
 */
export function toAnthropicRequest(request: GenerateRequest, model: string): Anthropic.MessageCreateParamsNonStreaming {
    const messages: Anthropic.MessageParam[] = [];

    for (const message of request.messages) {
        if (message.role === 'tool') {
            const resultBlock: Anthropic.ToolResultBlockParam = {
                type: 'tool_result',
                tool_use_id: message.toolCallId,
                is_error: message.isError ?? false,
                content: message.content.map(part => partToBlock(part))
            };
            const previous = messages.at(-1);
            if (previous?.role === 'user' && Array.isArray(previous.content)) {
                previous.content.push(resultBlock);
            } else {
                messages.push({ role: 'user', content: [resultBlock] });
            }
            continue;
        }

        if (message.role === 'assistant') {
            const blocks: Anthropic.ContentBlockParam[] = toContentBlocks(message);
            for (const call of message.toolCalls ?? []) {
                blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
            }
            if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks });
            continue;
        }

        const blocks = toContentBlocks(message);
        if (blocks.length > 0) messages.push({ role: 'user', content: blocks });
    }

    return {
        model,
        max_tokens: request.maxTokens ?? 1024,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.system === undefined ? {} : { system: request.system }),
        messages,
        tools: (request.tools ?? []).map(tool => ({
            name: tool.name,
            description: tool.description ?? '',
            input_schema: { ...tool.inputSchema, type: 'object' }
        }))
    };
}

/** Pull text + tool calls back out of an Anthropic response. */
export function fromAnthropicResponse(response: Anthropic.Message): GenerateResult {
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of response.content) {
        if (block.type === 'text') {
            textParts.push(block.text);
        } else if (block.type === 'tool_use') {
            toolCalls.push({ id: block.id, name: block.name, arguments: isRecord(block.input) ? block.input : {} });
        }
    }
    const stopReason: GenerateResult['stopReason'] =
        response.stop_reason === 'tool_use'
            ? 'tool_use'
            : response.stop_reason === 'max_tokens'
              ? 'max_tokens'
              : response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence'
                ? 'end_turn'
                : 'other';
    return { text: textParts.join('\n'), toolCalls, stopReason, model: response.model };
}

export class AnthropicProvider implements LLMProvider {
    readonly name = 'anthropic';
    private readonly client: Anthropic;
    private model?: string;

    constructor(model?: string) {
        // The SDK reads either an API key or a bearer token (ANTHROPIC_AUTH_TOKEN) from the env.
        if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
            throw new Error('Neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set — export one or pick a different --provider');
        }
        this.client = new Anthropic();
        this.model = model ?? process.env.ANTHROPIC_MODEL;
    }

    /**
     * Model ids change faster than examples do, so nothing is hardcoded here: unless pinned
     * via `--model` / `ANTHROPIC_MODEL`, ask the API for its model list and use the newest
     * Sonnet-class (mid-tier) model.
     */
    private async resolveModel(): Promise<string> {
        if (this.model) return this.model;
        const models = await this.client.models.list({ limit: 100 });
        const newestSonnet = models.data
            .filter(model => model.id.includes('sonnet'))
            .toSorted((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
        if (!newestSonnet) {
            throw new Error('No Sonnet-class model found on the Anthropic API — pass --model or set ANTHROPIC_MODEL');
        }
        this.model = newestSonnet.id;
        return this.model;
    }

    async generate(request: GenerateRequest): Promise<GenerateResult> {
        const model = await this.resolveModel();
        const response = await this.client.messages.create(toAnthropicRequest(request, model));
        return fromAnthropicResponse(response);
    }
}
