import OpenAI from 'openai';

import { fromOpenAIResponse, toOpenAIRequest } from './openai';
import type { GenerateRequest, GenerateResult, LLMProvider } from './provider';

export const DEFAULT_MINIMAX_MODEL = 'MiniMax-M3';

export const MINIMAX_BASE_URLS = {
    global: 'https://api.minimax.io/v1',
    china: 'https://api.minimaxi.com/v1'
} as const;

export function resolveMiniMaxModel(model?: string, environmentModel?: string): string {
    return model ?? environmentModel ?? DEFAULT_MINIMAX_MODEL;
}

export function resolveMiniMaxBaseURL(baseURL?: string): string {
    return baseURL ?? MINIMAX_BASE_URLS.global;
}

/**
 * MiniMax is exposed through an OpenAI-compatible Chat Completions endpoint, so this
 * mapping reuses the openai request/response translation and only swaps the client
 * wiring: `MINIMAX_API_KEY` for auth and `MINIMAX_BASE_URL` for the regional endpoint
 * (the global endpoint by default; use the China endpoint to route there).
 */
export class MiniMaxProvider implements LLMProvider {
    readonly name = 'minimax';
    private readonly client: OpenAI;
    private readonly model: string;

    constructor(model?: string) {
        if (!process.env.MINIMAX_API_KEY) {
            throw new Error('MINIMAX_API_KEY is not set — export it or pick a different --provider');
        }
        this.client = new OpenAI({
            apiKey: process.env.MINIMAX_API_KEY,
            baseURL: resolveMiniMaxBaseURL(process.env.MINIMAX_BASE_URL)
        });
        this.model = resolveMiniMaxModel(model, process.env.MINIMAX_MODEL);
    }

    async generate(request: GenerateRequest): Promise<GenerateResult> {
        const response = await this.client.chat.completions.create(toOpenAIRequest(request, this.model));
        return fromOpenAIResponse(response);
    }
}
