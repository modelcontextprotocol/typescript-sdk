/**
 * 2026-era wire schemas (protocol revision 2026-07-28).
 *
 * Fully self-contained — no runtime imports from types/schemas.ts. The
 * neutral types/schemas.ts layer is the public-API superset and is free to
 * evolve; this file is the 2026 wire-parse contract and is BEHAVIOR-FROZEN
 * against the 2026-07-28 anchor. Every era-shared building block (content
 * blocks, resources, prompts, capabilities, notifications, …) that the wire
 * shapes compose is a frozen LOCAL copy — verbatim from the neutral layer at
 * the point this revision was sealed, dependencies first. The only cross-layer
 * dependency is `import type { JSONObject, JSONValue }` from the neutral types
 * barrel — pure structural type aliases with no parse behavior.
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
import type { JSONObject, JSONValue } from '../../types/types.js';

/* ════════════════════════════════════════════════════════════════════════════
 * Frozen neutral-layer building blocks
 *
 * Everything from this point until the next ═-banner is a verbatim frozen
 * copy of a schema that, at the time this revision was sealed, lived in the
 * neutral types/schemas.ts. They are copied dependencies-first so no forward
 * references exist. They are NOT re-derived from the public layer at runtime —
 * a widening or tightening landed on types/schemas.ts has no effect here until
 * a deliberate per-revision re-freeze.
 * ════════════════════════════════════════════════════════════════════════════ */

export const JSONValueSchema: z.ZodType<JSONValue, JSONValue> = z.lazy(() =>
    z.union([z.string(), z.number(), z.boolean(), z.null(), z.record(z.string(), JSONValueSchema), z.array(JSONValueSchema)])
);
export const JSONObjectSchema: z.ZodType<JSONObject, JSONObject> = z.record(z.string(), JSONValueSchema);

/**
 * A progress token, used to associate progress notifications with the original request.
 */
export const ProgressTokenSchema = z.union([z.string(), z.number().int()]);

/**
 * An opaque token used to represent a cursor for pagination.
 */
export const CursorSchema = z.string();

/**
 * A uniquely identifying ID for a request in JSON-RPC.
 */
export const RequestIdSchema = z.union([z.string(), z.number().int()]);

/**
 * The sender or recipient of messages and data in a conversation.
 */
export const RoleSchema = z.enum(['user', 'assistant']);

/**
 * The severity of a log message.
 */
export const LoggingLevelSchema = z.enum(['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']);

/**
 * A Zod schema for validating Base64 strings that is more performant and
 * robust for very large inputs than the default regex-based check. It avoids
 * stack overflows by using the native `atob` function for validation.
 */
const Base64Schema = z.string().refine(
    val => {
        try {
            atob(val);
            return true;
        } catch {
            return false;
        }
    },
    { message: 'Invalid Base64 string' }
);

/* ─── Request/notification meta and base params ─── */

/** @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only. */
export const TaskMetadataSchema = z.object({
    ttl: z.number().optional()
});

/** @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only. */
export const RelatedTaskMetadataSchema = z.object({
    taskId: z.string()
});

export const RequestMetaSchema = z.looseObject({
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: ProgressTokenSchema.optional(),
    /**
     * If specified, this request is related to the provided task.
     */
    'io.modelcontextprotocol/related-task': RelatedTaskMetadataSchema.optional()
});

export const BaseRequestParamsSchema = z.object({
    _meta: RequestMetaSchema.optional()
});

/** @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only. */
export const TaskAugmentedRequestParamsSchema = BaseRequestParamsSchema.extend({
    task: TaskMetadataSchema.optional()
});

export const NotificationsParamsSchema = z.object({
    _meta: RequestMetaSchema.optional()
});

export const NotificationSchema = z.object({
    method: z.string(),
    params: NotificationsParamsSchema.loose().optional()
});

/* ─── Icons / base metadata / implementation ─── */

export const IconSchema = z.object({
    src: z.string(),
    mimeType: z.string().optional(),
    sizes: z.array(z.string()).optional(),
    theme: z.enum(['light', 'dark']).optional()
});

export const IconsSchema = z.object({
    icons: z.array(IconSchema).optional()
});

export const BaseMetadataSchema = z.object({
    name: z.string(),
    title: z.string().optional()
});

export const ImplementationSchema = BaseMetadataSchema.extend({
    ...BaseMetadataSchema.shape,
    ...IconsSchema.shape,
    version: z.string(),
    websiteUrl: z.string().optional(),
    description: z.string().optional()
});

/* ─── Capability schemas ─── */

const FormElicitationCapabilitySchema = z.intersection(
    z.object({
        applyDefaults: z.boolean().optional()
    }),
    JSONObjectSchema
);

const ElicitationCapabilitySchema = z.preprocess(
    value => {
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) {
            return { form: {} };
        }
        return value;
    },
    z.intersection(
        z.object({
            form: FormElicitationCapabilitySchema.optional(),
            url: JSONObjectSchema.optional()
        }),
        JSONObjectSchema.optional()
    )
);

/** @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only. */
export const ClientTasksCapabilitySchema = z.looseObject({
    list: JSONObjectSchema.optional(),
    cancel: JSONObjectSchema.optional(),
    requests: z
        .looseObject({
            sampling: z
                .looseObject({
                    createMessage: JSONObjectSchema.optional()
                })
                .optional(),
            elicitation: z
                .looseObject({
                    create: JSONObjectSchema.optional()
                })
                .optional()
        })
        .optional()
});

/** @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only. */
export const ServerTasksCapabilitySchema = z.looseObject({
    list: JSONObjectSchema.optional(),
    cancel: JSONObjectSchema.optional(),
    requests: z
        .looseObject({
            tools: z
                .looseObject({
                    call: JSONObjectSchema.optional()
                })
                .optional()
        })
        .optional()
});

export const ClientCapabilitiesSchema = z.object({
    experimental: z.record(z.string(), JSONObjectSchema).optional(),
    sampling: z
        .object({
            context: JSONObjectSchema.optional(),
            tools: JSONObjectSchema.optional()
        })
        .optional(),
    elicitation: ElicitationCapabilitySchema.optional(),
    roots: z
        .object({
            listChanged: z.boolean().optional()
        })
        .optional(),
    tasks: ClientTasksCapabilitySchema.optional(),
    extensions: z.record(z.string(), JSONObjectSchema).optional()
});

export const ServerCapabilitiesSchema = z.object({
    experimental: z.record(z.string(), JSONObjectSchema).optional(),
    logging: JSONObjectSchema.optional(),
    completions: JSONObjectSchema.optional(),
    prompts: z
        .object({
            listChanged: z.boolean().optional()
        })
        .optional(),
    resources: z
        .object({
            subscribe: z.boolean().optional(),
            listChanged: z.boolean().optional()
        })
        .optional(),
    tools: z
        .object({
            listChanged: z.boolean().optional()
        })
        .optional(),
    tasks: ServerTasksCapabilitySchema.optional(),
    extensions: z.record(z.string(), JSONObjectSchema).optional()
});

/* ─── Progress / logging notifications ─── */

export const ProgressSchema = z.object({
    progress: z.number(),
    total: z.optional(z.number()),
    message: z.optional(z.string())
});

export const ProgressNotificationParamsSchema = z.object({
    ...NotificationsParamsSchema.shape,
    ...ProgressSchema.shape,
    progressToken: ProgressTokenSchema
});

export const ProgressNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/progress'),
    params: ProgressNotificationParamsSchema
});

export const LoggingMessageNotificationParamsSchema = NotificationsParamsSchema.extend({
    level: LoggingLevelSchema,
    logger: z.string().optional(),
    data: z.unknown()
});

export const LoggingMessageNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/message'),
    params: LoggingMessageNotificationParamsSchema
});

/* ─── Resource contents / annotations ─── */

export const ResourceContentsSchema = z.object({
    uri: z.string(),
    mimeType: z.optional(z.string()),
    _meta: z.record(z.string(), z.unknown()).optional()
});

export const TextResourceContentsSchema = ResourceContentsSchema.extend({
    text: z.string()
});

export const BlobResourceContentsSchema = ResourceContentsSchema.extend({
    blob: Base64Schema
});

export const AnnotationsSchema = z.object({
    audience: z.array(RoleSchema).optional(),
    priority: z.number().min(0).max(1).optional(),
    lastModified: z.iso.datetime({ offset: true }).optional()
});

/* ─── Resources / templates / list-changed notifications ─── */

export const ResourceSchema = z.object({
    ...BaseMetadataSchema.shape,
    ...IconsSchema.shape,
    uri: z.string(),
    description: z.optional(z.string()),
    mimeType: z.optional(z.string()),
    size: z.optional(z.number()),
    annotations: AnnotationsSchema.optional(),
    _meta: z.optional(z.looseObject({}))
});

export const ResourceTemplateSchema = z.object({
    ...BaseMetadataSchema.shape,
    ...IconsSchema.shape,
    uriTemplate: z.string(),
    description: z.optional(z.string()),
    mimeType: z.optional(z.string()),
    annotations: AnnotationsSchema.optional(),
    _meta: z.optional(z.looseObject({}))
});

export const ResourceListChangedNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/resources/list_changed'),
    params: NotificationsParamsSchema.optional()
});

export const ResourceUpdatedNotificationParamsSchema = NotificationsParamsSchema.extend({
    uri: z.string()
});

export const ResourceUpdatedNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/resources/updated'),
    params: ResourceUpdatedNotificationParamsSchema
});

/* ─── Prompts / content blocks ─── */

export const PromptArgumentSchema = z.object({
    name: z.string(),
    description: z.optional(z.string()),
    required: z.optional(z.boolean())
});

export const PromptSchema = z.object({
    ...BaseMetadataSchema.shape,
    ...IconsSchema.shape,
    description: z.optional(z.string()),
    arguments: z.optional(z.array(PromptArgumentSchema)),
    _meta: z.optional(z.looseObject({}))
});

export const PromptListChangedNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/prompts/list_changed'),
    params: NotificationsParamsSchema.optional()
});

export const TextContentSchema = z.object({
    type: z.literal('text'),
    text: z.string(),
    annotations: AnnotationsSchema.optional(),
    _meta: z.record(z.string(), z.unknown()).optional()
});

export const ImageContentSchema = z.object({
    type: z.literal('image'),
    data: Base64Schema,
    mimeType: z.string(),
    annotations: AnnotationsSchema.optional(),
    _meta: z.record(z.string(), z.unknown()).optional()
});

export const AudioContentSchema = z.object({
    type: z.literal('audio'),
    data: Base64Schema,
    mimeType: z.string(),
    annotations: AnnotationsSchema.optional(),
    _meta: z.record(z.string(), z.unknown()).optional()
});

export const ToolUseContentSchema = z.object({
    type: z.literal('tool_use'),
    name: z.string(),
    id: z.string(),
    input: z.record(z.string(), z.unknown()),
    _meta: z.record(z.string(), z.unknown()).optional()
});

export const EmbeddedResourceSchema = z.object({
    type: z.literal('resource'),
    resource: z.union([TextResourceContentsSchema, BlobResourceContentsSchema]),
    annotations: AnnotationsSchema.optional(),
    _meta: z.record(z.string(), z.unknown()).optional()
});

export const ResourceLinkSchema = ResourceSchema.extend({
    type: z.literal('resource_link')
});

export const ContentBlockSchema = z.union([
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ResourceLinkSchema,
    EmbeddedResourceSchema
]);

export const PromptMessageSchema = z.object({
    role: RoleSchema,
    content: ContentBlockSchema
});

/* ─── Tool annotations / tool list-changed / sampling primitives ─── */

export const ToolAnnotationsSchema = z.object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional()
});

export const ToolListChangedNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/tools/list_changed'),
    params: NotificationsParamsSchema.optional()
});

export const ModelHintSchema = z.object({
    name: z.string().optional()
});

export const ModelPreferencesSchema = z.object({
    hints: z.array(ModelHintSchema).optional(),
    costPriority: z.number().min(0).max(1).optional(),
    speedPriority: z.number().min(0).max(1).optional(),
    intelligencePriority: z.number().min(0).max(1).optional()
});

export const ToolChoiceSchema = z.object({
    mode: z.enum(['auto', 'required', 'none']).optional()
});

/* ─── Elicitation primitive-schema vocabulary ─── */

export const BooleanSchemaSchema = z.object({
    type: z.literal('boolean'),
    title: z.string().optional(),
    description: z.string().optional(),
    default: z.boolean().optional()
});

export const StringSchemaSchema = z.object({
    type: z.literal('string'),
    title: z.string().optional(),
    description: z.string().optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    format: z.enum(['email', 'uri', 'date', 'date-time']).optional(),
    default: z.string().optional()
});

export const NumberSchemaSchema = z.object({
    type: z.enum(['number', 'integer']),
    title: z.string().optional(),
    description: z.string().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    default: z.number().optional()
});

export const UntitledSingleSelectEnumSchemaSchema = z.object({
    type: z.literal('string'),
    title: z.string().optional(),
    description: z.string().optional(),
    enum: z.array(z.string()),
    default: z.string().optional()
});

export const TitledSingleSelectEnumSchemaSchema = z.object({
    type: z.literal('string'),
    title: z.string().optional(),
    description: z.string().optional(),
    oneOf: z.array(
        z.object({
            const: z.string(),
            title: z.string()
        })
    ),
    default: z.string().optional()
});

export const LegacyTitledEnumSchemaSchema = z.object({
    type: z.literal('string'),
    title: z.string().optional(),
    description: z.string().optional(),
    enum: z.array(z.string()),
    enumNames: z.array(z.string()).optional(),
    default: z.string().optional()
});

export const SingleSelectEnumSchemaSchema = z.union([UntitledSingleSelectEnumSchemaSchema, TitledSingleSelectEnumSchemaSchema]);

export const UntitledMultiSelectEnumSchemaSchema = z.object({
    type: z.literal('array'),
    title: z.string().optional(),
    description: z.string().optional(),
    minItems: z.number().optional(),
    maxItems: z.number().optional(),
    items: z.object({
        type: z.literal('string'),
        enum: z.array(z.string())
    }),
    default: z.array(z.string()).optional()
});

export const TitledMultiSelectEnumSchemaSchema = z.object({
    type: z.literal('array'),
    title: z.string().optional(),
    description: z.string().optional(),
    minItems: z.number().optional(),
    maxItems: z.number().optional(),
    items: z.object({
        anyOf: z.array(
            z.object({
                const: z.string(),
                title: z.string()
            })
        )
    }),
    default: z.array(z.string()).optional()
});

export const MultiSelectEnumSchemaSchema = z.union([UntitledMultiSelectEnumSchemaSchema, TitledMultiSelectEnumSchemaSchema]);

export const EnumSchemaSchema = z.union([LegacyTitledEnumSchemaSchema, SingleSelectEnumSchemaSchema, MultiSelectEnumSchemaSchema]);

export const PrimitiveSchemaDefinitionSchema = z.union([EnumSchemaSchema, BooleanSchemaSchema, StringSchemaSchema, NumberSchemaSchema]);

export const ElicitRequestFormParamsSchema = TaskAugmentedRequestParamsSchema.extend({
    mode: z.literal('form').optional(),
    message: z.string(),
    requestedSchema: z
        .object({
            type: z.literal('object'),
            properties: z.record(z.string(), PrimitiveSchemaDefinitionSchema),
            required: z.array(z.string()).optional()
        })
        .catchall(z.unknown())
});

/* ─── Completion references / roots ─── */

export const ResourceTemplateReferenceSchema = z.object({
    type: z.literal('ref/resource'),
    uri: z.string()
});

export const PromptReferenceSchema = z.object({
    type: z.literal('ref/prompt'),
    name: z.string()
});

export const RootSchema = z.object({
    uri: z.string().startsWith('file://'),
    name: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).optional()
});

/* ════════════════════════════════════════════════════════════════════════════
 * End of frozen neutral-layer building blocks. Everything below is the
 * 2026-07-28 wire-specific vocabulary (envelope, forks, results, requests,
 * notifications) composed against the frozen copies above.
 * ════════════════════════════════════════════════════════════════════════════ */

/* 2026-era capability forks (defined ahead of the envelope, which composes
 * the client fork). The frozen shapes minus the deleted `tasks` key: `tasks`
 * is 2025-only vocabulary with no slot on this revision, consistent with the
 * encode-side deletion (Q1-SD3 iii).
 *
 * Both forks list their members EXPLICITLY (composing the frozen member
 * schemas by reference) rather than using `.omit()`: the envelope schema
 * below reaches the bundled package declarations, and an `.omit()` inference
 * is a mapped type whose printed member order is unstable across dts-rollup
 * builds (api-report flap). The explicit list doubles as the fork's deletion
 * statement — a member added to the frozen shape must be re-adjudicated here. */
const sharedClientCapabilityShape = ClientCapabilitiesSchema.shape;
export const ClientCapabilities2026Schema = z.object({
    experimental: sharedClientCapabilityShape.experimental,
    sampling: sharedClientCapabilityShape.sampling,
    elicitation: sharedClientCapabilityShape.elicitation,
    roots: sharedClientCapabilityShape.roots,
    extensions: sharedClientCapabilityShape.extensions
});
const sharedServerCapabilityShape = ServerCapabilitiesSchema.shape;
export const ServerCapabilities2026Schema = z.object({
    experimental: sharedServerCapabilityShape.experimental,
    logging: sharedServerCapabilityShape.logging,
    completions: sharedServerCapabilityShape.completions,
    prompts: sharedServerCapabilityShape.prompts,
    resources: sharedServerCapabilityShape.resources,
    tools: sharedServerCapabilityShape.tools,
    extensions: sharedServerCapabilityShape.extensions
});

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
 * Result side. `resultType` is a sender obligation (spec.types.2026-07-28
 * Result.resultType: "Servers implementing this protocol version MUST
 * include this field") and a receiver default (schema.ts:208 — clients MUST
 * treat absent `resultType` as 'complete'). These are the WIRE-TRUE
 * artifacts — the corpus and the parity suite parse them; `decodeResult`
 * parses with them and then LIFTS (drops resultType) to the neutral shape.
 * Sender-side requiredness is enforced by construction (`encodeResult`
 * stamps it), so the parse side carries the receiver default.
 * ------------------------------------------------------------------------ */

/** Open union per the anchor: 'complete' | 'input_required' | string. */
export const ResultTypeSchema = z.string();

const wireMeta = z.record(z.string(), z.unknown()).optional();

function wireResult<T extends z.core.$ZodLooseShape>(shape: T) {
    return z.looseObject({
        _meta: wireMeta,
        /** Sender MUST set; receiver defaults absent → 'complete' (spec receiver leniency). */
        resultType: ResultTypeSchema.default('complete'),
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
    // Receiver-side leniency per caching.mdx:56-58 — the probe classifier must
    // accept a DiscoverResult that omits OR malforms the cache hints (spec:
    // "if ttlMs is negative, clients SHOULD ignore it and treat it as 0").
    // `.catch()` returns the fallback for both absence and parse failure;
    // sender obligation is enforced by `encodeResult`, not by parse.
    // eslint-disable-next-line unicorn/prefer-top-level-await -- Zod `.catch()`, not a Promise
    ttlMs: z.number().int().min(0).catch(0),
    // eslint-disable-next-line unicorn/prefer-top-level-await -- Zod `.catch()`, not a Promise
    cacheScope: z.enum(['public', 'private']).catch('private'),
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

/** Anchor SubscriptionFilter (2026-only). */
export const SubscriptionFilterSchema = z.object({
    toolsListChanged: z.boolean().optional(),
    promptsListChanged: z.boolean().optional(),
    resourcesListChanged: z.boolean().optional(),
    resourceSubscriptions: z.array(z.string()).optional()
});
const subscriptionsListenParamsShape = { notifications: SubscriptionFilterSchema };
export const SubscriptionsListenRequestSchema = wireRequest('subscriptions/listen', subscriptionsListenParamsShape);

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
    | 'server/discover'
    | 'subscriptions/listen';

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
    'server/discover': dispatchRequest('server/discover', {}),
    'subscriptions/listen': dispatchRequest('subscriptions/listen', subscriptionsListenParamsShape)
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
        // eslint-disable-next-line unicorn/prefer-top-level-await -- Zod `.catch()`, not a Promise
        ttlMs: z.number().int().min(0).catch(0),
        // eslint-disable-next-line unicorn/prefer-top-level-await -- Zod `.catch()`, not a Promise
        cacheScope: z.enum(['public', 'private']).catch('private'),
        supportedVersions: z.array(z.string()),
        capabilities: ServerCapabilities2026Schema,
        serverInfo: ImplementationSchema,
        instructions: z.string().optional()
    }),
    // `subscriptions/listen` never receives a JSON-RPC result: termination is
    // stream close (HTTP) or `notifications/cancelled` (stdio). The empty
    // entry keeps the mapped type total; the codec's `decodeResult` would
    // never be called for this method in practice.
    'subscriptions/listen': liftedResult({})
};

/* ------------------------------------------------------------------------ *
 * Notifications. The 2026 notification set: cancelled, progress, message,
 * resources/updated, resources/list_changed, tools/list_changed,
 * prompts/list_changed. Deleted: initialized, roots/list_changed,
 * tasks/status, elicitation/complete (removed from the draft together with
 * URL-elicitation's elicitationId — both remain 2025-11-25 vocabulary only).
 * The shapes are revision-identical to the shared schemas, which are
 * composed by reference, EXCEPT cancelled (forks below: this revision
 * requires `requestId`) and the 2026-only subscriptions/acknowledged.
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

/** Anchor SubscriptionsAcknowledgedNotification (2026-only). */
export const SubscriptionsAcknowledgedNotificationSchema = z.object({
    method: z.literal('notifications/subscriptions/acknowledged'),
    params: z.object({
        _meta: NotificationMetaSchema.optional(),
        notifications: SubscriptionFilterSchema
    })
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
    | 'notifications/prompts/list_changed'
    | 'notifications/subscriptions/acknowledged';

export const notificationSchemas2026: { readonly [M in Rev2026NotificationMethod]: z.ZodType<{ method: M }> } = {
    'notifications/cancelled': CancelledNotificationSchema,
    'notifications/progress': ProgressNotificationSchema,
    'notifications/message': LoggingMessageNotificationSchema,
    'notifications/resources/updated': ResourceUpdatedNotificationSchema,
    'notifications/resources/list_changed': ResourceListChangedNotificationSchema,
    'notifications/tools/list_changed': ToolListChangedNotificationSchema,
    'notifications/prompts/list_changed': PromptListChangedNotificationSchema,
    'notifications/subscriptions/acknowledged': SubscriptionsAcknowledgedNotificationSchema
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
