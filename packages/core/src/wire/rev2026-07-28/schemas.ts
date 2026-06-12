/**
 * 2026-era wire schemas (protocol revision 2026-07-28).
 *
 * This module is the only place the per-request `_meta` envelope is modeled.
 * The envelope is wire-only vocabulary: the protocol layer lifts it off
 * inbound requests before any handler runs and surfaces it at
 * `ctx.mcpReq.envelope`; the 2026-era codec enforces its requiredness at
 * dispatch time (`checkInboundEnvelope`) - the former neutral-schema JSDoc
 * deferral ("enforced per request at dispatch time, not here") is now
 * discharged by that codec step.
 *
 * No 2025-era traffic ever touches this module, so requiredness here is
 * bare and spec-exact (the shared-schema `.catch` hazards do not apply).
 */
import * as z from 'zod/v4';

import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    LOG_LEVEL_META_KEY,
    PROTOCOL_VERSION_META_KEY
} from '../../types/constants.js';
import {
    AnnotationsSchema,
    AudioContentSchema,
    BaseMetadataSchema,
    BlobResourceContentsSchema,
    CancelledNotificationSchema,
    ClientCapabilitiesSchema,
    ContentBlockSchema,
    CursorSchema,
    ElicitationCompleteNotificationSchema,
    IconsSchema,
    ImageContentSchema,
    ImplementationSchema,
    LoggingLevelSchema,
    LoggingMessageNotificationSchema,
    ProgressNotificationSchema,
    ProgressTokenSchema,
    PromptListChangedNotificationSchema,
    PromptMessageSchema,
    PromptReferenceSchema,
    PromptSchema,
    ResourceContentsSchema,
    ResourceListChangedNotificationSchema,
    ResourceSchema,
    ResourceTemplateReferenceSchema,
    ResourceTemplateSchema,
    ResourceUpdatedNotificationSchema,
    RoleSchema,
    ServerCapabilitiesSchema,
    TextContentSchema,
    TextResourceContentsSchema,
    ToolAnnotationsSchema,
    ToolListChangedNotificationSchema,
    ToolUseContentSchema
} from '../../types/schemas.js';

/* Per-request `_meta` envelope */
/**
 * The per-request `_meta` envelope carried by every request under protocol revision
 * 2026-07-28: the protocol version governing the request, the client implementation
 * info, and the client's capabilities — declared per request rather than once at
 * initialization — plus the optional log-level opt-in.
 *
 * This schema models the complete envelope on its own (loose: foreign keys
 * pass through - the lift extracts exactly the reserved keys, so enforcement
 * never sees extension material). Requiredness is enforced per request at
 * dispatch time by the 2026-era codec's `checkInboundEnvelope` step.
 */
export const RequestMetaEnvelopeSchema = z.looseObject({
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: ProgressTokenSchema.optional(),
    /**
     * The MCP protocol version being used for this request. For the HTTP transport,
     * the value must match the `MCP-Protocol-Version` header.
     */
    [PROTOCOL_VERSION_META_KEY]: z.string(),
    /**
     * Identifies the client software making the request.
     */
    [CLIENT_INFO_META_KEY]: ImplementationSchema,
    /**
     * The client's capabilities for this specific request. An empty object means the
     * client supports no optional capabilities. Servers must not infer capabilities
     * from prior requests.
     */
    [CLIENT_CAPABILITIES_META_KEY]: ClientCapabilitiesSchema,
    /**
     * The desired log level for this request. When absent, the server must not send
     * `notifications/message` notifications for the request.
     *
     * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
     * in the specification for at least twelve months.
     */
    [LOG_LEVEL_META_KEY]: LoggingLevelSchema.optional()
});

/* ------------------------------------------------------------------------ *
 * Forked payload vocabulary (shared-tier admission rule, ATK-B section 1):
 * `Tool` and `SamplingMessage` are bidirectionally incomparable between the
 * 2025-11-25 and 2026-07-28 anchors, so they FORK per wire module instead of
 * sitting in the shared tier. The forks below are 2026-anchor-exact:
 * - Tool (2026) has NO `execution` member (ToolExecution and its
 *   `taskSupport` carrier are deleted vocabulary) — a 2026 peer's tool that
 *   carries one is stripped on parse, and the encode side strips it from
 *   outbound tools (Q1-SD3 iii).
 * - SamplingMessage (2026) is composed against the 2026 anchor shape.
 * ------------------------------------------------------------------------ */

/** 2026-era Tool: anchor-exact — no `execution` (deleted vocabulary). */
export const ToolSchema = z.object({
    ...BaseMetadataSchema.shape,
    ...IconsSchema.shape,
    description: z.string().optional(),
    // Anchor-exact: { $schema?: string; type: 'object'; [key: string]: unknown }
    inputSchema: z.looseObject({
        $schema: z.string().optional(),
        type: z.literal('object')
    }),
    // Anchor-exact: { $schema?: string; [key: string]: unknown }
    outputSchema: z
        .looseObject({
            $schema: z.string().optional()
        })
        .optional(),
    annotations: ToolAnnotationsSchema.optional(),
    _meta: z.record(z.string(), z.unknown()).optional()
});

/** 2026-era ToolResultContent (anchor-exact: `structuredContent?: unknown`). */
export const ToolResultContentSchema = z.object({
    type: z.literal('tool_result'),
    toolUseId: z.string(),
    content: z.array(ContentBlockSchema),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
    _meta: z.record(z.string(), z.unknown()).optional()
});

/** 2026-era sampling content union (composes the forked tool-result shape). */
export const SamplingMessageContentBlockSchema = z.union([
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ToolUseContentSchema,
    ToolResultContentSchema
]);

/** 2026-era SamplingMessage (anchor-exact: single block or array). */
export const SamplingMessageSchema = z.object({
    role: RoleSchema,
    content: z.union([SamplingMessageContentBlockSchema, z.array(SamplingMessageContentBlockSchema)]),
    _meta: z.record(z.string(), z.unknown()).optional()
});

/** 2026-era capabilities: the shared shapes minus the deleted `tasks` key. */
export const ClientCapabilities2026Schema = ClientCapabilitiesSchema.omit({ tasks: true });
export const ServerCapabilities2026Schema = ServerCapabilitiesSchema.omit({ tasks: true });

/* ------------------------------------------------------------------------ *
 * Result side. `resultType` is REQUIRED at parse (spec.types.2026-07-28
 * Result.resultType: "Servers implementing this protocol version MUST
 * include this field"); requiredness is bare because no 2025-era traffic
 * touches this module. These are the WIRE-TRUE artifacts — the corpus and
 * the parity suite parse them; `decodeResult` parses with them and then
 * LIFTS (drops resultType) to the neutral shape.
 * ------------------------------------------------------------------------ */

/** Open union per the anchor: 'complete' | 'input_required' | string. */
export const ResultTypeSchema = z.string();

const wireMeta = z.record(z.string(), z.unknown()).optional();

function wireResult<T extends z.core.$ZodLooseShape>(shape: T) {
    return z.looseObject({
        _meta: wireMeta,
        /** REQUIRED on this revision (see module header). */
        resultType: ResultTypeSchema,
        ...shape
    });
}

export const ResultSchema = wireResult({});

export const PaginatedResultSchema = wireResult({
    nextCursor: CursorSchema.optional()
});

export const CallToolResultSchema = wireResult({
    content: z.array(ContentBlockSchema),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional()
});

export const ListToolsResultSchema = wireResult({
    ttlMs: z.number().min(0),
    cacheScope: z.enum(['public', 'private']),
    tools: z.array(ToolSchema),
    nextCursor: CursorSchema.optional()
});

export const ListPromptsResultSchema = wireResult({
    ttlMs: z.number().min(0),
    cacheScope: z.enum(['public', 'private']),
    prompts: z.array(PromptSchema),
    nextCursor: CursorSchema.optional()
});

export const GetPromptResultSchema = wireResult({
    description: z.string().optional(),
    messages: z.array(PromptMessageSchema)
});

export const ListResourcesResultSchema = wireResult({
    ttlMs: z.number().min(0),
    cacheScope: z.enum(['public', 'private']),
    resources: z.array(ResourceSchema),
    nextCursor: CursorSchema.optional()
});

export const ListResourceTemplatesResultSchema = wireResult({
    ttlMs: z.number().min(0),
    cacheScope: z.enum(['public', 'private']),
    resourceTemplates: z.array(ResourceTemplateSchema),
    nextCursor: CursorSchema.optional()
});

export const ReadResourceResultSchema = wireResult({
    ttlMs: z.number().min(0),
    cacheScope: z.enum(['public', 'private']),
    contents: z.array(z.union([TextResourceContentsSchema, BlobResourceContentsSchema]))
});

export const CompleteResultSchema = wireResult({
    completion: z
        .object({
            values: z.array(z.string()).max(100),
            total: z.number().int().optional(),
            hasMore: z.boolean().optional()
        })
        .loose()
});

/** CacheableResult (SEP-2549): ttlMs and cacheScope REQUIRED per the anchor. */
export const CacheableResultSchema = wireResult({
    ttlMs: z.number().min(0),
    cacheScope: z.enum(['public', 'private'])
});

export const DiscoverResultSchema = wireResult({
    ttlMs: z.number().min(0),
    cacheScope: z.enum(['public', 'private']),
    supportedVersions: z.array(z.string()),
    capabilities: ServerCapabilities2026Schema,
    serverInfo: ImplementationSchema,
    instructions: z.string().optional()
});

/* ------------------------------------------------------------------------ *
 * Request side. Two views per method:
 * - WIRE-TRUE (`<Name>RequestSchema`): params `_meta` carries the REQUIRED
 *   envelope (anchor RequestParams._meta is required). The corpus and parity
 *   suite consume these.
 * - DISPATCH (post-lift, internal to the registry): the protocol layer's
 *   universal lift has already extracted the envelope, so dispatch parses a
 *   2025-like shape with optional `_meta` (progressToken/extension keys
 *   only) and NO 2025-only members (`task` is undeclared and strips —
 *   payload-level deletion is physical on this leg).
 * ------------------------------------------------------------------------ */

/** Post-lift request `_meta` (progressToken + extension keys; loose). */
const DispatchRequestMetaSchema = z.looseObject({
    progressToken: ProgressTokenSchema.optional()
});

function wireRequest<M extends string, T extends z.core.$ZodLooseShape>(method: M, paramsShape: T) {
    return z.object({
        method: z.literal(method),
        params: z.object({ _meta: RequestMetaEnvelopeSchema, ...paramsShape })
    });
}

function dispatchRequest<M extends string, T extends z.core.$ZodLooseShape>(method: M, paramsShape: T) {
    return z.object({
        method: z.literal(method),
        params: z.object({ _meta: DispatchRequestMetaSchema.optional(), ...paramsShape }).optional()
    });
}

const callToolParamsShape = {
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional()
};
const paginatedParamsShape = { cursor: CursorSchema.optional() };

export const CallToolRequestSchema = wireRequest('tools/call', callToolParamsShape);
export const ListToolsRequestSchema = wireRequest('tools/list', paginatedParamsShape);
export const ListPromptsRequestSchema = wireRequest('prompts/list', paginatedParamsShape);
export const GetPromptRequestSchema = wireRequest('prompts/get', {
    name: z.string(),
    arguments: z.record(z.string(), z.string()).optional()
});
export const ListResourcesRequestSchema = wireRequest('resources/list', paginatedParamsShape);
export const ListResourceTemplatesRequestSchema = wireRequest('resources/templates/list', paginatedParamsShape);
export const ReadResourceRequestSchema = wireRequest('resources/read', { uri: z.string() });
const completeParamsShape = {
    ref: z.union([PromptReferenceSchema, ResourceTemplateReferenceSchema]),
    argument: z.object({ name: z.string(), value: z.string() }),
    context: z.object({ arguments: z.record(z.string(), z.string()).optional() }).optional()
};
export const CompleteRequestSchema = wireRequest('completion/complete', completeParamsShape);
export const DiscoverRequestSchema = wireRequest('server/discover', {});

/** Dispatch (post-lift) request schemas, keyed by method — registry-internal. */
export const dispatchRequestSchemas: Record<string, z.ZodType> = {
    'tools/call': dispatchRequest('tools/call', callToolParamsShape) as unknown as z.ZodType,
    'tools/list': dispatchRequest('tools/list', paginatedParamsShape) as unknown as z.ZodType,
    'prompts/get': dispatchRequest('prompts/get', {
        name: z.string(),
        arguments: z.record(z.string(), z.string()).optional()
    }) as unknown as z.ZodType,
    'prompts/list': dispatchRequest('prompts/list', paginatedParamsShape) as unknown as z.ZodType,
    'resources/list': dispatchRequest('resources/list', paginatedParamsShape) as unknown as z.ZodType,
    'resources/templates/list': dispatchRequest('resources/templates/list', paginatedParamsShape) as unknown as z.ZodType,
    'resources/read': dispatchRequest('resources/read', { uri: z.string() }) as unknown as z.ZodType,
    'completion/complete': dispatchRequest('completion/complete', completeParamsShape) as unknown as z.ZodType,
    'server/discover': dispatchRequest('server/discover', {}) as unknown as z.ZodType
};

/** Dispatch (post-lift) result schemas, keyed by method — what the funnel
 * validates AFTER `decodeResult` consumed `resultType`. */
function liftedResult<T extends z.core.$ZodLooseShape>(shape: T) {
    return z.looseObject({ _meta: wireMeta, ...shape });
}

export const dispatchResultSchemas: Record<string, z.ZodType> = {
    'tools/call': liftedResult({
        content: z.array(ContentBlockSchema),
        structuredContent: z.unknown().optional(),
        isError: z.boolean().optional()
    }) as unknown as z.ZodType,
    'tools/list': liftedResult({
        ttlMs: z.number().min(0),
        cacheScope: z.enum(['public', 'private']),
        tools: z.array(ToolSchema),
        nextCursor: CursorSchema.optional()
    }) as unknown as z.ZodType,
    'prompts/get': liftedResult({
        description: z.string().optional(),
        messages: z.array(PromptMessageSchema)
    }) as unknown as z.ZodType,
    'prompts/list': liftedResult({
        ttlMs: z.number().min(0),
        cacheScope: z.enum(['public', 'private']),
        prompts: z.array(PromptSchema),
        nextCursor: CursorSchema.optional()
    }) as unknown as z.ZodType,
    'resources/list': liftedResult({
        ttlMs: z.number().min(0),
        cacheScope: z.enum(['public', 'private']),
        resources: z.array(ResourceSchema),
        nextCursor: CursorSchema.optional()
    }) as unknown as z.ZodType,
    'resources/templates/list': liftedResult({
        ttlMs: z.number().min(0),
        cacheScope: z.enum(['public', 'private']),
        resourceTemplates: z.array(ResourceTemplateSchema),
        nextCursor: CursorSchema.optional()
    }) as unknown as z.ZodType,
    'resources/read': liftedResult({
        ttlMs: z.number().min(0),
        cacheScope: z.enum(['public', 'private']),
        contents: z.array(z.union([TextResourceContentsSchema, BlobResourceContentsSchema]))
    }) as unknown as z.ZodType,
    'completion/complete': liftedResult({
        completion: z
            .object({
                values: z.array(z.string()).max(100),
                total: z.number().int().optional(),
                hasMore: z.boolean().optional()
            })
            .loose()
    }) as unknown as z.ZodType,
    'server/discover': liftedResult({
        ttlMs: z.number().min(0),
        cacheScope: z.enum(['public', 'private']),
        supportedVersions: z.array(z.string()),
        capabilities: ServerCapabilities2026Schema,
        serverInfo: ImplementationSchema,
        instructions: z.string().optional()
    }) as unknown as z.ZodType
};

/* ------------------------------------------------------------------------ *
 * Notifications. The 2026 notification set: cancelled, progress, message,
 * resources/updated, resources/list_changed, tools/list_changed,
 * prompts/list_changed, elicitation/complete. Deleted: initialized,
 * roots/list_changed, tasks/status. The shapes are revision-identical to the
 * shared schemas, which are composed by reference. (The 2026-only
 * subscriptions/acknowledged notification is #14 scope — see registry.ts.)
 * ------------------------------------------------------------------------ */
export const notificationSchemas2026: Record<string, z.ZodType> = {
    'notifications/cancelled': CancelledNotificationSchema as unknown as z.ZodType,
    'notifications/progress': ProgressNotificationSchema as unknown as z.ZodType,
    'notifications/message': LoggingMessageNotificationSchema as unknown as z.ZodType,
    'notifications/resources/updated': ResourceUpdatedNotificationSchema as unknown as z.ZodType,
    'notifications/resources/list_changed': ResourceListChangedNotificationSchema as unknown as z.ZodType,
    'notifications/tools/list_changed': ToolListChangedNotificationSchema as unknown as z.ZodType,
    'notifications/prompts/list_changed': PromptListChangedNotificationSchema as unknown as z.ZodType,
    'notifications/elicitation/complete': ElicitationCompleteNotificationSchema as unknown as z.ZodType
};

/* ------------------------------------------------------------------------ *
 * Response envelopes (wire-true; parity/corpus artifacts).
 * ------------------------------------------------------------------------ */
const wireResultResponse = <T extends z.ZodType>(result: T) =>
    z
        .object({
            jsonrpc: z.literal('2.0'),
            id: z.union([z.string(), z.number().int()]),
            result
        })
        .strict();

export const JSONRPCResultResponseSchema = wireResultResponse(ResultSchema);
export const CallToolResultResponseSchema = wireResultResponse(CallToolResultSchema);
export const ListToolsResultResponseSchema = wireResultResponse(ListToolsResultSchema);
export const ListPromptsResultResponseSchema = wireResultResponse(ListPromptsResultSchema);
export const GetPromptResultResponseSchema = wireResultResponse(GetPromptResultSchema);
export const ListResourcesResultResponseSchema = wireResultResponse(ListResourcesResultSchema);
export const ListResourceTemplatesResultResponseSchema = wireResultResponse(ListResourceTemplatesResultSchema);
export const ReadResourceResultResponseSchema = wireResultResponse(ReadResourceResultSchema);
export const CompleteResultResponseSchema = wireResultResponse(CompleteResultSchema);
export const DiscoverResultResponseSchema = wireResultResponse(DiscoverResultSchema);

// Referenced by reference to keep the compose-by-reference relationships
// explicit for tooling (these shared payloads serve both eras unchanged).
void AnnotationsSchema;
void ResourceContentsSchema;
