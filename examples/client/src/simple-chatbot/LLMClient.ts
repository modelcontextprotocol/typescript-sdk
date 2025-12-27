interface ResponseLike {
    ok: boolean;
    status: number;
    statusText: string;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
}

type FetchLike = (input: string, init?: unknown) => Promise<ResponseLike>;
declare const fetch: FetchLike;

type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
    role: ChatRole;
    content: string;
}

interface CompletionChoice {
    message: { role: ChatRole; content: string };
}

interface CompletionResponse {
    choices: CompletionChoice[];
}

export class LLMClient {
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly model: string;
    private readonly temperature: number;
    private readonly maxTokens: number;
    private readonly topP: number;
    private readonly stream: boolean;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.groq.com/openai/v1/chat/completions';
        this.model = 'meta-llama/llama-4-scout-17b-16e-instruct';
        this.temperature = 0.7;
        this.maxTokens = 4096;
        this.topP = 1;
        this.stream = false;
    }

    async getResponse(messages: ChatMessage[]): Promise<string> {
        const payload = {
            messages,
            model: this.model,
            temperature: this.temperature,
            max_tokens: this.maxTokens,
            top_p: this.topP,
            stream: this.stream,
            stop: null,
        };

        try {
            const res = await fetch(this.baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify(payload),
            });

            if (!res.ok) {
                const body = await res.text();
                throw new Error(`LLM request failed: ${res.status} ${res.statusText} ${body}`);
            }

            const data = (await res.json()) as CompletionResponse;
            const content = data?.choices?.[0]?.message?.content;
            if (!content) {
                throw new Error('LLM response missing content');
            }
            return content;
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            console.error(`Error getting LLM response: ${message}`);
            return `I encountered an error: ${message}. Please try again or rephrase your request.`;
        }
    }
}
