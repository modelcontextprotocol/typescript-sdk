/*
    This example implements an stdio MCP proxy that backfills sampling requests using the Claude API.
    
    Usage:
        npx -y @modelcontextprotocol/inspector \
            npx -y --silent tsx src/examples/backfill/backfillSampling.ts \
                npx -y --silent @modelcontextprotocol/server-everything
*/

import { Anthropic } from "@anthropic-ai/sdk";
import { Base64ImageSource, ContentBlock, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
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
} from "../../types.js";
import { Transport } from "../../shared/transport.js";

// TODO: move to SDK

const isCancelledNotification: (value: unknown) => value is CancelledNotification =
    ((value: any) => CancelledNotificationSchema.safeParse(value).success) as any;

const isCallToolRequest: (value: unknown) => value is CallToolRequest =
    ((value: any) => CallToolRequestSchema.safeParse(value).success) as any;

const isElicitRequest: (value: unknown) => value is ElicitRequest =
    ((value: any) => ElicitRequestSchema.safeParse(value).success) as any;
    
const isCreateMessageRequest: (value: unknown) => value is CreateMessageRequest =
    ((value: any) => CreateMessageRequestSchema.safeParse(value).success) as any;


function contentToMcp(content: ContentBlock): CreateMessageResult['content'][number] {
    switch (content.type) {
        case 'text':
            return {type: 'text', text: content.text};
        default:
            throw new Error(`Unsupported content type: ${content.type}`);
    }
}

function contentFromMcp(content: CreateMessageRequest['params']['messages'][number]['content']): ContentBlockParam {
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
        case 'audio':
        default:
            throw new Error(`Unsupported content type: ${content.type}`);
    }
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
    // let clientSupportsElicitation: boolean | undefined;

    const propagateMessage = (source: NamedTransport, target: NamedTransport) => {
        source.transport.onmessage = async (message, extra) => {
            console.error(`[proxy]: Message from ${source.name} transport: ${JSON.stringify(message)}; extra: ${JSON.stringify(extra)}`);

            if (isJSONRPCRequest(message)) {
                if (isInitializeRequest(message)) {
                    if (!(clientSupportsSampling = !!message.params.capabilities.sampling)) {
                        message.params.capabilities.sampling = {}
                        message.params._meta = {...(message.params._meta ?? {}), ...backfillMeta};
                    }
                } else if (isCreateMessageRequest(message) && !clientSupportsSampling) {
                    if (message.params.includeContext !== 'none') {
                        source.transport.send({
                            jsonrpc: "2.0",
                            id: message.id,
                            error: {
                                code: -32601, // Method not found
                                message: "includeContext != none not supported by MCP sampling backfill",
                            },
                        }, {relatedRequestId: message.id});
                        return;
                    }
                    
                    message.params.metadata;
                    message.params.modelPreferences;

                    try {
                        // message.params.
                        const msg = await api.messages.create({
                            model: pickModel(message.params.modelPreferences),
                            system: message.params.systemPrompt === undefined ? undefined : [
                                {
                                    type: "text",
                                    text: message.params.systemPrompt
                                },
                            ],
                            messages: message.params.messages.map(({role, content}) => (<MessageParam>{
                                role,
                                content: [contentFromMcp(content)]
                            })),
                            max_tokens: message.params.maxTokens,
                            temperature: message.params.temperature,
                            stop_sequences: message.params.stopSequences,
                        });

                        if (msg.content.length !== 1) {
                            throw new Error(`Expected exactly one content item in the response, got ${msg.content.length}`);
                        }

                        source.transport.send(<JSONRPCResponse>{
                            jsonrpc: "2.0",
                            id: message.id,
                            result: <CreateMessageResult>{
                                model: msg.model,
                                stopReason: msg.stop_reason,
                                role: msg.role,
                                content: contentToMcp(msg.content[0]),
                            },
                        });
                    } catch (error) {
                        source.transport.send({
                            jsonrpc: "2.0",
                            id: message.id,
                            error: {
                                code: -32601, // Method not found
                                message: `Error processing message: ${(error as Error).message}`,
                            },
                        }, {relatedRequestId: message.id});
                    }
                    return;
                // } else if (isElicitRequest(message) && !clientSupportsElicitation) {
                //     // TODO: form
                //     return;
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
                console.error(`[proxy]: Error sending message to ${target.name}:`, error);
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