/*
    This example implements an stdio MCP proxy that backfills context-agnostic sampling requests using the Claude API.
    
    Usage:
      npx -y @modelcontextprotocol/inspector \
        npx -y --silent tsx src/examples/backfill/backfillSampling.ts -- \
          npx -y --silent @modelcontextprotocol/server-everything
*/

import { Anthropic } from "@anthropic-ai/sdk";
import {
    Base64ImageSource,
    ContentBlock,
    ContentBlockParam,
    TextBlockParam,
    ImageBlockParam,
    Tool as ClaudeTool,
    ToolChoiceAuto,
    ToolChoiceAny,
    ToolChoiceTool,
    ToolChoiceNone,
} from "@anthropic-ai/sdk/resources/messages.js";
import { StdioServerTransport } from '../../server/stdio.js';
import { StdioClientTransport } from '../../client/stdio.js';
import {
  CancelledNotification,
  CancelledNotificationSchema,
  isInitializeRequest,
  isJSONRPCRequest,
  ElicitRequest,
  ElicitRequestSchema,
  CreateMessageRequest,
  CreateMessageRequestSchema,
  CreateMessageResult,
  JSONRPCResponse,
  isInitializedNotification,
  CallToolRequest,
  CallToolRequestSchema,
  isJSONRPCNotification,
  Tool,
  ToolCallContent,
  LoggingMessageNotification,
  JSONRPCNotification,
  AssistantMessageContent,
  UserMessageContent,
  ElicitResult,
  ElicitResultSchema, 
TextContent,
ListToolsResult,
ListToolsResultSchema,
ListToolsRequest,
CallToolResultSchema,
CallToolResult,
ResourceUpdatedNotification,
ToolListChangedNotificationSchema,
} from "../../types.js";
import { Transport } from "../../shared/transport.js";
import { Server } from "src/server/index.js";

const DEFAULT_MAX_TOKENS = process.env.DEFAULT_MAX_TOKENS ? parseInt(process.env.DEFAULT_MAX_TOKENS) : 1000;

// TODO: move to SDK

const isCancelledNotification: (value: unknown) => value is CancelledNotification =
    ((value: any) => CancelledNotificationSchema.safeParse(value).success) as any;

const isCallToolRequest: (value: unknown) => value is CallToolRequest =
    ((value: any) => CallToolRequestSchema.safeParse(value).success) as any;

const isElicitRequest: (value: unknown) => value is ElicitRequest =
    ((value: any) => ElicitRequestSchema.safeParse(value).success) as any;
    
const isElicitResult: (value: unknown) => value is ElicitResult =
    ((value: any) => ElicitResultSchema.safeParse(value).success) as any;
    
const isCreateMessageRequest: (value: unknown) => value is CreateMessageRequest =
    ((value: any) => CreateMessageRequestSchema.safeParse(value).success) as any;

/**
 * Converts MCP Tool definition to Claude API tool format
 */
function toolToClaudeFormat(tool: Tool): ClaudeTool {
    return {
        name: tool.name,
        description: tool.description || "",
        input_schema: tool.inputSchema,
    };
}

class CallableTool {
    constructor(private tool: Tool, private server: Server) {}

    async call(input: Record<string, unknown>): Promise<CallToolResult> {
        // Server validates input and output
        const request: CallToolRequest = {
            method: 'tools/call',
            params: {
                name: this.tool.name,
                arguments: input,
            },
        };
        return await this.server.request(request, CallToolResultSchema);
    }

    // Expose tool metadata for reference
    get name() { return this.tool.name; }
    get description() { return this.tool.description; }
    get inputSchema() { return this.tool.inputSchema; }
    get outputSchema() { return this.tool.outputSchema; }
}

export class CallableTools {
    private cache = new Map<string, CallableTool | undefined>();
    private results: Promise<ListToolsResult>[] = [];

    constructor(private server: Server) {
        server.setNotificationHandler(ToolListChangedNotificationSchema, () => {
            this.results = [];
            this.cache.clear();
        });
    }

    async find(name: string): Promise<CallableTool | undefined> {
        if (this.cache.has(name)) {
            return this.cache.get(name);
        }

        const getCursor = async () => this.results.length > 0 ? (await this.results[this.results.length - 1])?.nextCursor : undefined;
        const fetchNext = (cursor?: string) => this.server.request(<ListToolsRequest>{
            method: 'tools/list',
            params: { cursor },
        }, ListToolsResultSchema);

        for (const result of this.results) {
            const tool = (await result).tools.find(t => t.name === name);
            if (tool) {
                const callable = new CallableTool(tool, this.server);
                this.cache.set(name, callable);
                return callable;
            }
        }

        let cursor: string | undefined;
        while (this.results.length == 0 || (cursor = await getCursor()) !== undefined) {
            const result = fetchNext(cursor);
            this.results.push(result);
            const tool = (await result).tools.find(t => t.name === name);
            if (tool) {
                const callable = new CallableTool(tool, this.server);
                this.cache.set(name, callable);
                return callable;
            }
        }

        this.cache.set(name, undefined);
        return undefined;
    }
}

/**
 * Converts MCP ToolChoice to Claude API tool_choice format
 */
function toolChoiceToClaudeFormat(toolChoice: CreateMessageRequest['params']['toolChoice']): ToolChoiceAuto | ToolChoiceAny | ToolChoiceNone | ToolChoiceTool | undefined {
    switch (toolChoice?.mode) {
        case "auto":
            return { type: "auto", disable_parallel_tool_use: toolChoice.disable_parallel_tool_use };
        case "required":
            return { type: "any", disable_parallel_tool_use: toolChoice.disable_parallel_tool_use };
        case "none":
            return { type: "none" };
        case undefined:
            return undefined;
        default:
            throw new Error(`Unsupported toolChoice mode: ${toolChoice}`);
    }
}

function contentToMcp(content: ContentBlock): CreateMessageResult['content'] {
    switch (content.type) {
        case 'text':
            return { type: 'text', text: content.text };
        case 'tool_use':
            return {
                type: 'tool_use',
                id: content.id,
                name: content.name,
                input: content.input,
            } as ToolCallContent;
        default:
            throw new Error(`[contentToMcp] Unsupported content type: ${(content as any).type}`);
    }
}

function stopReasonToMcp(reason: string | null): CreateMessageResult['stopReason'] {
    switch (reason) {
        case 'max_tokens':
            return 'maxTokens';
        case 'stop_sequence':
            return 'stopSequence';
        case 'tool_use':
            return 'toolUse';
        case 'end_turn':
            return 'endTurn';
        case null:
            return undefined;
        default:
            throw new Error(`[stopReasonToMcp] Unsupported stop reason: ${reason}`);
    }
}


function contentBlockFromMcp(content: AssistantMessageContent | UserMessageContent): ContentBlockParam {
    switch (content.type) {
        case 'text':
            return {type: 'text', text: content.text};
        case 'image':
            return {
                type: 'image',
                source: {
                    data: content.data,
                    media_type: content.mimeType as Base64ImageSource['media_type'],
                    type: 'base64',
                },
            };
        case 'tool_result':
            return {
                type: 'tool_result',
                tool_use_id: content.toolUseId,
                content: content.content.map(c => {
                    if (c.type === 'text') {
                        return {type: 'text', text: c.text};
                    } else if (c.type === 'image') {
                        return {
                            type: 'image',
                            source: {
                                type: 'base64',
                                data: c.data,
                                media_type: c.mimeType as Base64ImageSource['media_type'],
                            },
                        };
                    } else {
                        throw new Error(`[contentBlockFromMcp] Unsupported content type in tool_result: ${c.type}`);
                    }
                }),
                is_error: content.isError,
            };
        case 'tool_use':
            return {
                type: 'tool_use',
                id: content.id,
                name: content.name,
                input: content.input,
            };
        case 'audio':
        default:
            throw new Error(`[contentBlockFromMcp] Unsupported content type: ${(content as any).type}`);
    }
}

function contentFromMcp(content: CreateMessageRequest['params']['messages'][number]['content']): ContentBlockParam[] {
    // Handle both single content block and arrays
    const contentArray = Array.isArray(content) ? content : [content];
    return contentArray.map(contentBlockFromMcp);
}

export type NamedTransport<T extends Transport = Transport> = {
    name: 'client' | 'server',
    transport: T,
}

export async function setupBackfill(client: NamedTransport, server: NamedTransport, api: Anthropic) {
    const backfillMeta = await (async () => {
        const models = new Set<string>();
        let defaultModel: string | undefined;
        for await (const info of api.models.list()) {
            models.add(info.id);
            if (info.id.indexOf('sonnet') >= 0 && defaultModel === undefined) {
                defaultModel = info.id;
            }
        }
        if (defaultModel === undefined) {
            if (models.size === 0) {
                throw new Error("No models available from the API");
            }
            defaultModel = models.values().next().value;
        }
        return {
            sampling_models: Array.from(models),
            sampling_default_model: defaultModel,
        };
    })();

    function pickModel(preferences: CreateMessageRequest['params']['modelPreferences'] | undefined): string {
        if (preferences?.hints) {
            for (const hint of Object.values(preferences.hints)) {
                if (hint.name !== undefined && backfillMeta.sampling_models.includes(hint.name)) {
                    return hint.name;
                }
            }
        }
        // TODO: linear model on preferences?.{intelligencePriority, speedPriority, costPriority} to pick betwen haiku, sonnet, opus.
        return backfillMeta.sampling_default_model!;
    }

    let clientSupportsSampling: boolean | undefined;

    const propagateMessage = (source: NamedTransport, target: NamedTransport) => {
        source.transport.onmessage = async (message, extra) => {
            if (isJSONRPCRequest(message)) {

                const sendInternalError = (errorMessage: string) => {
                    console.error(`[proxy -> ${source.name}]: Error: ${errorMessage}`);
                    source.transport.send({
                        jsonrpc: "2.0",
                        id: message.id,
                        error: {
                            code: -32603, // Internal error
                            message: errorMessage,
                        },
                    }, {relatedRequestId: message.id});
                };

                if (isInitializeRequest(message)) {
                    if (!(clientSupportsSampling = !!message.params.capabilities.sampling)) {
                        message.params.capabilities.sampling = {}
                        message.params._meta = {...(message.params._meta ?? {}), ...backfillMeta};
                    }
                } else if (isCreateMessageRequest(message)) {// && !clientSupportsSampling) {
                    if ((message.params.includeContext ?? 'none') !== 'none') {
                        sendInternalError("includeContext != none not supported by MCP sampling backfill");
                        return;
                    }
                    
                    try {
                        // Note that having tools + tool_choice = 'none' does not disable tools, unlike in OpenAI's API.
                        // We forcibly empty out the tools list in that case, which messes with the prompt caching.
                        const tools = message.params.toolChoice?.mode === 'none' ? undefined
                            : message.params.tools?.map(toolToClaudeFormat);
                        const tool_choice = toolChoiceToClaudeFormat(message.params.toolChoice);

                        // TODO: switch to streaming if maxTokens is too large
                        // "Streaming is required when max_tokens is greater than 21,333 tokens"
                        const msg = await api.messages.create({
                            model: pickModel(message.params.modelPreferences),
                            system: message.params.systemPrompt === undefined ? undefined : [
                                {
                                    type: "text",
                                    text: message.params.systemPrompt
                                },
                            ],
                            messages: message.params.messages.map(({role, content}) => ({
                                role,
                                content: contentFromMcp(content)
                            })),
                            max_tokens: message.params.maxTokens ?? DEFAULT_MAX_TOKENS,
                            temperature: message.params.temperature,
                            stop_sequences: message.params.stopSequences,
                            tools: tools && tools.length > 0 ? tools : undefined,
                            tool_choice: tool_choice,
                            ...(message.params.metadata ?? {}),
                        });

                        source.transport.send(<JSONRPCResponse>{
                            jsonrpc: "2.0",
                            id: message.id,
                            result: <CreateMessageResult>{
                                model: msg.model,
                                stopReason: stopReasonToMcp(msg.stop_reason),
                                role: 'assistant', // Always assistant in MCP responses
                                content: (Array.isArray(msg.content) ? msg.content : [msg.content]).map(contentToMcp),
                                _meta: {
                                    usage: msg.usage,
                                },
                            },
                        });
                    } catch (error) {
                        sendInternalError(`Error processing message: ${(error as Error).message}`);
                    }
                    return;
                }
            } else if (isJSONRPCNotification(message)) {
                if (isInitializedNotification(message) && source.name === 'server') {
                    if (!clientSupportsSampling) {
                        message.params = {...(message.params ?? {}), _meta: {...(message.params?._meta ?? {}), ...backfillMeta}};
                    }
                }
            }

            try {
                const relatedRequestId = isCancelledNotification(message)? message.params.requestId : undefined;
                await target.transport.send(message, {relatedRequestId});
            } catch (error) {
                source.transport.send(<JSONRPCNotification & LoggingMessageNotification>{
                    jsonrpc: "2.0",
                    method: "notifications/message",
                    params: {
                        type: "log_message",
                        level: "error",
                        message: `Error sending message to ${target.name}: ${(error as Error).message}`,
                    }
                });
            }
        };
    };
    propagateMessage(server, client);
    propagateMessage(client, server);

    const addErrorHandler = (transport: NamedTransport) => {
        transport.transport.onerror = async (error: Error) => {
            console.error(`[proxy]: Error from ${transport.name} transport:`, error);
        };
    };

    addErrorHandler(client);
    addErrorHandler(server);

    await server.transport.start();
    await client.transport.start();
}

async function main() {
    const args = process.argv.slice(2);
    const client: NamedTransport = {name: 'client', transport: new StdioClientTransport({command: args[0], args: args.slice(1)})};
    const server: NamedTransport = {name: 'server', transport: new StdioServerTransport()};

    const api = new Anthropic();
    await setupBackfill(client, server, api);
    console.error("[proxy]: Transports started.");
}

main().catch((error) => {
    console.error("[proxy]: Fatal error:", error);
    process.exit(1);
});
