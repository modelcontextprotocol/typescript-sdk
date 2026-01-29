import type {
    BaseRequestContext,
    ContextInterface,
    CreateMessageRequest,
    CreateMessageResult,
    ElicitRequest,
    ElicitResult,
    JSONRPCRequest,
    LoggingMessageNotification,
    McpContext,
    Notification,
    Request,
    RequestOptions,
    Result,
    ServerNotification,
    ServerRequest,
    ServerResult,
    TaskContext
} from '@modelcontextprotocol/core';
import { BaseContext, ElicitResultSchema } from '@modelcontextprotocol/core';

import type { Server } from './server.js';

/**
 * Server-specific request context with HTTP request details.
 * Extends BaseRequestContext with fields only available on the server side.
 */
export type ServerRequestContext = BaseRequestContext & {
    /**
     * The URI of the incoming HTTP request.
     */
    uri: URL;
    /**
     * The headers of the incoming HTTP request.
     */
    headers: Headers;
    /**
     * Stream control methods for SSE connections.
     */
    stream: {
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
    };
};

/**
 * Interface for sending logging messages to the client via {@link LoggingMessageNotification}.
 */
export interface LoggingMessageNotificationSenderInterface {
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

export class ServerLogger implements LoggingMessageNotificationSenderInterface {
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

/**
 * Server-specific context interface extending the base ContextInterface.
 * Includes server-specific methods for logging, elicitation, and sampling.
 */
export interface ServerContextInterface<RequestT extends Request = Request, NotificationT extends Notification = Notification>
    extends ContextInterface<RequestT | ServerRequest, NotificationT | ServerNotification, ServerRequestContext> {
    /**
     * Logger for sending logging messages to the client.
     */
    loggingNotification: LoggingMessageNotificationSenderInterface;
    /**
     * Sends an elicitation request to the client.
     */
    elicitInput: (params: ElicitRequest['params'], options?: RequestOptions) => Promise<ElicitResult>;
    /**
     * Sends a sampling request to the client.
     */
    requestSampling: (params: CreateMessageRequest['params'], options?: RequestOptions) => Promise<CreateMessageResult>;
}

/**
 * A context object that is passed to server-side request handlers.
 * Provides access to MCP context, request context, task context, and server-specific methods.
 */
export class ServerContext<
        RequestT extends Request = Request,
        NotificationT extends Notification = Notification,
        ResultT extends Result = Result
    >
    extends BaseContext<RequestT | ServerRequest, NotificationT | ServerNotification, ServerRequestContext, ServerResult | ResultT>
    implements ServerContextInterface<RequestT, NotificationT>
{
    private readonly server: Server<RequestT, NotificationT, ResultT>;

    /**
     * Logger for sending logging messages to the client.
     */
    public readonly loggingNotification: LoggingMessageNotificationSenderInterface;

    constructor(args: {
        server: Server<RequestT, NotificationT, ResultT>;
        request: JSONRPCRequest;
        mcpContext: McpContext;
        requestCtx: ServerRequestContext;
        task: TaskContext | undefined;
    }) {
        super({
            request: args.request,
            mcpContext: args.mcpContext,
            requestCtx: args.requestCtx,
            task: args.task
        });
        this.server = args.server;
        this.loggingNotification = new ServerLogger(args.server);
    }

    /**
     * Returns the server instance for sending notifications and requests.
     */
    protected getProtocol(): Server<RequestT, NotificationT, ResultT> {
        return this.server;
    }

    /**
     * Sends a sampling request to the client.
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
        return await this.server.request(request, ElicitResultSchema, { ...options, relatedRequestId: this.mcpCtx.requestId });
    }
}
