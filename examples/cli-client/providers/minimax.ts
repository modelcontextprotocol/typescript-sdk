import OpenAI from 'openai';

import { fromOpenAIResponse, toOpenAIRequest } from './openai';
import type { GenerateRequest, GenerateResult, LLMProvider } from './provider';

/** Mainline MiniMax chat model ids look like `MiniMax-M3`, `MiniMax-M2.7`, … */
const MAINLINE_MODEL = /^MiniMax-M\d+(?:\.\d+)?$/;

/**
 * Pick the newest model matching the mainline pattern from a model list, so the example
 * keeps working as MiniMax ships new versions without hardcoding any id here.
 */
export function newestMainlineModel(models: ReadonlyArray<{ id: string; created: number }>): string | undefined {
    let newest: { id: string; created: number } | undefined;
    for (const model of models) {
        if (!MAINLINE_MODEL.test(model.id)) continue;
        if (newest === undefined || model.created > newest.created) {
            newest = model;
        }
    }
    return newest?.id;
}

/**
 * MiniMax is exposed through an OpenAI-compatible Chat Completions endpoint, so this
 * mapping reuses the openai request/response translation and only swaps the client
 * wiring: `MINIMAX_API_KEY` for auth and `MINIMAX_BASE_URL` for the regional endpoint
 * (the global endpoint by default — point it at the China endpoint to route there).
 */
export class MiniMaxProvider implements LLMProvider {
    readonly name = 'minimax';
    private readonly client: OpenAI;
    private model?: string;

    constructor(model?: string) {
        if (!process.env.MINIMAX_API_KEY) {
            throw new Error('MINIMAX_API_KEY is not set — export it or pick a different --provider');
        }
        this.client = new OpenAI({
            apiKey: process.env.MINIMAX_API_KEY,
            baseURL: process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/v1'
        });
        this.model = model ?? process.env.MINIMAX_MODEL;
    }

    /**
     * Model ids change faster than examples do, so nothing is hardcoded here: unless pinned
     * via `--model` / `MINIMAX_MODEL`, ask the API for its model list and use the newest
     * mainline `MiniMax-M<version>` model.
     */
    private async resolveModel(): Promise<string> {
        if (this.model) return this.model;
        const models: Array<{ id: string; created: number }> = [];
        for await (const model of this.client.models.list()) {
            models.push(model);
        }
        const id = newestMainlineModel(models);
        if (id === undefined) {
            throw new Error('No mainline MiniMax-M<version> model found on the MiniMax API — pass --model or set MINIMAX_MODEL');
        }
        this.model = id;
        return this.model;
    }

    async generate(request: GenerateRequest): Promise<GenerateResult> {
        const model = await this.resolveModel();
        const response = await this.client.chat.completions.create(toOpenAIRequest(request, model));
        return fromOpenAIResponse(response);
    }
}
