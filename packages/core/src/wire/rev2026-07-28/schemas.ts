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
    ClientCapabilitiesSchema,
    ContentBlockSchema,
    CursorSchema,
    ElicitRequestFormParamsSchema,
    IconsSchema,
    ImageContentSchema,
    ImplementationSchema,
    JSONObjectSchema,
    LoggingLevelSchema,
    LoggingMessageNotificationSchema,
    ModelPreferencesSchema,
    ProgressNotificationSchema,
    ProgressTokenSchema,
    PromptListChangedNotificationSchema,
    PromptMessageSchema,
    PromptReferenceSchema,
    PromptSchema,
    RequestIdSchema,
    ResourceContentsSchema,
    ResourceListChangedNotificationSchema,
    ResourceSchema,
    ResourceTemplateReferenceSchema,
    ResourceTemplateSchema,
    ResourceUpdatedNotificationSchema,
    RoleSchema,
    RootSchema,
    ServerCapabilitiesSchema,
    TextContentSchema,
    TextResourceContentsSchema,
    ToolAnnotationsSchema,
    ToolChoiceSchema,
    ToolListChangedNotificationSchema,
    ToolUseContentSchema
} from '../../types/schemas.js';

/* 2026-era capability forks (defined ahead of the envelope, which composes
 * the client fork). The shared shapes minus the deleted `tasks` key: `tasks`
 * is 2025-only vocabulary with no slot on this revision, consistent with the
 * encode-side deletion (Q1-SD3 iii).
 *
 * The client fork lists its members EXPLICITLY (composing the shared member
 * schemas by reference) rather than using `.omit()`: the envelope schema
 * below reaches the bundled package declarations, and an `.omit()` inference
 * is a mapped type whose printed member order is unstable across dts-rollup
 * builds (api-report flap). The explicit list doubles as the fork's deletion
 * statement — a member added to the shared shape must be re-adjudicated here. */
const sharedClientCapabilityShape = ClientCapabilitiesSchema.shape;
export const ClientCapabilities2026Schema = z.object({
    experimental: sharedClientCapabilityShape.experimental,
    sampling: sharedClientCapabilityShape.sampling,
    elicitation: sharedClientCapabilityShape.elicitation,
    roots: sharedClientCapabilityShape.roots,
    extensions: sharedClientCapabilityShape.extensions
});
export const ServerCapabilities2026Schema = ServerCapabilitiesSchema.omit({ tasks: true });

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
     * from prior requests. Validated with the 2026 fork: `tasks` has no slot on
     * this revision (deleted vocabulary), matching the server-side fork wired
     * into `DiscoverResultSchema`.
     */
    [CLIENT_CAPABILITIES_META_KEY]: ClientCapabilities2026Schema,
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
    ttlMs: z.number().int().min(0),
    cacheScope: z.enum(['public', 'private']),
    tools: z.array(ToolSchema),
    nextCursor: CursorSchema.optional()
});

export const ListPromptsResultSchema = wireResult({
    ttlMs: z.number().int().min(0),
    cacheScope: z.enum(['public', 'private']),
    prompts: z.array(PromptSchema),
    nextCursor: CursorSchema.optional()
});

export const GetPromptResultSchema = wireResult({
    description: z.string().optional(),
    messages: z.array(PromptMessageSchema)
});

export const ListResourcesResultSchema = wireResult({
    ttlMs: z.number().int().min(0),
    cacheScope: z.enum(['public', 'private']),
    resources: z.array(ResourceSchema),
    nextCursor: CursorSchema.optional()
});

export const ListResourceTemplatesResultSchema = wireResult({
    ttlMs: z.number().int().min(0),
    cacheScope: z.enum(['public', 'private']),
    resourceTemplates: z.array(ResourceTemplateSchema),
    nextCursor: CursorSchema.optional()
});

export const ReadResourceResultSchema = wireResult({
    ttlMs: z.number().int().min(0),
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
    ttlMs: z.number().int().min(0),
    cacheScope: z.enum(['public', 'private'])
});

export const DiscoverResultSchema = wireResult({
    ttlMs: z.number().int().min(0),
    cacheScope: z.enum(['public', 'private']),
    supportedVersions: z.array(z.string()),
    capabilities: ServerCapabilities2026Schema,
    serverInfo: ImplementationSchema,
    instructions: z.string().optional()
});

/* ------------------------------------------------------------------------ *
 * Multi round-trip requests (SEP-2322). The in-band vocabulary of this
 * revision: server→client interactions are carried as de-JSON-RPC'd embedded
 * requests inside an `input_required` result, fulfilled by the client, and
 * echoed back as embedded responses on the retry. The shapes below are
 * anchor-exact wire artifacts (corpus + parity); the lenient dispatch-time
 * schemas the multi-round-trip driver parses embedded requests with live in
 * `inputRequired.ts`.
 *
 * The sampling shapes fork here (they compose the forked SamplingMessage /
 * Tool payloads); the URL-mode elicitation params fork here (the draft
 * removed `elicitationId`; the shared schema keeps it because it is required
 * on the frozen 2025-11-25 revision); form-mode elicitation params are
 * revision-identical and are composed by reference from the shared schema.
 * ------------------------------------------------------------------------ */

/** 2026-era CreateMessageRequestParams (anchor-exact: forked SamplingMessage/Tool, no task augmentation). */
export const CreateMessageRequestParamsSchema = z.object({
    messages: z.array(SamplingMessageSchema),
    modelPreferences: ModelPreferencesSchema.optional(),
    systemPrompt: z.string().optional(),
    includeContext: z.enum(['none', 'thisServer', 'allServers']).optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().int(),
    stopSequences: z.array(z.string()).optional(),
    metadata: JSONObjectSchema.optional(),
    tools: z.array(ToolSchema).optional(),
    toolChoice: ToolChoiceSchema.optional()
});

/** 2026-era embedded sampling request (de-JSON-RPC'd). */
export const CreateMessageRequestSchema = z.object({
    method: z.literal('sampling/createMessage'),
    params: CreateMessageRequestParamsSchema
});

/**
 * 2026-era embedded roots listing request (de-JSON-RPC'd). Embedded input
 * requests do NOT carry the per-request `_meta` envelope on this revision —
 * the anchor declares a bare optional `_meta` on `params`.
 */
export const ListRootsRequestSchema = z.object({
    method: z.literal('roots/list'),
    params: z.object({ _meta: z.record(z.string(), z.unknown()).optional() }).optional()
});

/** 2026-era embedded sampling response (anchor-exact: extends the forked SamplingMessage). */
export const CreateMessageResultSchema = z.object({
    ...SamplingMessageSchema.shape,
    model: z.string(),
    stopReason: z.string().optional()
});

/** 2026-era embedded roots listing response (anchor-exact: bare `roots` array). */
export const ListRootsResultSchema = z.object({
    roots: z.array(RootSchema)
});

/** 2026-era embedded elicitation response (anchor-exact: bare result, restricted content value types). */
export const ElicitResultSchema = z.object({
    action: z.enum(['accept', 'decline', 'cancel']),
    content: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional()
});

/**
 * 2026-era URL-mode elicitation params (anchor-exact fork): the draft removed
 * `elicitationId` (and the `notifications/elicitation/complete` channel it
 * keyed) — the shared schema keeps the field because it is required on the
 * frozen 2025-11-25 revision.
 */
export const ElicitRequestURLParamsSchema = z.object({
    mode: z.literal('url'),
    message: z.string(),
    url: z.string().url()
});

/** 2026-era elicitation params (form mode is revision-identical; URL mode is the fork above). */
export const ElicitRequestParamsSchema = z.union([ElicitRequestFormParamsSchema, ElicitRequestURLParamsSchema]);

/** 2026-era embedded elicitation request (de-JSON-RPC'd; see the URL-mode fork above). */
export const ElicitRequestSchema = z.object({
    method: z.literal('elicitation/create'),
    params: ElicitRequestParamsSchema
});

/** A single embedded input request (one of the three demoted server→client requests). */
export const InputRequestSchema = z.union([CreateMessageRequestSchema, ListRootsRequestSchema, ElicitRequestSchema]);

/** A single embedded input response — the BARE result union (never a `{method, result}` wrapper). */
export const InputResponseSchema = z.union([CreateMessageResultSchema, ListRootsResultSchema, ElicitResultSchema]);

/** Map of embedded input requests, keyed by server-assigned identifiers. */
export const InputRequestsSchema = z.record(z.string(), InputRequestSchema);

/** Map of embedded input responses, keyed by the corresponding request identifiers. */
export const InputResponsesSchema = z.record(z.string(), InputResponseSchema);

/**
 * The wire InputRequiredResult: `resultType: 'input_required'` plus at least
 * one of `inputRequests` / `requestState` (the at-least-one rule is enforced
 * at the server seam, not by this parse shape).
 */
export const InputRequiredResultSchema = wireResult({
    inputRequests: InputRequestsSchema.optional(),
    requestState: z.string().optional()
});

/** The retry-channel members carried by client-initiated requests on this revision. */
const retryParamsShape = {
    inputResponses: InputResponsesSchema.optional(),
    requestState: z.string().optional()
};

/** Anchor InputResponseRequestParams: the retry channel on top of the required request `_meta` envelope. */
export const InputResponseRequestParamsSchema = z.object({
    _meta: RequestMetaEnvelopeSchema,
    ...retryParamsShape
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
    arguments: z.record(z.string(), z.unknown()).optional(),
    // Multi-round-trip retry channel (the wire-true view models it; dispatch
    // never sees it — the protocol layer lifts it before any handler runs).
    ...retryParamsShape
};
const paginatedParamsShape = { cursor: CursorSchema.optional() };

export const CallToolRequestSchema = wireRequest('tools/call', callToolParamsShape);
export const ListToolsRequestSchema = wireRequest('tools/list', paginatedParamsShape);
export const ListPromptsRequestSchema = wireRequest('prompts/list', paginatedParamsShape);
export const GetPromptRequestSchema = wireRequest('prompts/get', {
    name: z.string(),
    arguments: z.record(z.string(), z.string()).optional(),
    ...retryParamsShape
});
export const ListResourcesRequestSchema = wireRequest('resources/list', paginatedParamsShape);
export const ListResourceTemplatesRequestSchema = wireRequest('resources/templates/list', paginatedParamsShape);
export const ReadResourceRequestSchema = wireRequest('resources/read', { uri: z.string(), ...retryParamsShape });
const completeParamsShape = {
    ref: z.union([PromptReferenceSchema, ResourceTemplateReferenceSchema]),
    argument: z.object({ name: z.string(), value: z.string() }),
    context: z.object({ arguments: z.record(z.string(), z.string()).optional() }).optional()
};
export const CompleteRequestSchema = wireRequest('completion/complete', completeParamsShape);
export const DiscoverRequestSchema = wireRequest('server/discover', {});

/**
 * The 2026-era request-method set — the hand-registry seed (see registry.ts
 * for the seed decisions). The dispatch maps below are mapped types over this
 * union, so a missing entry, an extra entry, or an entry pointing at another
 * method's schema is a compile error; the CI registry-diff oracle pins the
 * same set against the anchor at runtime.
 */
export type Rev2026RequestMethod =
    | 'tools/call'
    | 'tools/list'
    | 'prompts/get'
    | 'prompts/list'
    | 'resources/list'
    | 'resources/templates/list'
    | 'resources/read'
    | 'completion/complete'
    | 'server/discover';

/** Dispatch (post-lift) request schemas, keyed by method — registry-internal. */
export const dispatchRequestSchemas: { readonly [M in Rev2026RequestMethod]: z.ZodType<{ method: M }> } = {
    'tools/call': dispatchRequest('tools/call', callToolParamsShape),
    'tools/list': dispatchRequest('tools/list', paginatedParamsShape),
    'prompts/get': dispatchRequest('prompts/get', {
        name: z.string(),
        arguments: z.record(z.string(), z.string()).optional()
    }),
    'prompts/list': dispatchRequest('prompts/list', paginatedParamsShape),
    'resources/list': dispatchRequest('resources/list', paginatedParamsShape),
    'resources/templates/list': dispatchRequest('resources/templates/list', paginatedParamsShape),
    'resources/read': dispatchRequest('resources/read', { uri: z.string() }),
    'completion/complete': dispatchRequest('completion/complete', completeParamsShape),
    'server/discover': dispatchRequest('server/discover', {})
};

/** Dispatch (post-lift) result schemas, keyed by method — what the funnel
 * validates AFTER `decodeResult` consumed `resultType`. */
function liftedResult<T extends z.core.$ZodLooseShape>(shape: T) {
    return z.looseObject({ _meta: wireMeta, ...shape });
}

export const dispatchResultSchemas: { readonly [M in Rev2026RequestMethod]: z.ZodType } = {
    'tools/call': liftedResult({
        content: z.array(ContentBlockSchema),
        structuredContent: z.unknown().optional(),
        isError: z.boolean().optional()
    }),
    'tools/list': liftedResult({
        ttlMs: z.number().int().min(0),
        cacheScope: z.enum(['public', 'private']),
        tools: z.array(ToolSchema),
        nextCursor: CursorSchema.optional()
    }),
    'prompts/get': liftedResult({
        description: z.string().optional(),
        messages: z.array(PromptMessageSchema)
    }),
    'prompts/list': liftedResult({
        ttlMs: z.number().int().min(0),
        cacheScope: z.enum(['public', 'private']),
        prompts: z.array(PromptSchema),
        nextCursor: CursorSchema.optional()
    }),
    'resources/list': liftedResult({
        ttlMs: z.number().int().min(0),
        cacheScope: z.enum(['public', 'private']),
        resources: z.array(ResourceSchema),
        nextCursor: CursorSchema.optional()
    }),
    'resources/templates/list': liftedResult({
        ttlMs: z.number().int().min(0),
        cacheScope: z.enum(['public', 'private']),
        resourceTemplates: z.array(ResourceTemplateSchema),
        nextCursor: CursorSchema.optional()
    }),
    'resources/read': liftedResult({
        ttlMs: z.number().int().min(0),
        cacheScope: z.enum(['public', 'private']),
        contents: z.array(z.union([TextResourceContentsSchema, BlobResourceContentsSchema]))
    }),
    'completion/complete': liftedResult({
        completion: z
            .object({
                values: z.array(z.string()).max(100),
                total: z.number().int().optional(),
                hasMore: z.boolean().optional()
            })
            .loose()
    }),
    'server/discover': liftedResult({
        ttlMs: z.number().int().min(0),
        cacheScope: z.enum(['public', 'private']),
        supportedVersions: z.array(z.string()),
        capabilities: ServerCapabilities2026Schema,
        serverInfo: ImplementationSchema,
        instructions: z.string().optional()
    })
};

/* ------------------------------------------------------------------------ *
 * Notifications. The 2026 notification set: cancelled, progress, message,
 * resources/updated, resources/list_changed, tools/list_changed,
 * prompts/list_changed. Deleted: initialized, roots/list_changed,
 * tasks/status, elicitation/complete (removed from the draft together with
 * URL-elicitation's elicitationId — both remain 2025-11-25 vocabulary only).
 * The shapes are revision-identical to the shared schemas, which are
 * composed by reference, EXCEPT cancelled, which forks below: this revision
 * requires `requestId`. (The 2026-only subscriptions/acknowledged
 * notification is #14 scope — see registry.ts.)
 * ------------------------------------------------------------------------ */

/**
 * Notification `_meta` (anchor `NotificationMetaObject`): loose, with the
 * subscriptions/listen demux key typed when present. Only the anchor-exact
 * SHAPE is modeled here — listen delivery itself (filter gating, demux,
 * teardown) is #14 scope and not implemented by this module.
 */
export const NotificationMetaSchema = z.looseObject({
    /**
     * The JSON-RPC ID of the `subscriptions/listen` request that opened the
     * stream a notification was delivered on; absent on notifications not
     * delivered via a subscription stream.
     */
    'io.modelcontextprotocol/subscriptionId': RequestIdSchema.optional()
});

/**
 * 2026-era `notifications/cancelled` params (anchor-exact fork): `requestId`
 * is REQUIRED on this revision — the shared schema keeps it optional because
 * the frozen 2025-11-25 shape declares it optional (task cancellation goes
 * through `tasks/cancel` there). Requiredness is bare because no 2025-era
 * traffic touches this module.
 */
export const CancelledNotificationParamsSchema = z.object({
    _meta: NotificationMetaSchema.optional(),
    /**
     * The ID of the request to cancel. This MUST correspond to the ID of a
     * request the client previously issued.
     */
    requestId: RequestIdSchema,
    /**
     * An optional string describing the reason for the cancellation. This MAY
     * be logged or presented to the user.
     */
    reason: z.string().optional()
});

/** 2026-era `notifications/cancelled` (see the params fork above). */
export const CancelledNotificationSchema = z.object({
    method: z.literal('notifications/cancelled'),
    params: CancelledNotificationParamsSchema
});

/** The 2026-era notification-method set (the hand-registry seed; see the deletion list above). */
export type Rev2026NotificationMethod =
    | 'notifications/cancelled'
    | 'notifications/progress'
    | 'notifications/message'
    | 'notifications/resources/updated'
    | 'notifications/resources/list_changed'
    | 'notifications/tools/list_changed'
    | 'notifications/prompts/list_changed';

export const notificationSchemas2026: { readonly [M in Rev2026NotificationMethod]: z.ZodType<{ method: M }> } = {
    'notifications/cancelled': CancelledNotificationSchema,
    'notifications/progress': ProgressNotificationSchema,
    'notifications/message': LoggingMessageNotificationSchema,
    'notifications/resources/updated': ResourceUpdatedNotificationSchema,
    'notifications/resources/list_changed': ResourceListChangedNotificationSchema,
    'notifications/tools/list_changed': ToolListChangedNotificationSchema,
    'notifications/prompts/list_changed': PromptListChangedNotificationSchema
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
// The multi-round-trip methods may answer with either their final result or an
// InputRequiredResult (anchor: `result: CallToolResult | InputRequiredResult`).
export const CallToolResultResponseSchema = wireResultResponse(z.union([CallToolResultSchema, InputRequiredResultSchema]));
export const ListToolsResultResponseSchema = wireResultResponse(ListToolsResultSchema);
export const ListPromptsResultResponseSchema = wireResultResponse(ListPromptsResultSchema);
export const GetPromptResultResponseSchema = wireResultResponse(z.union([GetPromptResultSchema, InputRequiredResultSchema]));
export const ListResourcesResultResponseSchema = wireResultResponse(ListResourcesResultSchema);
export const ListResourceTemplatesResultResponseSchema = wireResultResponse(ListResourceTemplatesResultSchema);
export const ReadResourceResultResponseSchema = wireResultResponse(z.union([ReadResourceResultSchema, InputRequiredResultSchema]));
export const CompleteResultResponseSchema = wireResultResponse(CompleteResultSchema);
export const DiscoverResultResponseSchema = wireResultResponse(DiscoverResultSchema);

// Referenced by reference to keep the compose-by-reference relationships
// explicit for tooling (these shared payloads serve both eras unchanged).
void AnnotationsSchema;
void ResourceContentsSchema;
