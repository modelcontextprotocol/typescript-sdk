/**
 * The seam where MCP meets the model.
 *
 * `LLMProvider` is the only thing the rest of cli-client knows about a language model: given
 * the conversation so far and the MCP tools currently available, produce the next assistant
 * turn (text and/or tool calls). Each file in providers/ is the complete mapping for one
 * provider API — if you are building your own host, copy the one for the provider you use.
 *
 * The same interface serves both directions: the chat loop calls it to drive the
 * conversation, and the MCP sampling handler calls it to answer `sampling/createMessage`
 * requests from servers.
 */

//#region llmProvider
export interface ToolDefinition {
    /** Namespaced tool name as exposed to the model (e.g. `mcp__todos__add_task`). */
    name: string;
    description?: string;
    /** JSON Schema for the tool's arguments, passed through from the MCP `Tool.inputSchema`. */
    inputSchema: Record<string, unknown>;
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string };

export interface ToolCall {
    /** Provider-assigned id, echoed back on the matching `role: 'tool'` message. */
    id: string;
    /** Namespaced tool name (matches a `ToolDefinition.name`). */
    name: string;
    arguments: Record<string, unknown>;
}

export type ChatMessage =
    | { role: 'user'; content: ContentPart[] }
    | { role: 'assistant'; content: ContentPart[]; toolCalls?: ToolCall[] }
    | { role: 'tool'; toolCallId: string; toolName: string; content: ContentPart[]; isError?: boolean };

export interface GenerateRequest {
    system?: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
}

export interface GenerateResult {
    /** Assistant prose (may be empty when the model only calls tools). */
    text: string;
    /** Tool calls the host must execute and feed back as `role: 'tool'` messages. */
    toolCalls: ToolCall[];
    stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
    /** Provider-reported model id (also used to answer MCP sampling requests). */
    model: string;
}

export interface LLMProvider {
    readonly name: string;
    generate(request: GenerateRequest): Promise<GenerateResult>;
}
//#endregion llmProvider

export function textPart(text: string): ContentPart {
    return { type: 'text', text };
}

/** Flatten content parts to plain text, replacing non-text parts with a placeholder. */
export function partsToText(parts: ContentPart[]): string {
    return parts.map(part => (part.type === 'text' ? part.text : `[image: ${part.mimeType}]`)).join('\n');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
