#!/usr/bin/env node

/**
 * MCP Conformance Test Server
 *
 * Server implementing all MCP features for conformance testing.
 * This server is designed to pass all conformance test scenarios.
 */

import { randomUUID } from 'node:crypto';

import { localhostHostValidation } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport, toNodeHandler } from '@modelcontextprotocol/node';
import type {
    CallToolResult,
    EventId,
    EventStore,
    GetPromptResult,
    InputRequests,
    InputRequiredResult,
    ReadResourceResult,
    ServerContext,
    StreamId
} from '@modelcontextprotocol/server';
import {
    acceptedContent,
    classifyInboundRequest,
    CLIENT_CAPABILITIES_META_KEY,
    createMcpHandler,
    createRequestStateCodec,
    fromJsonSchema,
    inputRequired,
    isInitializeRequest,
    McpServer,
    ProtocolError,
    ProtocolErrorCode,
    ResourceTemplate
} from '@modelcontextprotocol/server';
import cors from 'cors';
import type { Request, Response } from 'express';
import express from 'express';
import * as z from 'zod/v4';

// Server state
const resourceSubscriptions = new Set<string>();
const watchedResourceContent = 'Watched resource content';

// Session management
const transports: { [sessionId: string]: NodeStreamableHTTPServerTransport } = {};
const servers: { [sessionId: string]: McpServer } = {};

// In-memory event store for SEP-1699 resumability
const eventStoreData = new Map<string, { eventId: string; message: unknown; streamId: string }>();

function createEventStore(): EventStore {
    return {
        async storeEvent(streamId: StreamId, message: unknown): Promise<EventId> {
            const eventId = `${streamId}::${Date.now()}_${randomUUID()}`;
            eventStoreData.set(eventId, { eventId, message, streamId });
            return eventId;
        },
        async replayEventsAfter(
            lastEventId: EventId,
            { send }: { send: (eventId: EventId, message: unknown) => Promise<void> }
        ): Promise<StreamId> {
            const streamId = lastEventId.split('::')[0] || lastEventId;
            const eventsToReplay: Array<[string, { message: unknown }]> = [];
            for (const [eventId, data] of eventStoreData.entries()) {
                if (data.streamId === streamId && eventId > lastEventId) {
                    eventsToReplay.push([eventId, data]);
                }
            }
            eventsToReplay.sort(([a], [b]) => a.localeCompare(b));
            for (const [eventId, { message }] of eventsToReplay) {
                if (message && typeof message === 'object' && Object.keys(message).length > 0) {
                    await send(eventId, message);
                }
            }
            return streamId;
        }
    };
}

// Sample base64 encoded 1x1 red PNG pixel for testing
const TEST_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

// Sample base64 encoded minimal WAV file for testing
const TEST_AUDIO_BASE64 = 'UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAAB9AAACABAAZGF0YQIAAAA=';

// ===== MULTI-ROUND-TRIP requestState INTEGRITY (SEP-2322) =====
//
// `requestState` round-trips through the client and comes back as
// attacker-controlled input. The SDK treats it as an opaque string and applies
// no protection of its own, so a server that lets it influence behavior MUST
// integrity-protect it when minting and MUST reject state that fails
// verification (see the migration guide). This fixture uses the SDK-provided
// `createRequestStateCodec` helper — `mint` HMAC-seals the payload with a
// per-process key and a TTL, and `verify` is the function dropped into
// `ServerOptions.requestState.verify` so the seam rejects tampered or expired
// state with `-32602` before the handler runs (which is what the
// `input-required-result-tampered-state` conformance scenario asserts). The
// key is process-local because the 2026-07-28 path serves every request from
// a fresh server instance — the state itself is the only thing that survives
// between rounds.
const requestStateCodec = createRequestStateCodec<Record<string, unknown>>({
    key: crypto.getRandomValues(new Uint8Array(32))
});

// Function to create a new MCP server instance (one per session)
function createMcpServer() {
    const mcpServer = new McpServer(
        {
            name: 'mcp-conformance-test-server',
            version: '1.0.0'
        },
        {
            capabilities: {
                tools: {
                    listChanged: true
                },
                resources: {
                    subscribe: true,
                    listChanged: true
                },
                prompts: {
                    listChanged: true
                },
                logging: {},
                completions: {}
            },
            // Seam-level integrity check (SEP-2322): every re-entered MRTR
            // request that carries requestState is verified before the handler
            // runs. A rejection answers a wire-level -32602 with
            // data.reason 'invalid_request_state'.
            requestState: { verify: requestStateCodec.verify }
        }
    );

    // Helper to send log messages using the underlying server
    function sendLog(
        level: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency',
        message: string,
        _data?: unknown
    ) {
        mcpServer.server
            .notification({
                method: 'notifications/message',
                params: {
                    level,
                    logger: 'conformance-test-server',
                    data: _data || message
                }
            })
            .catch(() => {
                // Ignore error if no client is connected
            });
    }

    // ===== TOOLS =====

    // SEP-2243 x-mcp-header tool — arms the http-custom-header-server-validation
    // conformance scenario (which skips when no tool with an x-mcp-header
    // annotation is found). The schema is hand-written JSON so the annotation
    // survives serialization unchanged.
    mcpServer.registerTool(
        'test_x_mcp_header',
        {
            description: 'Tests SEP-2243 Mcp-Param-* server-side validation',
            inputSchema: fromJsonSchema<{ region?: string; level?: number }>({
                type: 'object',
                properties: {
                    region: { type: 'string', description: 'mirrored into Mcp-Param-Region', 'x-mcp-header': 'Region' },
                    level: { type: 'integer', description: 'non-mirrored argument' }
                }
            })
        },
        async (args): Promise<CallToolResult> => ({
            content: [{ type: 'text', text: `region=${args.region ?? '<none>'}` }]
        })
    );

    // Simple text tool
    mcpServer.registerTool(
        'test_simple_text',
        {
            description: 'Tests simple text content response'
        },
        async (): Promise<CallToolResult> => {
            return {
                content: [{ type: 'text', text: 'This is a simple text response for testing.' }]
            };
        }
    );

    // Image content tool
    mcpServer.registerTool(
        'test_image_content',
        {
            description: 'Tests image content response'
        },
        async (): Promise<CallToolResult> => {
            return {
                content: [{ type: 'image', data: TEST_IMAGE_BASE64, mimeType: 'image/png' }]
            };
        }
    );

    // Audio content tool
    mcpServer.registerTool(
        'test_audio_content',
        {
            description: 'Tests audio content response'
        },
        async (): Promise<CallToolResult> => {
            return {
                content: [{ type: 'audio', data: TEST_AUDIO_BASE64, mimeType: 'audio/wav' }]
            };
        }
    );

    // Embedded resource tool
    mcpServer.registerTool(
        'test_embedded_resource',
        {
            description: 'Tests embedded resource content response'
        },
        async (): Promise<CallToolResult> => {
            return {
                content: [
                    {
                        type: 'resource',
                        resource: {
                            uri: 'test://embedded-resource',
                            mimeType: 'text/plain',
                            text: 'This is an embedded resource content.'
                        }
                    }
                ]
            };
        }
    );

    // Multiple content types tool
    mcpServer.registerTool(
        'test_multiple_content_types',
        {
            description: 'Tests response with multiple content types (text, image, resource)'
        },
        async (): Promise<CallToolResult> => {
            return {
                content: [
                    { type: 'text', text: 'Multiple content types test:' },
                    { type: 'image', data: TEST_IMAGE_BASE64, mimeType: 'image/png' },
                    {
                        type: 'resource',
                        resource: {
                            uri: 'test://mixed-content-resource',
                            mimeType: 'application/json',
                            text: JSON.stringify({ test: 'data', value: 123 })
                        }
                    }
                ]
            };
        }
    );

    // Tool with logging
    mcpServer.registerTool(
        'test_tool_with_logging',
        {
            description: 'Tests tool that emits log messages during execution',
            inputSchema: z.object({})
        },
        async (_args, ctx): Promise<CallToolResult> => {
            await ctx.mcpReq.notify({
                method: 'notifications/message',
                params: {
                    level: 'info',
                    data: 'Tool execution started'
                }
            });
            await new Promise(resolve => setTimeout(resolve, 50));

            await ctx.mcpReq.notify({
                method: 'notifications/message',
                params: {
                    level: 'info',
                    data: 'Tool processing data'
                }
            });
            await new Promise(resolve => setTimeout(resolve, 50));

            await ctx.mcpReq.notify({
                method: 'notifications/message',
                params: {
                    level: 'info',
                    data: 'Tool execution completed'
                }
            });
            return {
                content: [{ type: 'text', text: 'Tool with logging executed successfully' }]
            };
        }
    );

    // Tool with progress
    mcpServer.registerTool(
        'test_tool_with_progress',
        {
            description: 'Tests tool that reports progress notifications',
            inputSchema: z.object({})
        },
        async (_args, ctx): Promise<CallToolResult> => {
            const progressToken = ctx.mcpReq._meta?.progressToken ?? 0;
            console.log('Progress token:', progressToken);
            await ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: {
                    progressToken,
                    progress: 0,
                    total: 100,
                    message: `Completed step ${0} of ${100}`
                }
            });
            await new Promise(resolve => setTimeout(resolve, 50));

            await ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: {
                    progressToken,
                    progress: 50,
                    total: 100,
                    message: `Completed step ${50} of ${100}`
                }
            });
            await new Promise(resolve => setTimeout(resolve, 50));

            await ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: {
                    progressToken,
                    progress: 100,
                    total: 100,
                    message: `Completed step ${100} of ${100}`
                }
            });

            return {
                content: [{ type: 'text', text: String(progressToken) }]
            };
        }
    );

    // Error handling tool
    mcpServer.registerTool(
        'test_error_handling',
        {
            description: 'Tests error response handling'
        },
        async (): Promise<CallToolResult> => {
            throw new Error('This tool intentionally returns an error for testing');
        }
    );

    // SEP-1699: Reconnection test tool - closes SSE stream mid-call to test client reconnection
    mcpServer.registerTool(
        'test_reconnection',
        {
            description:
                'Tests SSE stream disconnection and client reconnection (SEP-1699). Server will close the stream mid-call and send the result after client reconnects.',
            inputSchema: z.object({})
        },
        async (_args, ctx): Promise<CallToolResult> => {
            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

            console.log(`[${ctx.sessionId}] Starting test_reconnection tool...`);

            // Get the transport for this session
            const transport = ctx.sessionId ? transports[ctx.sessionId] : undefined;
            if (transport && ctx.mcpReq.id) {
                // Close the SSE stream to trigger client reconnection
                console.log(`[${ctx.sessionId}] Closing SSE stream to trigger client polling...`);
                transport.closeSSEStream(ctx.mcpReq.id);
            }

            // Wait for client to reconnect (should respect retry field)
            await sleep(100);

            console.log(`[${ctx.sessionId}] test_reconnection tool complete`);

            return {
                content: [
                    {
                        type: 'text',
                        text: 'Reconnection test completed successfully. If you received this, the client properly reconnected after stream closure.'
                    }
                ]
            };
        }
    );

    // Sampling tool - requests LLM completion from client
    mcpServer.registerTool(
        'test_sampling',
        {
            description: 'Tests server-initiated sampling (LLM completion request)',
            inputSchema: z.object({
                prompt: z.string().describe('The prompt to send to the LLM')
            })
        },
        async (args: { prompt: string }, ctx): Promise<CallToolResult> => {
            try {
                // Request sampling from client
                const result = (await ctx.mcpReq.send({
                    method: 'sampling/createMessage',
                    params: {
                        messages: [
                            {
                                role: 'user',
                                content: {
                                    type: 'text',
                                    text: args.prompt
                                }
                            }
                        ],
                        maxTokens: 100
                    }
                })) as { content?: { text?: string }; message?: { content?: { text?: string } } };

                const modelResponse = result.content?.text || result.message?.content?.text || 'No response';

                return {
                    content: [
                        {
                            type: 'text',
                            text: `LLM response: ${modelResponse}`
                        }
                    ]
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Sampling not supported or error: ${error instanceof Error ? error.message : String(error)}`
                        }
                    ]
                };
            }
        }
    );

    // Elicitation tool - requests user input from client
    mcpServer.registerTool(
        'test_elicitation',
        {
            description: 'Tests server-initiated elicitation (user input request)',
            inputSchema: z.object({
                message: z.string().describe('The message to show the user')
            })
        },
        async (args: { message: string }, ctx): Promise<CallToolResult> => {
            try {
                // Request user input from client
                const result = await ctx.mcpReq.send({
                    method: 'elicitation/create',
                    params: {
                        message: args.message,
                        requestedSchema: {
                            type: 'object',
                            properties: {
                                response: {
                                    type: 'string',
                                    description: "User's response"
                                }
                            },
                            required: ['response']
                        }
                    }
                });

                const elicitResult = result as { action?: string; content?: unknown };
                return {
                    content: [
                        {
                            type: 'text',
                            text: `User response: action=${elicitResult.action}, content=${JSON.stringify(elicitResult.content || {})}`
                        }
                    ]
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Elicitation not supported or error: ${error instanceof Error ? error.message : String(error)}`
                        }
                    ]
                };
            }
        }
    );

    // SEP-1034: Elicitation with default values for all primitive types
    mcpServer.registerTool(
        'test_elicitation_sep1034_defaults',
        {
            description: 'Tests elicitation with default values per SEP-1034',
            inputSchema: z.object({})
        },
        async (_args, ctx): Promise<CallToolResult> => {
            try {
                // Request user input with default values for all primitive types
                const result = await ctx.mcpReq.send({
                    method: 'elicitation/create',
                    params: {
                        message: 'Please review and update the form fields with defaults',
                        requestedSchema: {
                            type: 'object',
                            properties: {
                                name: {
                                    type: 'string',
                                    description: 'User name',
                                    default: 'John Doe'
                                },
                                age: {
                                    type: 'integer',
                                    description: 'User age',
                                    default: 30
                                },
                                score: {
                                    type: 'number',
                                    description: 'User score',
                                    default: 95.5
                                },
                                status: {
                                    type: 'string',
                                    description: 'User status',
                                    enum: ['active', 'inactive', 'pending'],
                                    default: 'active'
                                },
                                verified: {
                                    type: 'boolean',
                                    description: 'Verification status',
                                    default: true
                                }
                            },
                            required: []
                        }
                    }
                });

                const elicitResult = result as { action?: string; content?: unknown };
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Elicitation completed: action=${elicitResult.action}, content=${JSON.stringify(elicitResult.content || {})}`
                        }
                    ]
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Elicitation not supported or error: ${error instanceof Error ? error.message : String(error)}`
                        }
                    ]
                };
            }
        }
    );

    // SEP-1330: Elicitation with enum schema improvements
    mcpServer.registerTool(
        'test_elicitation_sep1330_enums',
        {
            description: 'Tests elicitation with enum schema improvements per SEP-1330',
            inputSchema: z.object({})
        },
        async (_args, ctx): Promise<CallToolResult> => {
            try {
                // Request user input with all 5 enum schema variants
                const result = await ctx.mcpReq.send({
                    method: 'elicitation/create',
                    params: {
                        message: 'Please select options from the enum fields',
                        requestedSchema: {
                            type: 'object',
                            properties: {
                                // Untitled single-select enum (basic)
                                untitledSingle: {
                                    type: 'string',
                                    description: 'Select one option',
                                    enum: ['option1', 'option2', 'option3']
                                },
                                // Titled single-select enum (using oneOf with const/title)
                                titledSingle: {
                                    type: 'string',
                                    description: 'Select one option with titles',
                                    oneOf: [
                                        { const: 'value1', title: 'First Option' },
                                        { const: 'value2', title: 'Second Option' },
                                        { const: 'value3', title: 'Third Option' }
                                    ]
                                },
                                // Legacy titled enum (using enumNames - deprecated)
                                legacyEnum: {
                                    type: 'string',
                                    description: 'Select one option (legacy)',
                                    enum: ['opt1', 'opt2', 'opt3'],
                                    enumNames: ['Option One', 'Option Two', 'Option Three']
                                },
                                // Untitled multi-select enum
                                untitledMulti: {
                                    type: 'array',
                                    description: 'Select multiple options',
                                    minItems: 1,
                                    maxItems: 3,
                                    items: {
                                        type: 'string',
                                        enum: ['option1', 'option2', 'option3']
                                    }
                                },
                                // Titled multi-select enum (using anyOf with const/title)
                                titledMulti: {
                                    type: 'array',
                                    description: 'Select multiple options with titles',
                                    minItems: 1,
                                    maxItems: 3,
                                    items: {
                                        anyOf: [
                                            { const: 'value1', title: 'First Choice' },
                                            { const: 'value2', title: 'Second Choice' },
                                            { const: 'value3', title: 'Third Choice' }
                                        ]
                                    }
                                }
                            },
                            required: []
                        }
                    }
                });

                const elicitResult = result as { action?: string; content?: unknown };
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Elicitation completed: action=${elicitResult.action}, content=${JSON.stringify(elicitResult.content || {})}`
                        }
                    ]
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Elicitation not supported or error: ${error instanceof Error ? error.message : String(error)}`
                        }
                    ]
                };
            }
        }
    );

    // SEP-1613: JSON Schema 2020-12 conformance test tool
    mcpServer.registerTool(
        'json_schema_2020_12_tool',
        {
            description: 'Tool with JSON Schema 2020-12 features for conformance testing (SEP-1613)',
            inputSchema: z.object({
                name: z.string().optional(),
                address: z
                    .object({
                        street: z.string().optional(),
                        city: z.string().optional()
                    })
                    .optional()
            })
        },
        async (args: { name?: string; address?: { street?: string; city?: string } }): Promise<CallToolResult> => {
            return {
                content: [
                    {
                        type: 'text',
                        text: `JSON Schema 2020-12 tool called with: ${JSON.stringify(args)}`
                    }
                ]
            };
        }
    );

    // ===== MULTI-ROUND-TRIP TOOLS (SEP-2322, protocol revision 2026-07-28) =====
    //
    // Diagnostic tools for the input-required conformance scenarios. Each tool
    // is written write-once style: it returns `inputRequired(...)` until the
    // retried request carries the responses it needs (read from
    // `ctx.mcpReq.inputResponses` / `ctx.mcpReq.requestState`), then completes.
    // These tools are only meaningful toward 2026-07-28 requests; calling them
    // on a 2025-era session fails loudly at the server seam by design.

    // Basic elicitation round trip. Also exercised by the result-type,
    // missing-input-response, ignore-extra-params and validate-input
    // scenarios: anything that does not contain an accepted "user_name"
    // response is answered with a fresh InputRequiredResult re-requesting it.
    mcpServer.registerTool(
        'test_input_required_result_elicitation',
        {
            description: 'MRTR (SEP-2322): asks for the caller name via an in-band elicitation request',
            inputSchema: z.object({})
        },
        async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const name = acceptedContent<{ name: string }>(ctx.mcpReq.inputResponses, 'user_name')?.name;
            if (typeof name !== 'string') {
                return inputRequired({
                    inputRequests: {
                        user_name: inputRequired.elicit({
                            message: 'What is your name?',
                            requestedSchema: {
                                type: 'object',
                                properties: { name: { type: 'string' } },
                                required: ['name']
                            }
                        })
                    }
                });
            }
            return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
        }
    );

    // Basic sampling round trip.
    mcpServer.registerTool(
        'test_input_required_result_sampling',
        {
            description: 'MRTR (SEP-2322): asks for an LLM completion via an in-band sampling request',
            inputSchema: z.object({})
        },
        async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const samplingResponse = ctx.mcpReq.inputResponses?.['capital_question'] as
                | { content?: { type?: string; text?: string } }
                | undefined;
            if (samplingResponse === undefined) {
                return inputRequired({
                    inputRequests: {
                        capital_question: inputRequired.createMessage({
                            messages: [{ role: 'user', content: { type: 'text', text: 'What is the capital of France?' } }],
                            maxTokens: 100
                        })
                    }
                });
            }
            const text =
                typeof samplingResponse.content?.text === 'string' ? samplingResponse.content.text : JSON.stringify(samplingResponse);
            return { content: [{ type: 'text', text: `Sampling response: ${text}` }] };
        }
    );

    // Basic roots/list round trip.
    mcpServer.registerTool(
        'test_input_required_result_list_roots',
        {
            description: 'MRTR (SEP-2322): asks for the client roots via an in-band roots/list request',
            inputSchema: z.object({})
        },
        async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const rootsResponse = ctx.mcpReq.inputResponses?.['client_roots'] as
                | { roots?: Array<{ uri?: string; name?: string }> }
                | undefined;
            if (!Array.isArray(rootsResponse?.roots)) {
                return inputRequired({ inputRequests: { client_roots: inputRequired.listRoots() } });
            }
            const uris = rootsResponse.roots.map(root => root.uri).join(', ');
            return { content: [{ type: 'text', text: `Client exposed ${rootsResponse.roots.length} root(s): ${uris}` }] };
        }
    );

    // requestState round trip: the state is integrity-protected when minted
    // and verified on the retry (see the helpers above).
    mcpServer.registerTool(
        'test_input_required_result_request_state',
        {
            description: 'MRTR (SEP-2322): round-trips integrity-protected requestState alongside an elicitation request',
            inputSchema: z.object({})
        },
        async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const confirmation = acceptedContent<{ ok: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
            if (confirmation === undefined) {
                return inputRequired({
                    inputRequests: {
                        confirm: inputRequired.elicit({
                            message: 'Please confirm',
                            requestedSchema: {
                                type: 'object',
                                properties: { ok: { type: 'boolean' } },
                                required: ['ok']
                            }
                        })
                    },
                    requestState: await requestStateCodec.mint({ tool: 'request_state', nonce: randomUUID() })
                });
            }
            // The seam-level verify hook has already proven integrity by the
            // time the handler runs; calling `verify` again here just yields
            // the payload (and would re-reject if it somehow had not).
            const state = ctx.mcpReq.requestState === undefined ? undefined : await requestStateCodec.verify(ctx.mcpReq.requestState, ctx);
            if (state === undefined) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid requestState: missing or failed integrity verification');
            }
            return { content: [{ type: 'text', text: 'state-ok: requestState verified and confirmation received' }] };
        }
    );

    // Multiple input requests of different kinds in one InputRequiredResult.
    mcpServer.registerTool(
        'test_input_required_result_multiple_inputs',
        {
            description: 'MRTR (SEP-2322): asks for elicitation, sampling and roots input in a single round',
            inputSchema: z.object({})
        },
        async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const responses = ctx.mcpReq.inputResponses;
            const name = acceptedContent<{ name: string }>(responses, 'user_name')?.name;
            const greeting = (responses?.['greeting'] as { content?: { text?: string } } | undefined)?.content?.text;
            const roots = (responses?.['client_roots'] as { roots?: unknown[] } | undefined)?.roots;
            if (typeof name !== 'string' || typeof greeting !== 'string' || !Array.isArray(roots)) {
                return inputRequired({
                    inputRequests: {
                        user_name: inputRequired.elicit({
                            message: 'What is your name?',
                            requestedSchema: {
                                type: 'object',
                                properties: { name: { type: 'string' } },
                                required: ['name']
                            }
                        }),
                        greeting: inputRequired.createMessage({
                            messages: [{ role: 'user', content: { type: 'text', text: 'Generate a greeting' } }],
                            maxTokens: 50
                        }),
                        client_roots: inputRequired.listRoots()
                    },
                    requestState: await requestStateCodec.mint({ tool: 'multiple_inputs', nonce: randomUUID() })
                });
            }
            return { content: [{ type: 'text', text: `${greeting} ${name} — ${roots.length} root(s) visible` }] };
        }
    );

    // Multi-round flow: the round number lives in the integrity-protected
    // requestState (the 2026-07-28 path keeps no per-session state), and the
    // state changes between rounds.
    mcpServer.registerTool(
        'test_input_required_result_multi_round',
        {
            description: 'MRTR (SEP-2322): two elicitation rounds with evolving requestState before completing',
            inputSchema: z.object({})
        },
        async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const state = ctx.mcpReq.requestState === undefined ? undefined : await requestStateCodec.verify(ctx.mcpReq.requestState, ctx);
            const round = state?.tool === 'multi_round' && typeof state.round === 'number' ? state.round : 0;
            if (round === 0) {
                return inputRequired({
                    inputRequests: {
                        step1: inputRequired.elicit({
                            message: 'Step 1: What is your name?',
                            requestedSchema: {
                                type: 'object',
                                properties: { name: { type: 'string' } },
                                required: ['name']
                            }
                        })
                    },
                    requestState: await requestStateCodec.mint({ tool: 'multi_round', round: 1, nonce: randomUUID() })
                });
            }
            if (round === 1) {
                const name = acceptedContent<{ name: string }>(ctx.mcpReq.inputResponses, 'step1')?.name ?? 'unknown';
                return inputRequired({
                    inputRequests: {
                        step2: inputRequired.elicit({
                            message: 'Step 2: What is your favorite color?',
                            requestedSchema: {
                                type: 'object',
                                properties: { color: { type: 'string' } },
                                required: ['color']
                            }
                        })
                    },
                    requestState: await requestStateCodec.mint({ tool: 'multi_round', round: 2, name, nonce: randomUUID() })
                });
            }
            const color = acceptedContent<{ color: string }>(ctx.mcpReq.inputResponses, 'step2')?.color ?? 'unknown';
            return { content: [{ type: 'text', text: `Multi-round complete: ${String(state?.name ?? 'unknown')} likes ${color}` }] };
        }
    );

    // Tampered-state rejection: the seam-level `requestState.verify` hook
    // (the codec's `verify`, configured on the McpServer above) rejects a
    // retry whose requestState fails HMAC before this handler runs, answering
    // the wire-level -32602 the conformance scenario requires. The handler
    // only sees verified state.
    mcpServer.registerTool(
        'test_input_required_result_tampered_state',
        {
            description: 'MRTR (SEP-2322): rejects retries whose requestState fails integrity verification',
            inputSchema: z.object({})
        },
        async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
            if (ctx.mcpReq.requestState !== undefined && acceptedContent(ctx.mcpReq.inputResponses, 'confirm') !== undefined) {
                return { content: [{ type: 'text', text: 'integrity-ok: requestState verified' }] };
            }
            return inputRequired({
                inputRequests: {
                    confirm: inputRequired.elicit({
                        message: 'Please confirm',
                        requestedSchema: {
                            type: 'object',
                            properties: { ok: { type: 'boolean' } },
                            required: ['ok']
                        }
                    })
                },
                requestState: await requestStateCodec.mint({ tool: 'tampered_state', nonce: randomUUID() })
            });
        }
    );

    // Capability-aware input requests: only ask for kinds the request's
    // declared client capabilities cover (the server seam enforces the same
    // rule with a -32021 error; the tool simply never trips it).
    mcpServer.registerTool(
        'test_input_required_result_capabilities',
        {
            description: 'MRTR (SEP-2322): only requests input kinds the declared client capabilities cover',
            inputSchema: z.object({})
        },
        async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
            if (ctx.mcpReq.inputResponses !== undefined) {
                return { content: [{ type: 'text', text: 'Capability-aware input requests fulfilled' }] };
            }
            const declared = ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY];
            const inputRequests: InputRequests = {};
            if (declared?.elicitation !== undefined) {
                inputRequests.user_name = inputRequired.elicit({
                    message: 'What is your name?',
                    requestedSchema: {
                        type: 'object',
                        properties: { name: { type: 'string' } },
                        required: ['name']
                    }
                });
            }
            if (declared?.sampling !== undefined) {
                inputRequests.greeting = inputRequired.createMessage({
                    messages: [{ role: 'user', content: { type: 'text', text: 'Generate a short greeting' } }],
                    maxTokens: 50
                });
            }
            if (declared?.roots !== undefined) {
                inputRequests.client_roots = inputRequired.listRoots();
            }
            if (Object.keys(inputRequests).length === 0) {
                return { content: [{ type: 'text', text: 'No declared client capability supports an in-band input request' }] };
            }
            return inputRequired({ inputRequests });
        }
    );

    // ===== SUBSCRIPTION/LISTEN DIAGNOSTIC TRIGGERS (SEP-2575) =====
    //
    // The `server-stateless` conformance scenario opens a `subscriptions/listen`
    // stream (served by `createMcpHandler`'s built-in listen router), then calls
    // one of these triggers and asserts the corresponding `*/list_changed`
    // notification arrives on the open stream. The trigger publishes the change
    // event onto the handler's bus via the `handler.notify.*` sugar — the
    // listen router stamps the subscription id and applies the per-stream
    // filter, so the same trigger also exercises the ack-first and
    // honors-notification-filter checks. The 2026-07-28 path is per-request
    // (each call gets a fresh `McpServer`), so there is no list to mutate; the
    // event itself is what the SHOULD requirement measures.

    mcpServer.registerTool(
        'test_trigger_tool_change',
        {
            description: 'Listen diagnostic (SEP-2575): publishes a tools/list_changed event onto the handler bus',
            inputSchema: z.object({})
        },
        async (): Promise<CallToolResult> => {
            modernHandler.notify.toolsChanged();
            return { content: [{ type: 'text', text: 'tools_list_changed published' }] };
        }
    );

    mcpServer.registerTool(
        'test_trigger_prompt_change',
        {
            description: 'Listen diagnostic (SEP-2575): publishes a prompts/list_changed event onto the handler bus',
            inputSchema: z.object({})
        },
        async (): Promise<CallToolResult> => {
            modernHandler.notify.promptsChanged();
            return { content: [{ type: 'text', text: 'prompts_list_changed published' }] };
        }
    );

    // ===== RESOURCES =====

    // Static text resource
    mcpServer.registerResource(
        'static-text',
        'test://static-text',
        {
            title: 'Static Text Resource',
            description: 'A static text resource for testing',
            mimeType: 'text/plain'
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'test://static-text',
                        mimeType: 'text/plain',
                        text: 'This is the content of the static text resource.'
                    }
                ]
            };
        }
    );

    // Static binary resource
    mcpServer.registerResource(
        'static-binary',
        'test://static-binary',
        {
            title: 'Static Binary Resource',
            description: 'A static binary resource (image) for testing',
            mimeType: 'image/png'
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'test://static-binary',
                        mimeType: 'image/png',
                        blob: TEST_IMAGE_BASE64
                    }
                ]
            };
        }
    );

    // Resource template
    mcpServer.registerResource(
        'template',
        new ResourceTemplate('test://template/{id}/data', { list: undefined }),
        {
            title: 'Resource Template',
            description: 'A resource template with parameter substitution',
            mimeType: 'application/json'
        },
        async (uri, variables): Promise<ReadResourceResult> => {
            const id = variables.id;
            return {
                contents: [
                    {
                        uri: uri.toString(),
                        mimeType: 'application/json',
                        text: JSON.stringify({
                            id,
                            templateTest: true,
                            data: `Data for ID: ${id}`
                        })
                    }
                ]
            };
        }
    );

    // Watched resource
    mcpServer.registerResource(
        'watched-resource',
        'test://watched-resource',
        {
            title: 'Watched Resource',
            description: 'A resource that auto-updates every 3 seconds',
            mimeType: 'text/plain'
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'test://watched-resource',
                        mimeType: 'text/plain',
                        text: watchedResourceContent
                    }
                ]
            };
        }
    );

    // Subscribe/Unsubscribe handlers
    mcpServer.server.setRequestHandler('resources/subscribe', async request => {
        const uri = request.params.uri;
        resourceSubscriptions.add(uri);
        sendLog('info', `Subscribed to resource: ${uri}`);
        return {};
    });

    mcpServer.server.setRequestHandler('resources/unsubscribe', async request => {
        const uri = request.params.uri;
        resourceSubscriptions.delete(uri);
        sendLog('info', `Unsubscribed from resource: ${uri}`);
        return {};
    });

    // ===== PROMPTS =====

    // Simple prompt
    mcpServer.registerPrompt(
        'test_simple_prompt',
        {
            title: 'Simple Test Prompt',
            description: 'A simple prompt without arguments'
        },
        async (): Promise<GetPromptResult> => {
            return {
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: 'This is a simple prompt for testing.'
                        }
                    }
                ]
            };
        }
    );

    // Prompt with arguments
    mcpServer.registerPrompt(
        'test_prompt_with_arguments',
        {
            title: 'Prompt With Arguments',
            description: 'A prompt with required arguments',
            argsSchema: z.object({
                arg1: z.string().describe('First test argument'),
                arg2: z.string().describe('Second test argument')
            })
        },
        async (args: { arg1: string; arg2: string }): Promise<GetPromptResult> => {
            return {
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `Prompt with arguments: arg1='${args.arg1}', arg2='${args.arg2}'`
                        }
                    }
                ]
            };
        }
    );

    // Prompt with embedded resource
    mcpServer.registerPrompt(
        'test_prompt_with_embedded_resource',
        {
            title: 'Prompt With Embedded Resource',
            description: 'A prompt that includes an embedded resource',
            argsSchema: z.object({
                resourceUri: z.string().describe('URI of the resource to embed')
            })
        },
        async (args: { resourceUri: string }): Promise<GetPromptResult> => {
            return {
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'resource',
                            resource: {
                                uri: args.resourceUri,
                                mimeType: 'text/plain',
                                text: 'Embedded resource content for testing.'
                            }
                        }
                    },
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: 'Please process the embedded resource above.'
                        }
                    }
                ]
            };
        }
    );

    // Multi-round-trip prompt (SEP-2322): prompts/get is one of the methods
    // whose 2026-07-28 result vocabulary includes input_required, so a prompt
    // can request elicitation input in-band before rendering.
    mcpServer.registerPrompt(
        'test_input_required_result_prompt',
        {
            title: 'MRTR Prompt',
            description: 'MRTR (SEP-2322): prompt that requires elicitation input before rendering'
        },
        async (ctx): Promise<GetPromptResult | InputRequiredResult> => {
            // A prompt registered without argsSchema receives the request
            // context as its only callback argument, but the registerPrompt
            // overloads only model the (args, ctx) form — so the parameter
            // arrives untyped and is narrowed here.
            const promptCtx = ctx as ServerContext;
            const promptContext = acceptedContent<{ context: string }>(promptCtx.mcpReq.inputResponses, 'user_context')?.context;
            if (typeof promptContext !== 'string') {
                return inputRequired({
                    inputRequests: {
                        user_context: inputRequired.elicit({
                            message: 'What context should the prompt use?',
                            requestedSchema: {
                                type: 'object',
                                properties: { context: { type: 'string' } },
                                required: ['context']
                            }
                        })
                    }
                });
            }
            return {
                messages: [
                    {
                        role: 'user',
                        content: { type: 'text', text: `Use the following context: ${promptContext}` }
                    }
                ]
            };
        }
    );

    // Prompt with image
    mcpServer.registerPrompt(
        'test_prompt_with_image',
        {
            title: 'Prompt With Image',
            description: 'A prompt that includes image content'
        },
        async (): Promise<GetPromptResult> => {
            return {
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'image',
                            data: TEST_IMAGE_BASE64,
                            mimeType: 'image/png'
                        }
                    },
                    {
                        role: 'user',
                        content: { type: 'text', text: 'Please analyze the image above.' }
                    }
                ]
            };
        }
    );

    // ===== LOGGING =====

    mcpServer.server.setRequestHandler('logging/setLevel', async request => {
        const level = request.params.level;
        sendLog('info', `Log level set to: ${level}`);
        return {};
    });

    // ===== COMPLETION =====

    mcpServer.server.setRequestHandler('completion/complete', async () => {
        // Basic completion support - returns empty array for conformance
        // Real implementations would provide contextual suggestions
        return {
            completion: {
                values: [],
                total: 0,
                hasMore: false
            }
        };
    });

    return mcpServer;
}

// ===== 2026-07-28 (MODERN ERA) SERVING =====

// Modern-era traffic — requests claiming the per-request `_meta` envelope
// mechanism (SEP-2575), including `server/discover` and malformed variants of
// the claim — is served through `createMcpHandler`, backed by the same
// `createMcpServer()` fixture definition the 2025 sessions use. Legacy traffic
// never reaches this handler (see the routing in the POST handler below), so
// the 2025 stateful session path is unchanged.
const modernHandler = createMcpHandler(() => createMcpServer(), {
    onerror: error => console.error('Modern-era MCP handler error:', error)
});
const modernNodeHandler = toNodeHandler(modernHandler);

/** Normalize a possibly-repeated HTTP header to its first value. */
function headerValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

// ===== EXPRESS APP =====

const app = express();
app.use(express.json());

// DNS rebinding protection: reject non-localhost Host headers
app.use(localhostHostValidation());

// Configure CORS to expose Mcp-Session-Id header for browser-based clients
app.use(
    cors({
        origin: '*',
        exposedHeaders: ['Mcp-Session-Id'],
        allowedHeaders: ['Content-Type', 'mcp-session-id', 'last-event-id']
    })
);

// Handle POST requests - stateful mode
app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
        // 2026-07-28 (modern era) traffic: anything claiming the per-request
        // envelope mechanism — including malformed claims, which must get the
        // modern validation-ladder errors rather than the 2025 session errors —
        // is served by the createMcpHandler entry. Legacy-classified requests
        // (initialize, no-claim traffic, batches, posted responses) fall
        // through to the stateful 2025 session path below, untouched.
        const inbound = classifyInboundRequest({
            httpMethod: req.method,
            protocolVersionHeader: headerValue(req.headers['mcp-protocol-version']),
            mcpMethodHeader: headerValue(req.headers['mcp-method']),
            body: req.body
        });
        if (inbound.kind !== 'legacy') {
            await modernNodeHandler(req, res, req.body);
            return;
        }

        let transport: NodeStreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
            // Reuse existing transport for established sessions
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // Create new transport for initialization requests
            const mcpServer = createMcpServer();

            transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                eventStore: createEventStore(),
                retryInterval: 5000, // 5 second retry interval for SEP-1699
                onsessioninitialized: (newSessionId: string) => {
                    transports[newSessionId] = transport;
                    servers[newSessionId] = mcpServer;
                    console.log(`Session initialized with ID: ${newSessionId}`);
                }
            });

            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                    delete transports[sid];
                    if (servers[sid]) {
                        servers[sid].close();
                        delete servers[sid];
                    }
                    console.log(`Session ${sid} closed`);
                }
            };

            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
        } else if (sessionId) {
            res.status(404).json({
                jsonrpc: '2.0',
                error: { code: -32_001, message: 'Session not found' },
                id: null
            });
            return;
        } else {
            res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32_000, message: 'Bad Request: Session ID required' },
                id: null
            });
            return;
        }

        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32_603,
                    message: 'Internal server error'
                },
                id: null
            });
        }
    }
});

// Handle GET requests - SSE streams for sessions
app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
        res.status(400).send('Missing session ID');
        return;
    }
    if (!transports[sessionId]) {
        res.status(404).send('Session not found');
        return;
    }

    const lastEventId = req.headers['last-event-id'] as string | undefined;
    if (lastEventId) {
        console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
    } else {
        console.log(`Establishing SSE stream for session ${sessionId}`);
    }

    try {
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
    } catch (error) {
        console.error('Error handling SSE stream:', error);
        if (!res.headersSent) {
            res.status(500).send('Error establishing SSE stream');
        }
    }
});

// Handle DELETE requests - session termination
app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
        res.status(400).send('Missing session ID');
        return;
    }
    if (!transports[sessionId]) {
        res.status(404).send('Session not found');
        return;
    }

    console.log(`Received session termination request for session ${sessionId}`);

    try {
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
    } catch (error) {
        console.error('Error handling termination:', error);
        if (!res.headersSent) {
            res.status(500).send('Error processing session termination');
        }
    }
});

// Start server
const PORT = process.env.PORT || 3000;
const httpServer = app.listen(PORT, () => {
    console.log(`MCP Conformance Test Server running on http://localhost:${PORT}`);
    console.log(`  - MCP endpoint: http://localhost:${PORT}/mcp`);
});
httpServer.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE') {
        throw error;
    }
    console.error(`Port ${PORT} is already in use — is a stale conformance server still running?`);
    process.exit(1);
});
