import { z, ZodTypeAny } from "zod";

export const LATEST_PROTOCOL_VERSION = "2025-03-26";
export const SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  "2024-11-05",
  "2024-10-07",
];

/* JSON-RPC types */
export const JSONRPC_VERSION = "2.0";

export const ProgressTokenSchema = z.union([z.string(), z.number().int()]);

export const CursorSchema = z.string();

const RequestMetaSchema = z
  .object({
    progressToken: z.optional(ProgressTokenSchema),
  })
  .passthrough();

const BaseRequestParamsSchema = z
  .object({
    _meta: z.optional(RequestMetaSchema),
  })
  .passthrough();

export const RequestSchema = z.object({
  method: z.string(),
  params: z.optional(BaseRequestParamsSchema),
});

const BaseNotificationParamsSchema = z
  .object({
    _meta: z.optional(z.object({}).passthrough()),
  })
  .passthrough();

export const NotificationSchema = z.object({
  method: z.string(),
  params: z.optional(BaseNotificationParamsSchema),
});

export const ResultSchema = z
  .object({
    _meta: z.optional(z.object({}).passthrough()),
  })
  .passthrough();

export const RequestIdSchema = z.union([z.string(), z.number().int()]);

export const JSONRPCRequestSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: RequestIdSchema,
  })
  .merge(RequestSchema)
  .strict();

export const isJSONRPCRequest = (value: unknown): value is JSONRPCRequest =>
  JSONRPCRequestSchema.safeParse(value).success;

export const JSONRPCNotificationSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
  })
  .merge(NotificationSchema)
  .strict();

export const isJSONRPCNotification = (
  value: unknown
): value is JSONRPCNotification =>
  JSONRPCNotificationSchema.safeParse(value).success;

export const JSONRPCResponseSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: RequestIdSchema,
    result: ResultSchema,
  })
  .strict();

export const isJSONRPCResponse = (value: unknown): value is JSONRPCResponse =>
  JSONRPCResponseSchema.safeParse(value).success;

/**
 * Error codes defined by the JSON-RPC specification.
 */
export enum ErrorCode {
  // SDK error codes
  ConnectionClosed = -32000,
  RequestTimeout = -32001,

  // Standard JSON-RPC error codes
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
}

export const JSONRPCErrorSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: RequestIdSchema,
    error: z.object({
      code: z.number().int(),
      message: z.string(),
      data: z.optional(z.unknown()),
    }),
  })
  .strict();

export const isJSONRPCError = (value: unknown): value is JSONRPCError =>
  JSONRPCErrorSchema.safeParse(value).success;

export const JSONRPCMessageSchema = z.union([
  JSONRPCRequestSchema,
  JSONRPCNotificationSchema,
  JSONRPCResponseSchema,
  JSONRPCErrorSchema,
]);

/* Empty result */
export const EmptyResultSchema = ResultSchema.strict();

/* Cancellation */
export const CancelledNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/cancelled"),
  params: BaseNotificationParamsSchema.extend({
    requestId: RequestIdSchema,
    reason: z.string().optional(),
  }),
});

/* Initialization */
export const ImplementationSchema = z
  .object({
    name: z.string(),
    version: z.string(),
  })
  .passthrough();

export const ClientCapabilitiesSchema = z
  .object({
    experimental: z.optional(z.object({}).passthrough()),
    sampling: z.optional(z.object({}).passthrough()),
    roots: z.optional(
      z
        .object({
          listChanged: z.optional(z.boolean()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const InitializeRequestSchema = RequestSchema.extend({
  method: z.literal("initialize"),
  params: BaseRequestParamsSchema.extend({
    protocolVersion: z.string(),
    capabilities: ClientCapabilitiesSchema,
    clientInfo: ImplementationSchema,
  }),
});

export const isInitializeRequest = (value: unknown): value is InitializeRequest =>
  InitializeRequestSchema.safeParse(value).success;


export const ServerCapabilitiesSchema = z
  .object({
    experimental: z.optional(z.object({}).passthrough()),
    logging: z.optional(z.object({}).passthrough()),
    completions: z.optional(z.object({}).passthrough()),
    prompts: z.optional(
      z
        .object({
          listChanged: z.optional(z.boolean()),
        })
        .passthrough(),
    ),
    resources: z.optional(
      z
        .object({
          subscribe: z.optional(z.boolean()),
          listChanged: z.optional(z.boolean()),
        })
        .passthrough(),
    ),
    tools: z.optional(
      z
        .object({
          listChanged: z.optional(z.boolean()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const InitializeResultSchema = ResultSchema.extend({
  protocolVersion: z.string(),
  capabilities: ServerCapabilitiesSchema,
  serverInfo: ImplementationSchema,
  instructions: z.optional(z.string()),
});

export const InitializedNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/initialized"),
});

export const isInitializedNotification = (value: unknown): value is InitializedNotification =>
  InitializedNotificationSchema.safeParse(value).success;

/* Ping */
export const PingRequestSchema = RequestSchema.extend({
  method: z.literal("ping"),
});

/* Progress notifications */
export const ProgressSchema = z
  .object({
    progress: z.number(),
    total: z.optional(z.number()),
    message: z.optional(z.string()),
  })
  .passthrough();

export const ProgressNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/progress"),
  params: BaseNotificationParamsSchema.merge(ProgressSchema).extend({
    progressToken: ProgressTokenSchema,
  }),
});

/* Pagination */
export const PaginatedRequestSchema = RequestSchema.extend({
  params: BaseRequestParamsSchema.extend({
    cursor: z.optional(CursorSchema),
  }).optional(),
});

export const PaginatedResultSchema = ResultSchema.extend({
  nextCursor: z.optional(CursorSchema),
});

/* Resources */
export const ResourceContentsSchema = z
  .object({
    uri: z.string(),
    mimeType: z.optional(z.string()),
  })
  .passthrough();

export const TextResourceContentsSchema = ResourceContentsSchema.extend({
  text: z.string(),
});

export const BlobResourceContentsSchema = ResourceContentsSchema.extend({
  blob: z.string().base64(),
});

export const ResourceSchema = z
  .object({
    uri: z.string(),
    name: z.string(),
    description: z.optional(z.string()),
    mimeType: z.optional(z.string()),
  })
  .passthrough();

export const ResourceTemplateSchema = z
  .object({
    uriTemplate: z.string(),
    name: z.string(),
    description: z.optional(z.string()),
    mimeType: z.optional(z.string()),
  })
  .passthrough();

export const ListResourcesRequestSchema = PaginatedRequestSchema.extend({
  method: z.literal("resources/list"),
});

export const ListResourcesResultSchema = PaginatedResultSchema.extend({
  resources: z.array(ResourceSchema),
});

export const ListResourceTemplatesRequestSchema = PaginatedRequestSchema.extend(
  {
    method: z.literal("resources/templates/list"),
  },
);

export const ListResourceTemplatesResultSchema = PaginatedResultSchema.extend({
  resourceTemplates: z.array(ResourceTemplateSchema),
});

export const ReadResourceRequestSchema = RequestSchema.extend({
  method: z.literal("resources/read"),
  params: BaseRequestParamsSchema.extend({
    uri: z.string(),
  }),
});

export const ReadResourceResultSchema = ResultSchema.extend({
  contents: z.array(
    z.union([TextResourceContentsSchema, BlobResourceContentsSchema]),
  ),
});

export const ResourceListChangedNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/resources/list_changed"),
});

export const SubscribeRequestSchema = RequestSchema.extend({
  method: z.literal("resources/subscribe"),
  params: BaseRequestParamsSchema.extend({
    uri: z.string(),
  }),
});

export const UnsubscribeRequestSchema = RequestSchema.extend({
  method: z.literal("resources/unsubscribe"),
  params: BaseRequestParamsSchema.extend({
    uri: z.string(),
  }),
});

export const ResourceUpdatedNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/resources/updated"),
  params: BaseNotificationParamsSchema.extend({
    uri: z.string(),
  }),
});

/* Prompts */
export const PromptArgumentSchema = z
  .object({
    name: z.string(),
    description: z.optional(z.string()),
    required: z.optional(z.boolean()),
  })
  .passthrough();

export const PromptSchema = z
  .object({
    name: z.string(),
    description: z.optional(z.string()),
    arguments: z.optional(z.array(PromptArgumentSchema)),
  })
  .passthrough();

export const ListPromptsRequestSchema = PaginatedRequestSchema.extend({
  method: z.literal("prompts/list"),
});

export const ListPromptsResultSchema = PaginatedResultSchema.extend({
  prompts: z.array(PromptSchema),
});

export const GetPromptRequestSchema = RequestSchema.extend({
  method: z.literal("prompts/get"),
  params: BaseRequestParamsSchema.extend({
    name: z.string(),
    arguments: z.optional(z.record(z.string())),
  }),
});

export const TextContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .passthrough();

export const ImageContentSchema = z
  .object({
    type: z.literal("image"),
    data: z.string().base64(),
    mimeType: z.string(),
  })
  .passthrough();

export const AudioContentSchema = z
  .object({
    type: z.literal("audio"),
    data: z.string().base64(),
    mimeType: z.string(),
  })
  .passthrough();

export const EmbeddedResourceSchema = z
  .object({
    type: z.literal("resource"),
    resource: z.union([TextResourceContentsSchema, BlobResourceContentsSchema]),
  })
  .passthrough();

export const PromptMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.union([
      TextContentSchema,
      ImageContentSchema,
      AudioContentSchema,
      EmbeddedResourceSchema,
    ]),
  })
  .passthrough();

export const GetPromptResultSchema = ResultSchema.extend({
  description: z.optional(z.string()),
  messages: z.array(PromptMessageSchema),
});

export const PromptListChangedNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/prompts/list_changed"),
});

/* Tools */
export const ToolAnnotationsSchema = z
  .object({
    title: z.optional(z.string()),
    readOnlyHint: z.optional(z.boolean()),
    destructiveHint: z.optional(z.boolean()),
    idempotentHint: z.optional(z.boolean()),
    openWorldHint: z.optional(z.boolean()),
  })
  .passthrough();

export const ToolSchema = z
  .object({
    name: z.string(),
    description: z.optional(z.string()),
    inputSchema: z
      .object({
        type: z.literal("object"),
        properties: z.optional(z.object({}).passthrough()),
        required: z.optional(z.array(z.string())),
      })
      .passthrough(),
    outputSchema: z.optional(
      z.object({
        type: z.literal("object"),
        properties: z.optional(z.object({}).passthrough()),
        required: z.optional(z.array(z.string())),
      })
      .passthrough()
    ),
    annotations: z.optional(ToolAnnotationsSchema),
  })
  .passthrough();

export const ListToolsRequestSchema = PaginatedRequestSchema.extend({
  method: z.literal("tools/list"),
});

export const ListToolsResultSchema = PaginatedResultSchema.extend({
  tools: z.array(ToolSchema),
});

export const CallToolResultSchema = ResultSchema.extend({
  content: z.array(
    z.union([
      TextContentSchema,
      ImageContentSchema,
      AudioContentSchema,
      EmbeddedResourceSchema,
    ])).default([]),
  structuredContent: z.object({}).passthrough().optional(),
  isError: z.optional(z.boolean()),
});

/**
 * CallToolResultSchema extended with backwards compatibility to protocol version 2024-10-07.
 */
export const CompatibilityCallToolResultSchema = CallToolResultSchema.or(
  ResultSchema.extend({
    toolResult: z.unknown(),
  }),
);

export const CallToolRequestSchema = RequestSchema.extend({
  method: z.literal("tools/call"),
  params: BaseRequestParamsSchema.extend({
    name: z.string(),
    arguments: z.optional(z.record(z.unknown())),
  }),
});

export const ToolListChangedNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/tools/list_changed"),
});

/* Logging */
export const LoggingLevelSchema = z.enum([
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
]);

export const SetLevelRequestSchema = RequestSchema.extend({
  method: z.literal("logging/setLevel"),
  params: BaseRequestParamsSchema.extend({
    level: LoggingLevelSchema,
  }),
});

export const LoggingMessageNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/message"),
  params: BaseNotificationParamsSchema.extend({
    level: LoggingLevelSchema,
    logger: z.optional(z.string()),
    data: z.unknown(),
  }),
});

/* Sampling */
export const ModelHintSchema = z
  .object({
    name: z.string().optional(),
  })
  .passthrough();

export const ModelPreferencesSchema = z
  .object({
    hints: z.optional(z.array(ModelHintSchema)),
    costPriority: z.optional(z.number().min(0).max(1)),
    speedPriority: z.optional(z.number().min(0).max(1)),
    intelligencePriority: z.optional(z.number().min(0).max(1)),
  })
  .passthrough();

export const SamplingMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.union([TextContentSchema, ImageContentSchema, AudioContentSchema]),
  })
  .passthrough();

export const CreateMessageRequestSchema = RequestSchema.extend({
  method: z.literal("sampling/createMessage"),
  params: BaseRequestParamsSchema.extend({
    messages: z.array(SamplingMessageSchema),
    systemPrompt: z.optional(z.string()),
    includeContext: z.optional(z.enum(["none", "thisServer", "allServers"])),
    temperature: z.optional(z.number()),
    maxTokens: z.number().int(),
    stopSequences: z.optional(z.array(z.string())),
    metadata: z.optional(z.object({}).passthrough()),
    modelPreferences: z.optional(ModelPreferencesSchema),
  }),
});

export const CreateMessageResultSchema = ResultSchema.extend({
  model: z.string(),
  stopReason: z.optional(
    z.enum(["endTurn", "stopSequence", "maxTokens"]).or(z.string()),
  ),
  role: z.enum(["user", "assistant"]),
  content: z.discriminatedUnion("type", [
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema
  ]),
});

/* Autocomplete */
export const ResourceReferenceSchema = z
  .object({
    type: z.literal("ref/resource"),
    uri: z.string(),
  })
  .passthrough();

export const PromptReferenceSchema = z
  .object({
    type: z.literal("ref/prompt"),
    name: z.string(),
  })
  .passthrough();

export const CompleteRequestSchema = RequestSchema.extend({
  method: z.literal("completion/complete"),
  params: BaseRequestParamsSchema.extend({
    ref: z.union([PromptReferenceSchema, ResourceReferenceSchema]),
    argument: z
      .object({
        name: z.string(),
        value: z.string(),
      })
      .passthrough(),
  }),
});

export const CompleteResultSchema = ResultSchema.extend({
  completion: z
    .object({
      values: z.array(z.string()).max(100),
      total: z.optional(z.number().int()),
      hasMore: z.optional(z.boolean()),
    })
    .passthrough(),
});

/* Roots */
export const RootSchema = z
  .object({
    uri: z.string().startsWith("file://"),
    name: z.optional(z.string()),
  })
  .passthrough();

export const ListRootsRequestSchema = RequestSchema.extend({
  method: z.literal("roots/list"),
});

export const ListRootsResultSchema = ResultSchema.extend({
  roots: z.array(RootSchema),
});

export const RootsListChangedNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/roots/list_changed"),
});

/* Client messages */
export const ClientRequestSchema = z.union([
  PingRequestSchema,
  InitializeRequestSchema,
  CompleteRequestSchema,
  SetLevelRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  CallToolRequestSchema,
  ListToolsRequestSchema,
]);

export const ClientNotificationSchema = z.union([
  CancelledNotificationSchema,
  ProgressNotificationSchema,
  InitializedNotificationSchema,
  RootsListChangedNotificationSchema,
]);

export const ClientResultSchema = z.union([
  EmptyResultSchema,
  CreateMessageResultSchema,
  ListRootsResultSchema,
]);

/* Server messages */
export const ServerRequestSchema = z.union([
  PingRequestSchema,
  CreateMessageRequestSchema,
  ListRootsRequestSchema,
]);

export const ServerNotificationSchema = z.union([
  CancelledNotificationSchema,
  ProgressNotificationSchema,
  LoggingMessageNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
]);

export const ServerResultSchema = z.union([
  EmptyResultSchema,
  InitializeResultSchema,
  CompleteResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ReadResourceResultSchema,
  CallToolResultSchema,
  ListToolsResultSchema,
]);

export class McpError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(`MCP error ${code}: ${message}`);
    this.name = "McpError";
  }
}

type Primitive = string | number | boolean | bigint | null | undefined;
type Flatten<T> = T extends Primitive
  ? T
  : T extends Array<infer U>
  ? Array<Flatten<U>>
  : T extends Set<infer U>
  ? Set<Flatten<U>>
  : T extends Map<infer K, infer V>
  ? Map<Flatten<K>, Flatten<V>>
  : T extends object
  ? { [K in keyof T]: Flatten<T[K]> }
  : T;

type Infer<Schema extends ZodTypeAny> = Flatten<z.infer<Schema>>;
type Assert<T, V extends T> = V;

/* JSON-RPC types */
/**
 * A progress token, used to associate progress notifications with the original request.
 */
export type ProgressToken = string | number;
type _AssertProgressTokenMatches = Assert<ProgressToken, Infer<typeof ProgressTokenSchema>> & Assert<Infer<typeof ProgressTokenSchema>, ProgressToken>;

/**
 * An opaque token used to represent a cursor for pagination.
 */
export type Cursor = string;
type _AssertCursorMatches = Assert<Cursor, Infer<typeof CursorSchema>> & Assert<Infer<typeof CursorSchema>, Cursor>;

export interface Request {
  method: string;
  params?: {
    _meta?: {
      progressToken?: ProgressToken;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}
type _AssertRequestMatches = Assert<Request, Infer<typeof RequestSchema>> & Assert<Infer<typeof RequestSchema>, Request>;

export interface RequestMeta {
  /**
   * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
   */
  progressToken?: ProgressToken;
  [key: string]: unknown;
}
type _AssertRequestMetaMatches = Assert<RequestMeta, Infer<typeof RequestMetaSchema>> & Assert<Infer<typeof RequestMetaSchema>, RequestMeta>;

export interface Notification {
  method: string;
  params?: {
    /**
     * This parameter name is reserved by MCP to allow clients and servers to attach additional metadata to their notifications.
     */
    _meta?: { [key: string]: unknown };
    [key: string]: unknown;
  };
}
type _AssertNotificationMatches = Assert<Notification, Infer<typeof NotificationSchema>> & Assert<Infer<typeof NotificationSchema>, Notification>;

export interface Result {
  /**
   * This result property is reserved by the protocol to allow clients and servers to attach additional metadata to their responses.
   */
  _meta?: { [key: string]: unknown };
  [key: string]: unknown;
}
type _AssertResultMatches = Assert<Result, Infer<typeof ResultSchema>> & Assert<Infer<typeof ResultSchema>, Result>;

/**
 * A uniquely identifying ID for a request in JSON-RPC.
 */
export type RequestId = string | number;
type _AssertRequestIdMatches = Assert<RequestId, Infer<typeof RequestIdSchema>> & Assert<Infer<typeof RequestIdSchema>, RequestId>;

/**
 * A request that expects a response.
 */
export interface JSONRPCRequest extends Request {
  jsonrpc: "2.0";
  id: RequestId;
}
type _AssertJSONRPCRequestMatches = Assert<JSONRPCRequest, Infer<typeof JSONRPCRequestSchema>> & Assert<Infer<typeof JSONRPCRequestSchema>, JSONRPCRequest>;

/**
 * A notification which does not expect a response.
 */
export interface JSONRPCNotification extends Notification {
  jsonrpc: "2.0";
}
type _AssertJSONRPCNotificationMatches = Assert<JSONRPCNotification, Infer<typeof JSONRPCNotificationSchema>> & Assert<Infer<typeof JSONRPCNotificationSchema>, JSONRPCNotification>;

/**
 * A successful (non-error) response to a request.
 */
export interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: RequestId;
  result: Result;
}
type _AssertJSONRPCResponseMatches = Assert<JSONRPCResponse, Infer<typeof JSONRPCResponseSchema>> & Assert<Infer<typeof JSONRPCResponseSchema>, JSONRPCResponse>;

/**
 * A response to a request that indicates an error occurred.
 */
export interface JSONRPCError {
  jsonrpc: "2.0";
  id: RequestId;
  error: {
    /**
     * The error type that occurred.
     */
    code: number;
    /**
     * A short description of the error. The message SHOULD be limited to a concise single sentence.
     */
    message: string;
    /**
     * Additional information about the error. The value of this member is defined by the sender (e.g. detailed error information, nested errors etc.).
     */
    data?: unknown;
  };
}
type _AssertJSONRPCErrorMatches = Assert<JSONRPCError, Infer<typeof JSONRPCErrorSchema>> & Assert<Infer<typeof JSONRPCErrorSchema>, JSONRPCError>;

export type JSONRPCMessage = JSONRPCRequest | JSONRPCNotification | JSONRPCResponse | JSONRPCError;
type _AssertJSONRPCMessageMatches = Assert<JSONRPCMessage, Infer<typeof JSONRPCMessageSchema>> & Assert<Infer<typeof JSONRPCMessageSchema>, JSONRPCMessage>;

/* Empty result */
/**
 * A response that indicates success but carries no data.
 */
export type EmptyResult = Result
type _AssertEmptyResultMatches = Assert<EmptyResult, Infer<typeof EmptyResultSchema>> & Assert<Infer<typeof EmptyResultSchema>, EmptyResult>;

/* Cancellation */
/**
 * This notification can be sent by either side to indicate that it is cancelling a previously-issued request.
 *
 * The request SHOULD still be in-flight, but due to communication latency, it is always possible that this notification MAY arrive after the request has already finished.
 *
 * This notification indicates that the result will be unused, so any associated processing SHOULD cease.
 *
 * A client MUST NOT attempt to cancel its `initialize` request.
 */
export interface CancelledNotification extends Notification {
  method: "notifications/cancelled";
  params: {
    _meta?: { [key: string]: unknown };
    /**
     * The ID of the request to cancel.
     *
     * This MUST correspond to the ID of a request previously issued in the same direction.
     */
    requestId: RequestId;
    /**
     * An optional string describing the reason for the cancellation. This MAY be logged or presented to the user.
     */
    reason?: string;
    [key: string]: unknown;
  };
}
type _AssertCancelledNotificationMatches = Assert<CancelledNotification, Infer<typeof CancelledNotificationSchema>> & Assert<Infer<typeof CancelledNotificationSchema>, CancelledNotification>;

/* Initialization */
/**
 * Describes the name and version of an MCP implementation.
 */
export interface Implementation {
  name: string;
  version: string;
  [key: string]: unknown;
}
type _AssertImplementationMatches = Assert<Implementation, Infer<typeof ImplementationSchema>> & Assert<Infer<typeof ImplementationSchema>, Implementation>;

/**
 * Capabilities a client may support. Known capabilities are defined here, in this schema, but this is not a closed set: any client can define its own, additional capabilities.
 */
export interface ClientCapabilities {
  /**
   * Experimental, non-standard capabilities that the client supports.
   */
  experimental?: { [key: string]: unknown };
  /**
   * Present if the client supports sampling from an LLM.
   */
  sampling?: { [key: string]: unknown };
  /**
   * Present if the client supports listing roots.
   */
  roots?: {
    /**
     * Whether the client supports issuing notifications for changes to the roots list.
     */
    listChanged?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
type _AssertClientCapabilitiesMatches = Assert<ClientCapabilities, Infer<typeof ClientCapabilitiesSchema>> & Assert<Infer<typeof ClientCapabilitiesSchema>, ClientCapabilities>;

/**
 * This request is sent from the client to the server when it first connects, asking it to begin initialization.
 */
export interface InitializeRequest extends Request {
  method: "initialize";
  params: {
    _meta?: RequestMeta;
    /**
     * The latest version of the Model Context Protocol that the client supports. The client MAY decide to support older versions as well.
     */
    protocolVersion: string;
    capabilities: ClientCapabilities;
    clientInfo: Implementation;
    [key: string]: unknown;
  };
}
type _AssertInitializeRequestMatches = Assert<InitializeRequest, Infer<typeof InitializeRequestSchema>> & Assert<Infer<typeof InitializeRequestSchema>, InitializeRequest>;

/**
 * Capabilities that a server may support. Known capabilities are defined here, in this schema, but this is not a closed set: any server can define its own, additional capabilities.
 */
export interface ServerCapabilities {
  /**
   * Experimental, non-standard capabilities that the server supports.
   */
  experimental?: { [key: string]: unknown };
  /**
   * Present if the server supports sending log messages to the client.
   */
  logging?: { [key: string]: unknown };
  /**
   * Present if the server supports sending completions to the client.
   */
  completions?: { [key: string]: unknown };
  /**
   * Present if the server offers any prompt templates.
   */
  prompts?: {
    /**
     * Whether this server supports issuing notifications for changes to the prompt list.
     */
    listChanged?: boolean;
    [key: string]: unknown;
  };
  /**
   * Present if the server offers any resources to read.
   */
  resources?: {
    /**
     * Whether this server supports clients subscribing to resource updates.
     */
    subscribe?: boolean;
    /**
     * Whether this server supports issuing notifications for changes to the resource list.
     */
    listChanged?: boolean;
    [key: string]: unknown;
  };
  /**
   * Present if the server offers any tools to call.
   */
  tools?: {
    /**
     * Whether this server supports issuing notifications for changes to the tool list.
     */
    listChanged?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
type _AssertServerCapabilitiesMatches = Assert<ServerCapabilities, Infer<typeof ServerCapabilitiesSchema>> & Assert<Infer<typeof ServerCapabilitiesSchema>, ServerCapabilities>;

/**
 * After receiving an initialize request from the client, the server sends this response.
 */
export interface InitializeResult extends Result {
  /**
   * The version of the Model Context Protocol that the server wants to use. This may not match the version that the client requested. If the client cannot support this version, it MUST disconnect.
   */
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: Implementation;
  /**
   * Instructions describing how to use the server and its features.
   *
   * This can be used by clients to improve the LLM's understanding of available tools, resources, etc. It can be thought of like a "hint" to the model. For example, this information MAY be added to the system prompt.
   */
  instructions?: string;
}
type _AssertInitializeResultMatches = Assert<InitializeResult, Infer<typeof InitializeResultSchema>> & Assert<Infer<typeof InitializeResultSchema>, InitializeResult>;

/**
 * This notification is sent from the client to the server after initialization has finished.
 */
export interface InitializedNotification extends Notification {
  method: "notifications/initialized";
}
type _AssertInitializedNotificationMatches = Assert<InitializedNotification, Infer<typeof InitializedNotificationSchema>> & Assert<Infer<typeof InitializedNotificationSchema>, InitializedNotification>;

/* Ping */
/**
 * A ping, issued by either the server or the client, to check that the other party is still alive. The receiver must promptly respond, or else may be disconnected.
 */
export interface PingRequest extends Request {
  method: "ping";
}
type _AssertPingRequestMatches = Assert<PingRequest, Infer<typeof PingRequestSchema>> & Assert<Infer<typeof PingRequestSchema>, PingRequest>;

/* Progress notifications */
export interface Progress {
  /**
   * The progress thus far. This should increase every time progress is made, even if the total is unknown.
   */
  progress: number;
  /**
   * Total number of items to process (or total progress required), if known.
   */
  total?: number;
  /**
   * An optional message describing the current progress.
   */
  message?: string;
  [key: string]: unknown;
}
type _AssertProgressMatches = Assert<Progress, Infer<typeof ProgressSchema>> & Assert<Infer<typeof ProgressSchema>, Progress>;

/**
 * An out-of-band notification used to inform the receiver of a progress update for a long-running request.
 */
export interface ProgressNotification extends Notification {
  method: "notifications/progress";
  params: Progress & {
    _meta?: { [key: string]: unknown };
    /**
     * The progress token which was given in the initial request, used to associate this notification with the request that is proceeding.
     */
    progressToken: ProgressToken;
    [key: string]: unknown;
  };
}
type _AssertProgressNotificationMatches = Assert<ProgressNotification, Infer<typeof ProgressNotificationSchema>> & Assert<Infer<typeof ProgressNotificationSchema>, ProgressNotification>;

/* Pagination */
export interface PaginatedRequest extends Request {
  params?: {
    _meta?: RequestMeta;
    /**
     * An opaque token representing the current pagination position.
     * If provided, the server should return results starting after this cursor.
     */
    cursor?: Cursor;
    [key: string]: unknown;
  };
}
type _AssertPaginatedRequestMatches = Assert<PaginatedRequest, Infer<typeof PaginatedRequestSchema>> & Assert<Infer<typeof PaginatedRequestSchema>, PaginatedRequest>;

export interface PaginatedResult extends Result {
  /**
   * An opaque token representing the pagination position after the last returned result.
   * If present, there may be more results available.
   */
  nextCursor?: Cursor;
}
type _AssertPaginatedResultMatches = Assert<PaginatedResult, Infer<typeof PaginatedResultSchema>> & Assert<Infer<typeof PaginatedResultSchema>, PaginatedResult>;

/* Resources */
/**
 * The contents of a specific resource or sub-resource.
 */
export interface ResourceContents {
  /**
   * The URI of this resource.
   */
  uri: string;
  /**
   * The MIME type of this resource, if known.
   */
  mimeType?: string;
  [key: string]: unknown;
}
type _AssertResourceContentsMatches = Assert<ResourceContents, Infer<typeof ResourceContentsSchema>> & Assert<Infer<typeof ResourceContentsSchema>, ResourceContents>;

export interface TextResourceContents extends ResourceContents {
  /**
   * The text of the item. This must only be set if the item can actually be represented as text (not binary data).
   */
  text: string;
}
type _AssertTextResourceContentsMatches = Assert<TextResourceContents, Infer<typeof TextResourceContentsSchema>> & Assert<Infer<typeof TextResourceContentsSchema>, TextResourceContents>;

export interface BlobResourceContents extends ResourceContents {
  /**
   * A base64-encoded string representing the binary data of the item.
   */
  blob: string;
}
type _AssertBlobResourceContentsMatches = Assert<BlobResourceContents, Infer<typeof BlobResourceContentsSchema>> & Assert<Infer<typeof BlobResourceContentsSchema>, BlobResourceContents>;

/**
 * A known resource that the server is capable of reading.
 */
export interface Resource {
  /**
   * The URI of this resource.
   */
  uri: string;
  /**
   * A human-readable name for this resource.
   *
   * This can be used by clients to populate UI elements.
   */
  name: string;
  /**
   * A description of what this resource represents.
   *
   * This can be used by clients to improve the LLM's understanding of available resources. It can be thought of like a "hint" to the model.
   */
  description?: string;
  /**
   * The MIME type of this resource, if known.
   */
  mimeType?: string;
  [key: string]: unknown;
}
type _AssertResourceMatches = Assert<Resource, Infer<typeof ResourceSchema>> & Assert<Infer<typeof ResourceSchema>, Resource>;

/**
 * A template description for resources available on the server.
 */
export interface ResourceTemplate {
  /**
   * A URI template (according to RFC 6570) that can be used to construct resource URIs.
   */
  uriTemplate: string;
  /**
   * A human-readable name for the type of resource this template refers to.
   *
   * This can be used by clients to populate UI elements.
   */
  name: string;
  /**
   * A description of what this template is for.
   *
   * This can be used by clients to improve the LLM's understanding of available resources. It can be thought of like a "hint" to the model.
   */
  description?: string;
  /**
   * The MIME type for all resources that match this template. This should only be included if all resources matching this template have the same type.
   */
  mimeType?: string;
  [key: string]: unknown;
}
type _AssertResourceTemplateMatches = Assert<ResourceTemplate, Infer<typeof ResourceTemplateSchema>> & Assert<Infer<typeof ResourceTemplateSchema>, ResourceTemplate>;

/**
 * Sent from the client to request a list of resources the server has.
 */
export interface ListResourcesRequest extends PaginatedRequest {
  method: "resources/list";
}
type _AssertListResourcesRequestMatches = Assert<ListResourcesRequest, Infer<typeof ListResourcesRequestSchema>> & Assert<Infer<typeof ListResourcesRequestSchema>, ListResourcesRequest>;

/**
 * The server's response to a resources/list request from the client.
 */
export interface ListResourcesResult extends PaginatedResult {
  resources: Resource[];
}
type _AssertListResourcesResultMatches = Assert<ListResourcesResult, Infer<typeof ListResourcesResultSchema>> & Assert<Infer<typeof ListResourcesResultSchema>, ListResourcesResult>;

/**
 * Sent from the client to request a list of resource templates the server has.
 */
export interface ListResourceTemplatesRequest extends PaginatedRequest {
  method: "resources/templates/list";
}
type _AssertListResourceTemplatesRequestMatches = Assert<ListResourceTemplatesRequest, Infer<typeof ListResourceTemplatesRequestSchema>> & Assert<Infer<typeof ListResourceTemplatesRequestSchema>, ListResourceTemplatesRequest>;

/**
 * The server's response to a resources/templates/list request from the client.
 */
export interface ListResourceTemplatesResult extends PaginatedResult {
  resourceTemplates: ResourceTemplate[];
}
type _AssertListResourceTemplatesResultMatches = Assert<ListResourceTemplatesResult, Infer<typeof ListResourceTemplatesResultSchema>> & Assert<Infer<typeof ListResourceTemplatesResultSchema>, ListResourceTemplatesResult>;

/**
 * Sent from the client to the server, to read a specific resource URI.
 */
export interface ReadResourceRequest extends Request {
  method: "resources/read";
  params: {
    _meta?: RequestMeta;
    /**
     * The URI of the resource to read. The URI can use any protocol; it is up to the server how to interpret it.
     */
    uri: string;
    [key: string]: unknown;
  };
}
type _AssertReadResourceRequestMatches = Assert<ReadResourceRequest, Infer<typeof ReadResourceRequestSchema>> & Assert<Infer<typeof ReadResourceRequestSchema>, ReadResourceRequest>;

/**
 * The server's response to a resources/read request from the client.
 */
export interface ReadResourceResult extends Result {
  contents: (TextResourceContents | BlobResourceContents)[];
}
type _AssertReadResourceResultMatches = Assert<ReadResourceResult, Infer<typeof ReadResourceResultSchema>> & Assert<Infer<typeof ReadResourceResultSchema>, ReadResourceResult>;

/**
 * An optional notification from the server to the client, informing it that the list of resources it can read from has changed. This may be issued by servers without any previous subscription from the client.
 */
export interface ResourceListChangedNotification extends Notification {
  method: "notifications/resources/list_changed";
}
type _AssertResourceListChangedNotificationMatches = Assert<ResourceListChangedNotification, Infer<typeof ResourceListChangedNotificationSchema>> & Assert<Infer<typeof ResourceListChangedNotificationSchema>, ResourceListChangedNotification>;

/**
 * Sent from the client to request resources/updated notifications from the server whenever a particular resource changes.
 */
export interface SubscribeRequest extends Request {
  method: "resources/subscribe";
  params: {
    _meta?: RequestMeta;
    /**
     * The URI of the resource to subscribe to. The URI can use any protocol; it is up to the server how to interpret it.
     */
    uri: string;
    [key: string]: unknown;
  };
}
type _AssertSubscribeRequestMatches = Assert<SubscribeRequest, Infer<typeof SubscribeRequestSchema>> & Assert<Infer<typeof SubscribeRequestSchema>, SubscribeRequest>;

/**
 * Sent from the client to request cancellation of resources/updated notifications from the server. This should follow a previous resources/subscribe request.
 */
export interface UnsubscribeRequest extends Request {
  method: "resources/unsubscribe";
  params: {
    _meta?: RequestMeta;
    /**
     * The URI of the resource to unsubscribe from.
     */
    uri: string;
    [key: string]: unknown;
  };
}
type _AssertUnsubscribeRequestMatches = Assert<UnsubscribeRequest, Infer<typeof UnsubscribeRequestSchema>> & Assert<Infer<typeof UnsubscribeRequestSchema>, UnsubscribeRequest>;

/**
 * A notification from the server to the client, informing it that a resource has changed and may need to be read again. This should only be sent if the client previously sent a resources/subscribe request.
 */
export interface ResourceUpdatedNotification extends Notification {
  method: "notifications/resources/updated";
  params: {
    _meta?: { [key: string]: unknown };
    /**
     * The URI of the resource that has been updated. This might be a sub-resource of the one that the client actually subscribed to.
     */
    uri: string;
    [key: string]: unknown;
  };
}
type _AssertResourceUpdatedNotificationMatches = Assert<ResourceUpdatedNotification, Infer<typeof ResourceUpdatedNotificationSchema>> & Assert<Infer<typeof ResourceUpdatedNotificationSchema>, ResourceUpdatedNotification>;

/* Prompts */
/**
 * Describes an argument that a prompt can accept.
 */
export interface PromptArgument {
  /**
   * The name of the argument.
   */
  name: string;
  /**
   * A human-readable description of the argument.
   */
  description?: string;
  /**
   * Whether this argument must be provided.
   */
  required?: boolean;
  [key: string]: unknown;
}
type _AssertPromptArgumentMatches = Assert<PromptArgument, Infer<typeof PromptArgumentSchema>> & Assert<Infer<typeof PromptArgumentSchema>, PromptArgument>;

/**
 * A prompt or prompt template that the server offers.
 */
export interface Prompt {
  /**
   * The name of the prompt or prompt template.
   */
  name: string;
  /**
   * An optional description of what this prompt provides
   */
  description?: string;
  /**
   * A list of arguments to use for templating the prompt.
   */
  arguments?: PromptArgument[];
  [key: string]: unknown;
}
type _AssertPromptMatches = Assert<Prompt, Infer<typeof PromptSchema>> & Assert<Infer<typeof PromptSchema>, Prompt>;

/**
 * Sent from the client to request a list of prompts and prompt templates the server has.
 */
export interface ListPromptsRequest extends PaginatedRequest {
  method: "prompts/list";
}
type _AssertListPromptsRequestMatches = Assert<ListPromptsRequest, Infer<typeof ListPromptsRequestSchema>> & Assert<Infer<typeof ListPromptsRequestSchema>, ListPromptsRequest>;

/**
 * The server's response to a prompts/list request from the client.
 */
export interface ListPromptsResult extends PaginatedResult {
  prompts: Prompt[];
}
type _AssertListPromptsResultMatches = Assert<ListPromptsResult, Infer<typeof ListPromptsResultSchema>> & Assert<Infer<typeof ListPromptsResultSchema>, ListPromptsResult>;

/**
 * Used by the client to get a prompt provided by the server.
 */
export interface GetPromptRequest extends Request {
  method: "prompts/get";
  params: {
    _meta?: RequestMeta;
    /**
     * The name of the prompt or prompt template.
     */
    name: string;
    /**
     * Arguments to use for templating the prompt.
     */
    arguments?: Record<string, string>;
    [key: string]: unknown;
  };
}
type _AssertGetPromptRequestMatches = Assert<GetPromptRequest, Infer<typeof GetPromptRequestSchema>> & Assert<Infer<typeof GetPromptRequestSchema>, GetPromptRequest>;

/**
 * Text provided to or from an LLM.
 */
export interface TextContent {
  type: "text";
  /**
   * The text content of the message.
   */
  text: string;
  [key: string]: unknown;
}
type _AssertTextContentMatches = Assert<TextContent, Infer<typeof TextContentSchema>> & Assert<Infer<typeof TextContentSchema>, TextContent>;

/**
 * An image provided to or from an LLM.
 */
export interface ImageContent {
  type: "image";
  /**
   * The base64-encoded image data.
   */
  data: string;
  /**
   * The MIME type of the image. Different providers may support different image types.
   */
  mimeType: string;
  [key: string]: unknown;
}
type _AssertImageContentMatches = Assert<ImageContent, Infer<typeof ImageContentSchema>> & Assert<Infer<typeof ImageContentSchema>, ImageContent>;

/**
 * An Audio provided to or from an LLM.
 */
export interface AudioContent {
  type: "audio";
  /**
   * The base64-encoded audio data.
   */
  data: string;
  /**
   * The MIME type of the audio. Different providers may support different audio types.
   */
  mimeType: string;
  [key: string]: unknown;
}
type _AssertAudioContentMatches = Assert<AudioContent, Infer<typeof AudioContentSchema>> & Assert<Infer<typeof AudioContentSchema>, AudioContent>;

/**
 * The contents of a resource, embedded into a prompt or tool call result.
 */
export interface EmbeddedResource {
  type: "resource";
  resource: TextResourceContents | BlobResourceContents;
  [key: string]: unknown;
}
type _AssertEmbeddedResourceMatches = Assert<EmbeddedResource, Infer<typeof EmbeddedResourceSchema>> & Assert<Infer<typeof EmbeddedResourceSchema>, EmbeddedResource>;

/**
 * Describes a message returned as part of a prompt.
 */
export interface PromptMessage {
  role: "user" | "assistant";
  content: TextContent | ImageContent | AudioContent | EmbeddedResource;
  [key: string]: unknown;
}
type _AssertPromptMessageMatches = Assert<PromptMessage, Infer<typeof PromptMessageSchema>> & Assert<Infer<typeof PromptMessageSchema>, PromptMessage>;

/**
 * The server's response to a prompts/get request from the client.
 */
export interface GetPromptResult extends Result {
  /**
   * An optional description for the prompt.
   */
  description?: string;
  messages: PromptMessage[];
}
type _AssertGetPromptResultMatches = Assert<GetPromptResult, Infer<typeof GetPromptResultSchema>> & Assert<Infer<typeof GetPromptResultSchema>, GetPromptResult>;

/**
 * An optional notification from the server to the client, informing it that the list of prompts it offers has changed. This may be issued by servers without any previous subscription from the client.
 */
export interface PromptListChangedNotification extends Notification {
  method: "notifications/prompts/list_changed";
}
type _AssertPromptListChangedNotificationMatches = Assert<PromptListChangedNotification, Infer<typeof PromptListChangedNotificationSchema>> & Assert<Infer<typeof PromptListChangedNotificationSchema>, PromptListChangedNotification>;

/* Tools */
/**
 * Additional properties describing a Tool to clients.
 *
 * NOTE: all properties in ToolAnnotations are **hints**.
 * They are not guaranteed to provide a faithful description of
 * tool behavior (including descriptive properties like `title`).
 *
 * Clients should never make tool use decisions based on ToolAnnotations
 * received from untrusted servers.
 */
export interface ToolAnnotations {
  /**
   * A human-readable title for the tool.
   */
  title?: string;
  /**
   * If true, the tool does not modify its environment.
   *
   * Default: false
   */
  readOnlyHint?: boolean;
  /**
   * If true, the tool may perform destructive updates to its environment.
   * If false, the tool performs only additive updates.
   *
   * (This property is meaningful only when `readOnlyHint == false`)
   *
   * Default: true
   */
  destructiveHint?: boolean;
  /**
   * If true, calling the tool repeatedly with the same arguments
   * will have no additional effect on the its environment.
   *
   * (This property is meaningful only when `readOnlyHint == false`)
   *
   * Default: false
   */
  idempotentHint?: boolean;
  /**
   * If true, this tool may interact with an "open world" of external
   * entities. If false, the tool's domain of interaction is closed.
   * For example, the world of a web search tool is open, whereas that
   * of a memory tool is not.
   *
   * Default: true
   */
  openWorldHint?: boolean;
  [key: string]: unknown;
}
type _AssertToolAnnotationsMatches = Assert<ToolAnnotations, Infer<typeof ToolAnnotationsSchema>> & Assert<Infer<typeof ToolAnnotationsSchema>, ToolAnnotations>;

/**
 * Definition for a tool the client can call.
 */
export interface Tool {
  /**
   * The name of the tool.
   */
  name: string;
  /**
   * A human-readable description of the tool.
   */
  description?: string;
  /**
   * A JSON Schema object defining the expected parameters for the tool.
   */
  inputSchema: {
    type: "object";
    properties?: { [key: string]: unknown };
    required?: string[];
    [key: string]: unknown;
  };
  /**
   * An optional JSON Schema object defining the structure of the tool's output returned in 
   * the structuredContent field of a CallToolResult.
   */
  outputSchema?: {
    type: "object";
    properties?: { [key: string]: unknown };
    required?: string[];
    [key: string]: unknown;
  };
  /**
   * Optional additional tool information.
   */
  annotations?: ToolAnnotations;
  [key: string]: unknown;
}
type _AssertToolMatches = Assert<Tool, Infer<typeof ToolSchema>> & Assert<Infer<typeof ToolSchema>, Tool>;

/**
 * Sent from the client to request a list of tools the server has.
 */
export interface ListToolsRequest extends PaginatedRequest {
  method: "tools/list";
}
type _AssertListToolsRequestMatches = Assert<ListToolsRequest, Infer<typeof ListToolsRequestSchema>> & Assert<Infer<typeof ListToolsRequestSchema>, ListToolsRequest>;

/**
 * The server's response to a tools/list request from the client.
 */
export interface ListToolsResult extends PaginatedResult {
  tools: Tool[];
}
type _AssertListToolsResultMatches = Assert<ListToolsResult, Infer<typeof ListToolsResultSchema>> & Assert<Infer<typeof ListToolsResultSchema>, ListToolsResult>;

/**
 * The server's response to a tool call.
 */
export interface CallToolResult extends Result {
  /**
   * A list of content objects that represent the result of the tool call.
   *
   * If the Tool does not define an outputSchema, this field MUST be present in the result.
   * For backwards compatibility, this field is always present, but it may be empty.
   */
  content: (TextContent | ImageContent | AudioContent | EmbeddedResource)[];
  /**
   * An object containing structured tool output.
   *
   * If the Tool defines an outputSchema, this field MUST be present in the result, and contain a JSON object that matches the schema.
   */
  structuredContent?: { [key: string]: unknown };
  /**
   * Whether the tool call ended in an error.
   *
   * If not set, this is assumed to be false (the call was successful).
   *
   * Any errors that originate from the tool SHOULD be reported inside the result
   * object, with `isError` set to true, _not_ as an MCP protocol-level error
   * response. Otherwise, the LLM would not be able to see that an error occurred
   * and self-correct.
   *
   * However, any errors in _finding_ the tool, an error indicating that the
   * server does not support tool calls, or any other exceptional conditions,
   * should be reported as an MCP error response.
   */
  isError?: boolean;
}
type _AssertCallToolResultMatches = Assert<CallToolResult, Infer<typeof CallToolResultSchema>> & Assert<Infer<typeof CallToolResultSchema>, CallToolResult>;

export type CompatibilityCallToolResult = CallToolResult | (Result & { toolResult?: unknown });
type _AssertCompatibilityCallToolResultMatches = Assert<CompatibilityCallToolResult, Infer<typeof CompatibilityCallToolResultSchema>> & Assert<Infer<typeof CompatibilityCallToolResultSchema>, CompatibilityCallToolResult>;

/**
 * Used by the client to invoke a tool provided by the server.
 */
export interface CallToolRequest extends Request {
  method: "tools/call";
  params: {
    _meta?: RequestMeta;
    name: string;
    arguments?: Record<string, unknown>;
    [key: string]: unknown;
  };
}
type _AssertCallToolRequestMatches = Assert<CallToolRequest, Infer<typeof CallToolRequestSchema>> & Assert<Infer<typeof CallToolRequestSchema>, CallToolRequest>;

/**
 * An optional notification from the server to the client, informing it that the list of tools it offers has changed. This may be issued by servers without any previous subscription from the client.
 */
export interface ToolListChangedNotification extends Notification {
  method: "notifications/tools/list_changed";
}
type _AssertToolListChangedNotificationMatches = Assert<ToolListChangedNotification, Infer<typeof ToolListChangedNotificationSchema>> & Assert<Infer<typeof ToolListChangedNotificationSchema>, ToolListChangedNotification>;

/* Logging */
/**
 * The severity of a log message.
 */
export type LoggingLevel = "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";
type _AssertLoggingLevelMatches = Assert<LoggingLevel, Infer<typeof LoggingLevelSchema>> & Assert<Infer<typeof LoggingLevelSchema>, LoggingLevel>;

/**
 * A request from the client to the server, to enable or adjust logging.
 */
export interface SetLevelRequest extends Request {
  method: "logging/setLevel";
  params: {
    _meta?: RequestMeta;
    /**
     * The level of logging that the client wants to receive from the server. The server should send all logs at this level and higher (i.e., more severe) to the client as notifications/logging/message.
     */
    level: LoggingLevel;
    [key: string]: unknown;
  };
}
type _AssertSetLevelRequestMatches = Assert<SetLevelRequest, Infer<typeof SetLevelRequestSchema>> & Assert<Infer<typeof SetLevelRequestSchema>, SetLevelRequest>;

/**
 * Notification of a log message passed from server to client. If no logging/setLevel request has been sent from the client, the server MAY decide which messages to send automatically.
 */
export interface LoggingMessageNotification extends Notification {
  method: "notifications/message";
  params: {
    _meta?: { [key: string]: unknown };
    /**
     * The severity of this log message.
     */
    level: LoggingLevel;
    /**
     * An optional name of the logger issuing this message.
     */
    logger?: string;
    /**
     * The data to be logged, such as a string message or an object. Any JSON serializable type is allowed here.
     */
    data?: unknown;
    [key: string]: unknown;
  };
}
type _AssertLoggingMessageNotificationMatches = Assert<LoggingMessageNotification, Infer<typeof LoggingMessageNotificationSchema>> & Assert<Infer<typeof LoggingMessageNotificationSchema>, LoggingMessageNotification>;

/* Sampling */
/**
 * Hints to use for model selection.
 */
export interface ModelHint {
  /**
   * A hint for a model name.
   */
  name?: string;
  [key: string]: unknown;
}
type _AssertModelHintMatches = Assert<ModelHint, Infer<typeof ModelHintSchema>> & Assert<Infer<typeof ModelHintSchema>, ModelHint>;

/**
 * The server's preferences for model selection, requested of the client during sampling.
 */
export interface ModelPreferences {
  /**
   * Optional hints to use for model selection.
   */
  hints?: ModelHint[];
  /**
   * How much to prioritize cost when selecting a model.
   */
  costPriority?: number;
  /**
   * How much to prioritize sampling speed (latency) when selecting a model.
   */
  speedPriority?: number;
  /**
   * How much to prioritize intelligence and capabilities when selecting a model.
   */
  intelligencePriority?: number;
  [key: string]: unknown;
}
type _AssertModelPreferencesMatches = Assert<ModelPreferences, Infer<typeof ModelPreferencesSchema>> & Assert<Infer<typeof ModelPreferencesSchema>, ModelPreferences>;

/**
 * Describes a message issued to or received from an LLM API.
 */
export interface SamplingMessage {
  role: "user" | "assistant";
  content: TextContent | ImageContent | AudioContent;
  [key: string]: unknown;
}
type _AssertSamplingMessageMatches = Assert<SamplingMessage, Infer<typeof SamplingMessageSchema>> & Assert<Infer<typeof SamplingMessageSchema>, SamplingMessage>;

/**
 * A request from the server to sample an LLM via the client. The client has full discretion over which model to select. The client should also inform the user before beginning sampling, to allow them to inspect the request (human in the loop) and decide whether to approve it.
 */
export interface CreateMessageRequest extends Request {
  method: "sampling/createMessage";
  params: {
    _meta?: RequestMeta;
    messages: SamplingMessage[];
    /**
     * An optional system prompt the server wants to use for sampling. The client MAY modify or omit this prompt.
     */
    systemPrompt?: string;
    /**
     * A request to include context from one or more MCP servers (including the caller), to be attached to the prompt. The client MAY ignore this request.
     */
    includeContext?: "none" | "thisServer" | "allServers";
    temperature?: number;
    /**
     * The maximum number of tokens to sample, as requested by the server. The client MAY choose to sample fewer tokens than requested.
     */
    maxTokens: number;
    stopSequences?: string[];
    /**
     * Optional metadata to pass through to the LLM provider. The format of this metadata is provider-specific.
     */
    metadata?: { [key: string]: unknown };
    /**
     * The server's preferences for which model to select.
     */
    modelPreferences?: ModelPreferences;
    [key: string]: unknown;
  };
}
type _AssertCreateMessageRequestMatches = Assert<CreateMessageRequest, Infer<typeof CreateMessageRequestSchema>> & Assert<Infer<typeof CreateMessageRequestSchema>, CreateMessageRequest>;

/**
 * The client's response to a sampling/create_message request from the server. The client should inform the user before returning the sampled message, to allow them to inspect the response (human in the loop) and decide whether to allow the server to see it.
 */
export interface CreateMessageResult extends Result {
  /**
   * The name of the model that generated the message.
   */
  model: string;
  /**
   * The reason why sampling stopped.
   */
  stopReason?: "endTurn" | "stopSequence" | "maxTokens" | string;
  role: "user" | "assistant";
  content: TextContent | ImageContent | AudioContent;
}
type _AssertCreateMessageResultMatches = Assert<CreateMessageResult, Infer<typeof CreateMessageResultSchema>> & Assert<Infer<typeof CreateMessageResultSchema>, CreateMessageResult>;

/* Autocomplete */
/**
 * A reference to a resource or resource template definition.
 */
export interface ResourceReference {
  type: "ref/resource";
  /**
   * The URI or URI template of the resource.
   */
  uri: string;
  [key: string]: unknown;
}
type _AssertResourceReferenceMatches = Assert<ResourceReference, Infer<typeof ResourceReferenceSchema>> & Assert<Infer<typeof ResourceReferenceSchema>, ResourceReference>;

/**
 * Identifies a prompt.
 */
export interface PromptReference {
  type: "ref/prompt";
  /**
   * The name of the prompt or prompt template
   */
  name: string;
  [key: string]: unknown;
}
type _AssertPromptReferenceMatches = Assert<PromptReference, Infer<typeof PromptReferenceSchema>> & Assert<Infer<typeof PromptReferenceSchema>, PromptReference>;

/**
 * A request from the client to the server, to ask for completion options.
 */
export interface CompleteRequest extends Request {
  method: "completion/complete";
  params: {
    _meta?: RequestMeta;
    ref: PromptReference | ResourceReference;
    /**
     * The argument's information
     */
    argument: {
      /**
       * The name of the argument
       */
      name: string;
      /**
       * The value of the argument to use for completion matching.
       */
      value: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}
type _AssertCompleteRequestMatches = Assert<CompleteRequest, Infer<typeof CompleteRequestSchema>> & Assert<Infer<typeof CompleteRequestSchema>, CompleteRequest>;

/**
 * The server's response to a completion/complete request
 */
export interface CompleteResult extends Result {
  completion: {
    /**
     * An array of completion values. Must not exceed 100 items.
     */
    values: string[];
    /**
     * The total number of completion options available. This can exceed the number of values actually sent in the response.
     */
    total?: number;
    /**
     * Indicates whether there are additional completion options beyond those provided in the current response, even if the exact total is unknown.
     */
    hasMore?: boolean;
    [key: string]: unknown;
  };
}
type _AssertCompleteResultMatches = Assert<CompleteResult, Infer<typeof CompleteResultSchema>> & Assert<Infer<typeof CompleteResultSchema>, CompleteResult>;

/* Roots */
/**
 * Represents a root directory or file that the server can operate on.
 */
export interface Root {
  /**
   * The URI identifying the root. This *must* start with file:// for now.
   */
  uri: string;
  /**
   * An optional name for the root.
   */
  name?: string;
  [key: string]: unknown;
}
type _AssertRootMatches = Assert<Root, Infer<typeof RootSchema>> & Assert<Infer<typeof RootSchema>, Root>;

/**
 * Sent from the server to request a list of root URIs from the client.
 */
export interface ListRootsRequest extends Request {
  method: "roots/list";
}
type _AssertListRootsRequestMatches = Assert<ListRootsRequest, Infer<typeof ListRootsRequestSchema>> & Assert<Infer<typeof ListRootsRequestSchema>, ListRootsRequest>;

/**
 * The client's response to a roots/list request from the server.
 */
export interface ListRootsResult extends Result {
  roots: Root[];
}
type _AssertListRootsResultMatches = Assert<ListRootsResult, Infer<typeof ListRootsResultSchema>> & Assert<Infer<typeof ListRootsResultSchema>, ListRootsResult>;

/**
 * A notification from the client to the server, informing it that the list of roots has changed.
 */
export interface RootsListChangedNotification extends Notification {
  method: "notifications/roots/list_changed";
}
type _AssertRootsListChangedNotificationMatches = Assert<RootsListChangedNotification, Infer<typeof RootsListChangedNotificationSchema>> & Assert<Infer<typeof RootsListChangedNotificationSchema>, RootsListChangedNotification>;

/* Client messages */
export type ClientRequest = 
  | PingRequest
  | InitializeRequest
  | CompleteRequest
  | SetLevelRequest
  | GetPromptRequest
  | ListPromptsRequest
  | ListResourcesRequest
  | ListResourceTemplatesRequest
  | ReadResourceRequest
  | SubscribeRequest
  | UnsubscribeRequest
  | CallToolRequest
  | ListToolsRequest;
type _AssertClientRequestMatches = Assert<ClientRequest, Infer<typeof ClientRequestSchema>> & Assert<Infer<typeof ClientRequestSchema>, ClientRequest>;

export type ClientNotification = 
  | CancelledNotification
  | ProgressNotification
  | InitializedNotification
  | RootsListChangedNotification;
type _AssertClientNotificationMatches = Assert<ClientNotification, Infer<typeof ClientNotificationSchema>> & Assert<Infer<typeof ClientNotificationSchema>, ClientNotification>;

export type ClientResult = 
  | EmptyResult
  | CreateMessageResult
  | ListRootsResult;
type _AssertClientResultMatches = Assert<ClientResult, Infer<typeof ClientResultSchema>> & Assert<Infer<typeof ClientResultSchema>, ClientResult>;

/* Server messages */
export type ServerRequest = 
  | PingRequest
  | CreateMessageRequest
  | ListRootsRequest;
type _AssertServerRequestMatches = Assert<ServerRequest, Infer<typeof ServerRequestSchema>> & Assert<Infer<typeof ServerRequestSchema>, ServerRequest>;

export type ServerNotification = 
  | CancelledNotification
  | ProgressNotification
  | LoggingMessageNotification
  | ResourceUpdatedNotification
  | ResourceListChangedNotification
  | ToolListChangedNotification
  | PromptListChangedNotification;
type _AssertServerNotificationMatches = Assert<ServerNotification, Infer<typeof ServerNotificationSchema>> & Assert<Infer<typeof ServerNotificationSchema>, ServerNotification>;

export type ServerResult = 
  | EmptyResult
  | InitializeResult
  | CompleteResult
  | GetPromptResult
  | ListPromptsResult
  | ListResourcesResult
  | ListResourceTemplatesResult
  | ReadResourceResult
  | CallToolResult
  | ListToolsResult;
type _AssertServerResultMatches = Assert<ServerResult, Infer<typeof ServerResultSchema>> & Assert<Infer<typeof ServerResultSchema>, ServerResult>;
