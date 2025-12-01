import { Protocol, type NotificationOptions, type ProtocolOptions, type RequestOptions } from '../shared/protocol.js';
import { type ClientCapabilities, type CreateMessageRequest, type ElicitRequestFormParams, type ElicitRequestURLParams, type ElicitResult, type Implementation, type ListRootsRequest, type LoggingMessageNotification, type Notification, type Request, type ResourceUpdatedNotification, type Result, type ServerCapabilities, type ServerNotification, type ServerRequest, type ServerResult } from '../types.js';
import type { jsonSchemaValidator } from '../validation/types.js';
import { AnyObjectSchema, SchemaOutput } from './zod-compat.js';
import { RequestHandlerExtra } from '../shared/protocol.js';
import { ExperimentalServerTasks } from '../experimental/tasks/server.js';
export type ServerOptions = ProtocolOptions & {
    /**
     * Capabilities to advertise as being supported by this server.
     */
    capabilities?: ServerCapabilities;
    /**
     * Optional instructions describing how to use the server and its features.
     */
    instructions?: string;
    /**
     * JSON Schema validator for elicitation response validation.
     *
     * The validator is used to validate user input returned from elicitation
     * requests against the requested schema.
     *
     * @default AjvJsonSchemaValidator
     *
     * @example
     * ```typescript
     * // ajv (default)
     * const server = new Server(
     *   { name: 'my-server', version: '1.0.0' },
     *   {
     *     capabilities: {}
     *     jsonSchemaValidator: new AjvJsonSchemaValidator()
     *   }
     * );
     *
     * // @cfworker/json-schema
     * const server = new Server(
     *   { name: 'my-server', version: '1.0.0' },
     *   {
     *     capabilities: {},
     *     jsonSchemaValidator: new CfWorkerJsonSchemaValidator()
     *   }
     * );
     * ```
     */
    jsonSchemaValidator?: jsonSchemaValidator;
};
/**
 * An MCP server on top of a pluggable transport.
 *
 * This server will automatically respond to the initialization flow as initiated from the client.
 *
 * To use with custom types, extend the base Request/Notification/Result types and pass them as type parameters:
 *
 * ```typescript
 * // Custom schemas
 * const CustomRequestSchema = RequestSchema.extend({...})
 * const CustomNotificationSchema = NotificationSchema.extend({...})
 * const CustomResultSchema = ResultSchema.extend({...})
 *
 * // Type aliases
 * type CustomRequest = z.infer<typeof CustomRequestSchema>
 * type CustomNotification = z.infer<typeof CustomNotificationSchema>
 * type CustomResult = z.infer<typeof CustomResultSchema>
 *
 * // Create typed server
 * const server = new Server<CustomRequest, CustomNotification, CustomResult>({
 *   name: "CustomServer",
 *   version: "1.0.0"
 * })
 * ```
 * @deprecated Use `McpServer` instead for the high-level API. Only use `Server` for advanced use cases.
 */
export declare class Server<RequestT extends Request = Request, NotificationT extends Notification = Notification, ResultT extends Result = Result> extends Protocol<ServerRequest | RequestT, ServerNotification | NotificationT, ServerResult | ResultT> {
    private _serverInfo;
    private _clientCapabilities?;
    private _clientVersion?;
    private _capabilities;
    private _instructions?;
    private _jsonSchemaValidator;
    private _experimental?;
    /**
     * Callback for when initialization has fully completed (i.e., the client has sent an `initialized` notification).
     */
    oninitialized?: () => void;
    /**
     * Initializes this server with the given name and version information.
     */
    constructor(_serverInfo: Implementation, options?: ServerOptions);
    /**
     * Access experimental features.
     *
     * WARNING: These APIs are experimental and may change without notice.
     *
     * @experimental
     */
    get experimental(): {
        tasks: ExperimentalServerTasks<RequestT, NotificationT, ResultT>;
    };
    private _loggingLevels;
    private readonly LOG_LEVEL_SEVERITY;
    private isMessageIgnored;
    /**
     * Registers new capabilities. This can only be called before connecting to a transport.
     *
     * The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
     */
    registerCapabilities(capabilities: ServerCapabilities): void;
    /**
     * Override request handler registration to enforce server-side validation for tools/call.
     */
    setRequestHandler<T extends AnyObjectSchema>(requestSchema: T, handler: (request: SchemaOutput<T>, extra: RequestHandlerExtra<ServerRequest | RequestT, ServerNotification | NotificationT>) => ServerResult | ResultT | Promise<ServerResult | ResultT>): void;
    protected assertCapabilityForMethod(method: RequestT['method']): void;
    protected assertNotificationCapability(method: (ServerNotification | NotificationT)['method']): void;
    protected assertRequestHandlerCapability(method: string): void;
    protected assertTaskCapability(method: string): void;
    protected assertTaskHandlerCapability(method: string): void;
    private _oninitialize;
    /**
     * After initialization has completed, this will be populated with the client's reported capabilities.
     */
    getClientCapabilities(): ClientCapabilities | undefined;
    /**
     * After initialization has completed, this will be populated with information about the client's name and version.
     */
    getClientVersion(): Implementation | undefined;
    private getCapabilities;
    ping(): Promise<{
        _meta?: {
            [x: string]: unknown;
            "io.modelcontextprotocol/related-task"?: {
                [x: string]: unknown;
                taskId: string;
            } | undefined;
        } | undefined;
    }>;
    createMessage(params: CreateMessageRequest['params'], options?: RequestOptions): Promise<{
        [x: string]: unknown;
        model: string;
        role: "user" | "assistant";
        content: {
            type: "text";
            text: string;
            _meta?: Record<string, unknown> | undefined;
        } | {
            type: "image";
            data: string;
            mimeType: string;
            _meta?: Record<string, unknown> | undefined;
        } | {
            type: "audio";
            data: string;
            mimeType: string;
            _meta?: Record<string, unknown> | undefined;
        } | {
            [x: string]: unknown;
            type: "tool_use";
            name: string;
            id: string;
            input: {
                [x: string]: unknown;
            };
            _meta?: {
                [x: string]: unknown;
            } | undefined;
        } | {
            [x: string]: unknown;
            type: "tool_result";
            toolUseId: string;
            content: ({
                type: "text";
                text: string;
                _meta?: Record<string, unknown> | undefined;
            } | {
                type: "image";
                data: string;
                mimeType: string;
                _meta?: Record<string, unknown> | undefined;
            } | {
                type: "audio";
                data: string;
                mimeType: string;
                _meta?: Record<string, unknown> | undefined;
            } | {
                type: "resource";
                resource: {
                    uri: string;
                    text: string;
                    mimeType?: string | undefined;
                    _meta?: Record<string, unknown> | undefined;
                } | {
                    uri: string;
                    blob: string;
                    mimeType?: string | undefined;
                    _meta?: Record<string, unknown> | undefined;
                };
                _meta?: Record<string, unknown> | undefined;
            } | {
                uri: string;
                name: string;
                type: "resource_link";
                description?: string | undefined;
                mimeType?: string | undefined;
                _meta?: {
                    [x: string]: unknown;
                } | undefined;
                icons?: {
                    src: string;
                    mimeType?: string | undefined;
                    sizes?: string[] | undefined;
                }[] | undefined;
                title?: string | undefined;
            })[];
            structuredContent?: {
                [x: string]: unknown;
            } | undefined;
            isError?: boolean | undefined;
            _meta?: {
                [x: string]: unknown;
            } | undefined;
        } | ({
            type: "text";
            text: string;
            _meta?: Record<string, unknown> | undefined;
        } | {
            type: "image";
            data: string;
            mimeType: string;
            _meta?: Record<string, unknown> | undefined;
        } | {
            type: "audio";
            data: string;
            mimeType: string;
            _meta?: Record<string, unknown> | undefined;
        } | {
            [x: string]: unknown;
            type: "tool_use";
            name: string;
            id: string;
            input: {
                [x: string]: unknown;
            };
            _meta?: {
                [x: string]: unknown;
            } | undefined;
        } | {
            [x: string]: unknown;
            type: "tool_result";
            toolUseId: string;
            content: ({
                type: "text";
                text: string;
                _meta?: Record<string, unknown> | undefined;
            } | {
                type: "image";
                data: string;
                mimeType: string;
                _meta?: Record<string, unknown> | undefined;
            } | {
                type: "audio";
                data: string;
                mimeType: string;
                _meta?: Record<string, unknown> | undefined;
            } | {
                type: "resource";
                resource: {
                    uri: string;
                    text: string;
                    mimeType?: string | undefined;
                    _meta?: Record<string, unknown> | undefined;
                } | {
                    uri: string;
                    blob: string;
                    mimeType?: string | undefined;
                    _meta?: Record<string, unknown> | undefined;
                };
                _meta?: Record<string, unknown> | undefined;
            } | {
                uri: string;
                name: string;
                type: "resource_link";
                description?: string | undefined;
                mimeType?: string | undefined;
                _meta?: {
                    [x: string]: unknown;
                } | undefined;
                icons?: {
                    src: string;
                    mimeType?: string | undefined;
                    sizes?: string[] | undefined;
                }[] | undefined;
                title?: string | undefined;
            })[];
            structuredContent?: {
                [x: string]: unknown;
            } | undefined;
            isError?: boolean | undefined;
            _meta?: {
                [x: string]: unknown;
            } | undefined;
        })[];
        _meta?: {
            [x: string]: unknown;
            "io.modelcontextprotocol/related-task"?: {
                [x: string]: unknown;
                taskId: string;
            } | undefined;
        } | undefined;
        stopReason?: string | undefined;
    }>;
    /**
     * Creates an elicitation request for the given parameters.
     * For backwards compatibility, `mode` may be omitted for form requests and will default to `'form'`.
     * @param params The parameters for the elicitation request.
     * @param options Optional request options.
     * @returns The result of the elicitation request.
     */
    elicitInput(params: ElicitRequestFormParams | ElicitRequestURLParams, options?: RequestOptions): Promise<ElicitResult>;
    /**
     * Creates a reusable callback that, when invoked, will send a `notifications/elicitation/complete`
     * notification for the specified elicitation ID.
     *
     * @param elicitationId The ID of the elicitation to mark as complete.
     * @param options Optional notification options. Useful when the completion notification should be related to a prior request.
     * @returns A function that emits the completion notification when awaited.
     */
    createElicitationCompletionNotifier(elicitationId: string, options?: NotificationOptions): () => Promise<void>;
    listRoots(params?: ListRootsRequest['params'], options?: RequestOptions): Promise<{
        [x: string]: unknown;
        roots: {
            uri: string;
            name?: string | undefined;
            _meta?: Record<string, unknown> | undefined;
        }[];
        _meta?: {
            [x: string]: unknown;
            "io.modelcontextprotocol/related-task"?: {
                [x: string]: unknown;
                taskId: string;
            } | undefined;
        } | undefined;
    }>;
    /**
     * Sends a logging message to the client, if connected.
     * Note: You only need to send the parameters object, not the entire JSON RPC message
     * @see LoggingMessageNotification
     * @param params
     * @param sessionId optional for stateless and backward compatibility
     */
    sendLoggingMessage(params: LoggingMessageNotification['params'], sessionId?: string): Promise<void>;
    sendResourceUpdated(params: ResourceUpdatedNotification['params']): Promise<void>;
    sendResourceListChanged(): Promise<void>;
    sendToolListChanged(): Promise<void>;
    sendPromptListChanged(): Promise<void>;
}
export type { SessionStore, SessionData, SessionStorageMode } from './streamableHttp.js';
export { RedisSessionStore, InMemorySessionStore } from './session-stores/redis.js';
export type { RedisClient, RedisSessionStoreOptions } from './session-stores/redis.js';
//# sourceMappingURL=index.d.ts.map