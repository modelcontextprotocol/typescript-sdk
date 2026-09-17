import type { Content, FunctionDeclaration, GenerateContentParameters, GenerateContentResponse, Part } from '@google/genai';
import { GoogleGenAI } from '@google/genai';

import type { ChatMessage, GenerateRequest, GenerateResult, LLMProvider, ToolCall } from './provider';
import { isRecord, partsToText } from './provider';

function toParts(message: ChatMessage): Part[] {
    return message.content
        .filter(part => part.type !== 'text' || part.text.length > 0)
        .map(part => (part.type === 'text' ? { text: part.text } : { inlineData: { mimeType: part.mimeType, data: part.data } }));
}

/**
 * Convert the provider-neutral request into `generateContent` parameters.
 *
 * The mapping every host writes for Gemini:
 * - MCP `inputSchema` passes through as `parametersJsonSchema` (raw JSON Schema — no
 *   conversion to the OpenAPI-style `parameters` subset needed).
 * - Assistant tool calls become `functionCall` parts; tool results go back as
 *   `functionResponse` parts keyed by the *function name* (Gemini has no call ids on the
 *   wire, so cli-client's generated ids stay host-side).
 * - Conversation roles are `user` / `model`.
 */
export function toGeminiRequest(request: GenerateRequest, model: string): GenerateContentParameters {
    const contents: Content[] = [];
    for (const message of request.messages) {
        if (message.role === 'tool') {
            const responsePart: Part = {
                functionResponse: {
                    name: message.toolName,
                    response: { content: partsToText(message.content), ...(message.isError ? { isError: true } : {}) }
                }
            };
            // Results for parallel function calls must arrive together in one user turn.
            const previous = contents.at(-1);
            if (previous?.role === 'user' && previous.parts?.every(part => part.functionResponse)) {
                previous.parts.push(responsePart);
            } else {
                contents.push({ role: 'user', parts: [responsePart] });
            }
        } else if (message.role === 'assistant') {
            const parts: Part[] = toParts(message);
            for (const call of message.toolCalls ?? []) {
                parts.push({ functionCall: { name: call.name, args: call.arguments } });
            }
            if (parts.length > 0) contents.push({ role: 'model', parts });
        } else {
            const parts = toParts(message);
            if (parts.length > 0) contents.push({ role: 'user', parts });
        }
    }

    const functionDeclarations: FunctionDeclaration[] = (request.tools ?? []).map(tool => ({
        name: tool.name,
        description: tool.description ?? '',
        parametersJsonSchema: tool.inputSchema
    }));

    return {
        model,
        contents,
        config: {
            ...(request.system === undefined ? {} : { systemInstruction: request.system }),
            ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {})
        }
    };
}

/** Pull text + tool calls back out of a `generateContent` response. */
export function fromGeminiResponse(response: GenerateContentResponse, model: string): GenerateResult {
    const toolCalls: ToolCall[] = (response.functionCalls ?? []).map((call, index) => ({
        id: call.id ?? `call_${index + 1}`,
        name: call.name ?? '',
        arguments: isRecord(call.args) ? call.args : {}
    }));
    const finishReason = String(response.candidates?.[0]?.finishReason ?? '');
    const stopReason: GenerateResult['stopReason'] =
        toolCalls.length > 0 ? 'tool_use' : finishReason === 'MAX_TOKENS' ? 'max_tokens' : finishReason === 'STOP' ? 'end_turn' : 'other';
    return { text: response.text ?? '', toolCalls, stopReason, model };
}

export class GeminiProvider implements LLMProvider {
    readonly name = 'gemini';
    private readonly client: GoogleGenAI;
    private model?: string;

    constructor(model?: string) {
        if (!process.env.GEMINI_API_KEY) {
            throw new Error('GEMINI_API_KEY is not set — export it or pick a different --provider');
        }
        this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        this.model = model ?? process.env.GEMINI_MODEL;
    }

    /**
     * Model ids change faster than examples do, so nothing is hardcoded here: unless pinned
     * via `--model` / `GEMINI_MODEL`, ask the API for its model list and use the newest
     * stable Flash (mid-tier) model.
     */
    private async resolveModel(): Promise<string> {
        if (this.model) return this.model;
        const stableFlash = /^models\/gemini-(\d+(?:\.\d+)?)-flash$/;
        let newest: { id: string; version: number } | undefined;
        for await (const model of await this.client.models.list()) {
            const name = model.name;
            const match = name?.match(stableFlash);
            if (!name || !match) continue;
            const version = Number.parseFloat(match[1] ?? '0');
            if (!newest || version > newest.version) {
                newest = { id: name.replace(/^models\//, ''), version };
            }
        }
        if (!newest) {
            throw new Error('No stable gemini-<version>-flash model found on the Gemini API — pass --model or set GEMINI_MODEL');
        }
        this.model = newest.id;
        return this.model;
    }

    async generate(request: GenerateRequest): Promise<GenerateResult> {
        const model = await this.resolveModel();
        const response = await this.client.models.generateContent(toGeminiRequest(request, model));
        return fromGeminiResponse(response, model);
    }
}
