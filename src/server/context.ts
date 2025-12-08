import {
    CreateMessageRequest,
    CreateMessageResult,
    ElicitRequest,
    ElicitResult,
    ElicitResultSchema,
    JSONRPCRequest,
    LoggingMessageNotification,
    Notification,
    Request,
    RequestId,
    RequestInfo,
    RequestMeta,
    Result,
    ServerNotification,
    ServerRequest
} from '../types.js';
import { RequestHandlerExtra, RequestOptions, RequestTaskStore } from '../shared/protocol.js';
import { Server } from './index.js';
import { AuthInfo } from './auth/types.js';
import { AnySchema, SchemaOutput } from './zod-compat.js';

/**
 * Interface for sending logging messages to the client via {@link LoggingMessageNotification}.
 */
export interface LoggingMessageSenderInterface {
    /**
     * Sends a logging message to the client.
     */
    log(params: LoggingMessageNotification['params'], sessionId?: string): Promise<void>;
    /**
     * Sends a debug log message to the client.
     */
    debug(message: string, extraLogData?: Record<string, unknown>, sessionId?: string): Promise<void>;
    /**
     * Sends an info log message to the client.
     */
    info(message: string, extraLogData?: Record<string, unknown>, sessionId?: string): Promise<void>;
    /**
     * Sends a warning log message to the client.
     */
    warning(message: string, extraLogData?: Record<string, unknown>, sessionId?: string): Promise<void>;
    /**
     * Sends an error log message to the client.
     */
    error(message: string, extraLogData?: Record<string, unknown>, sessionId?: string): Promise<void>;
}

export class ServerLogger implements LoggingMessageSenderInterface {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(private readonly server: Server<any, any, any>) {}

    /**
     * Sends a logging message.
     */
    public async log(params: LoggingMessageNotification['params'], sessionId?: string) {
        await this.server.sendLoggingMessage(params, sessionId);
    }

    /**
     * Sends a debug log message.
     */
    public async debug(message: string, extraLogData?: Record<string, unknown>, sessionId?: string) {
        await this.log(
            {
                level: 'debug',
                data: {
                    ...extraLogData,
                    message
                },
                logger: 'server'
            },
            sessionId
        );
    }

    /**
     * Sends an info log message.
     */
    public async info(message: string, extraLogData?: Record<string, unknown>, sessionId?: string) {
        await this.log(
            {
                level: 'info',
                data: {
                    ...extraLogData,
                    message
                },
                logger: 'server'
            },
            sessionId
        );
    }

    /**
     * Sends a warning log message.
     */
    public async warning(message: string, extraLogData?: Record<string, unknown>, sessionId?: string) {
        await this.log(
            {
                level: 'warning',
                data: {
                    ...extraLogData,
                    message
                },
                logger: 'server'
            },
            sessionId
        );
    }

    /**
     * Sends an error log message.
     */
    public async error(message: string, extraLogData?: Record<string, unknown>, sessionId?: string) {
        await this.log(
            {
                level: 'error',
                data: {
                    ...extraLogData,
                    message
                },
                logger: 'server'
            },
            sessionId
        );
    }
}

export interface ContextInterface<RequestT extends Request = Request, NotificationT extends Notification = Notification>
    extends RequestHandlerExtra<ServerRequest | RequestT, NotificationT | ServerNotification> {
    elicitInput(params: ElicitRequest['params'], options?: RequestOptions): Promise<ElicitResult>;
    requestSampling: (params: CreateMessageRequest['params'], options?: RequestOptions) => Promise<CreateMessageResult>;
    logger: LoggingMessageSenderInterface;
}
/**
 * A context object that is passed to request handlers.
 *
 * Implements the RequestHandlerExtra interface for backwards compatibility.
 */
export class Context<RequestT extends Request = Request, NotificationT extends Notification = Notification, ResultT extends Result = Result>
    implements ContextInterface<RequestT, NotificationT>
{
    private readonly server: Server<RequestT, NotificationT, ResultT>;

    /**
     * The request context.
     * A type-safe context that is passed to request handlers.
     */
    private readonly requestCtx: RequestHandlerExtra<ServerRequest | RequestT, ServerNotification | NotificationT>;

    /**
     * The MCP context - Contains information about the current MCP request and session.
     */
    public readonly mcpContext: {
        /**
         * The JSON-RPC ID of the request being handled.
         * This can be useful for tracking or logging purposes.
         */
        requestId: RequestId;
        /**
         * The method of the request.
         */
        method: string;
        /**
         * The metadata of the request.
         */
        _meta?: RequestMeta;
        /**
         * The session ID of the request.
         */
        sessionId?: string;
    };

    public readonly task:
        | {
              id: string | undefined;
              store: RequestTaskStore | undefined;
              requestedTtl: number | null | undefined;
          }
        | undefined;

    public readonly stream: {
        /**
         * Closes the SSE stream for this request, triggering client reconnection.
         * Only available when using StreamableHTTPServerTransport with eventStore configured.
         * Use this to implement polling behavior during long-running operations.
         */
        closeSSEStream: (() => void) | undefined;
        /**
         * Closes the standalone GET SSE stream, triggering client reconnection.
         * Only available when using StreamableHTTPServerTransport with eventStore configured.
         * Use this to implement polling behavior for server-initiated notifications.
         */
        closeStandaloneSSEStream: (() => void) | undefined;
    } | undefined;

    public readonly logger: LoggingMessageSenderInterface;

    constructor(args: {
        server: Server<RequestT, NotificationT, ResultT>;
        request: JSONRPCRequest;
        requestCtx: RequestHandlerExtra<ServerRequest | RequestT, ServerNotification | NotificationT>;
    }) {
        this.server = args.server;
        this.requestCtx = args.requestCtx;
        this.mcpContext = {
            requestId: args.requestCtx.requestId,
            method: args.request.method,
            _meta: args.requestCtx._meta,
            sessionId: args.requestCtx.sessionId
        };

        this.task = {
            id: args.requestCtx.taskId,
            store: args.requestCtx.taskStore,
            requestedTtl: args.requestCtx.taskRequestedTtl
        };

        this.logger = new ServerLogger(args.server);

        this.stream = {
            closeSSEStream: args.requestCtx.closeSSEStream,
            closeStandaloneSSEStream: args.requestCtx.closeStandaloneSSEStream
        };
    }

    /**
     * The JSON-RPC ID of the request being handled.
     * This can be useful for tracking or logging purposes.
     *
     * @deprecated Use {@link mcpContext.requestId} instead.
     */
    public get requestId(): RequestId {
        return this.requestCtx.requestId;
    }

    public get signal(): AbortSignal {
        return this.requestCtx.signal;
    }

    public get authInfo(): AuthInfo | undefined {
        return this.requestCtx.authInfo;
    }

    public get requestInfo(): RequestInfo | undefined {
        return this.requestCtx.requestInfo;
    }

    /**
     * @deprecated Use {@link mcpContext._meta} instead.
     */
    public get _meta(): RequestMeta | undefined {
        return this.requestCtx._meta;
    }

    /**
     * @deprecated Use {@link mcpContext.sessionId} instead.
     */
    public get sessionId(): string | undefined {
        return this.mcpContext.sessionId;
    }

    /**
     * @deprecated Use {@link task.id} instead.
     */
    public get taskId(): string | undefined {
        return this.requestCtx.taskId;
    }

    /**
     * @deprecated Use {@link task.store} instead.
     */
    public get taskStore(): RequestTaskStore | undefined {
        return this.requestCtx.taskStore;
    }

    /**
     * @deprecated Use {@link task.requestedTtl} instead.
     */
    public get taskRequestedTtl(): number | undefined {
        return this.requestCtx.taskRequestedTtl ?? undefined;
    }

    /**
     * @deprecated Use {@link stream.closeSSEStream} instead.
     */
    public get closeSSEStream(): (() => void) | undefined {
        return this.requestCtx.closeSSEStream;
    }

    /**
     * @deprecated Use {@link stream.closeStandaloneSSEStream} instead.
     */
    public get closeStandaloneSSEStream(): (() => void) | undefined {
        return this.requestCtx.closeStandaloneSSEStream;
    }

    /**
     * Sends a notification that relates to the current request being handled.
     *
     * This is used by certain transports to correctly associate related messages.
     */
    public sendNotification = (notification: NotificationT | ServerNotification): Promise<void> => {
        return this.requestCtx.sendNotification(notification);
    };

    /**
     * Sends a request that relates to the current request being handled.
     *
     * This is used by certain transports to correctly associate related messages.
     */
    public sendRequest = <U extends AnySchema>(
        request: RequestT | ServerRequest,
        resultSchema: U,
        options?: RequestOptions
    ): Promise<SchemaOutput<U>> => {
        return this.requestCtx.sendRequest(request, resultSchema, { ...options, relatedRequestId: this.requestId });
    };

    /**
     * Sends a request to sample an LLM via the client.
     */
    public requestSampling(params: CreateMessageRequest['params'], options?: RequestOptions) {
        return this.server.createMessage(params, options);
    }

    /**
     * Sends an elicitation request to the client.
     */
    public async elicitInput(params: ElicitRequest['params'], options?: RequestOptions): Promise<ElicitResult> {
        const request: ElicitRequest = {
            method: 'elicitation/create',
            params
        };
        return await this.server.request(request, ElicitResultSchema, { ...options, relatedRequestId: this.requestId });
    }
}
