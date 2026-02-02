import type {
    ContextInterface,
    CreateMessageRequest,
    CreateMessageResult,
    ElicitRequest,
    ElicitResult,
    HttpReqContext,
    JSONRPCRequest,
    LoggingMessageNotification,
    McpReqContext,
    McpReqContextInput,
    Notification,
    NotificationContext,
    Request as SdkRequest,
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
 * Server-specific notification context with logging methods.
 */
export type ServerNotificationContext<NotificationT extends Notification = Notification> = NotificationContext<
    NotificationT | ServerNotification
> & {
    /**
     * Sends a logging message to the client.
     */
    log(params: LoggingMessageNotification['params'], sessionId?: string): Promise<void>;
    /**
     * Sends a debug log message to the client.
     */
    debug(message: string, extraLogData?: Record<string, unknown>): Promise<void>;
    /**
     * Sends an info log message to the client.
     */
    info(message: string, extraLogData?: Record<string, unknown>): Promise<void>;
    /**
     * Sends a warning log message to the client.
     */
    warning(message: string, extraLogData?: Record<string, unknown>): Promise<void>;
    /**
     * Sends an error log message to the client.
     */
    error(message: string, extraLogData?: Record<string, unknown>): Promise<void>;
};
class NotificationLogHelper {
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
export interface ServerContextInterface<RequestT extends SdkRequest = SdkRequest, NotificationT extends Notification = Notification>
    extends ContextInterface<RequestT | ServerRequest, NotificationT | ServerNotification> {
    mcpReq: McpReqContext & {
        /**
         * Sends an elicitation request to the client.
         */
        elicitInput: (params: ElicitRequest['params'], options?: RequestOptions) => Promise<ElicitResult>;
        /**
         * Sends a sampling request to the client.
         */
        requestSampling: (params: CreateMessageRequest['params'], options?: RequestOptions) => Promise<CreateMessageResult>;
    };

    /**
     * Request context with authentication, send method, and raw Request object.
     */
    http?: HttpReqContext & {
        /**
         * The raw Request object (fetch API Request).
         * Provides access to url, headers, and other request properties.
         */
        req: Request;

        /**
         * Closes the SSE stream for this request, triggering client reconnection.
         * Only available when using StreamableHTTPServerTransport with eventStore configured.
         */
        closeSSE?: () => void;
        /**
         * Closes the standalone GET SSE stream, triggering client reconnection.
         * Only available when using StreamableHTTPServerTransport with eventStore configured.
         */
        closeStandaloneSSE?: () => void;
    };
    /**
     * Notification context with logging methods.
     */
    notification: ServerNotificationContext<NotificationT>;
}

/**
 * A context object that is passed to server-side request handlers.
 * Provides access to MCP context, request context, task context, and server-specific methods.
 */
export class ServerContext<
        RequestT extends SdkRequest = SdkRequest,
        NotificationT extends Notification = Notification,
        ResultT extends Result = Result
    >
    extends BaseContext<RequestT | ServerRequest, NotificationT | ServerNotification, ServerResult | ResultT>
    implements ServerContextInterface<RequestT, NotificationT>
{
    private readonly server: Server<RequestT, NotificationT, ResultT>;

    /**
     * MCP request context containing protocol-level information.
     */
    declare public readonly mcpReq: ServerContextInterface<RequestT, NotificationT>['mcpReq'];
    /**
     * HTTP request context with authentication, send method, and raw Request object.
     */
    declare public readonly http?: ServerContextInterface<RequestT, NotificationT>['http'];

    /**
     * Notification context with logging methods.
     */
    declare public readonly notification: ServerNotificationContext<NotificationT>;

    private readonly _notificationLogHelper: NotificationLogHelper;

    constructor(args: {
        sessionId?: string;
        request: JSONRPCRequest;
        mcpReq: McpReqContextInput;
        http?: ServerContextInterface['http'];
        task: TaskContext | undefined;
        server: Server<RequestT, NotificationT, ResultT>;
    }) {
        super({
            sessionId: args.sessionId,
            request: args.request,
            mcpReq: args.mcpReq,
            http: args.http,
            task: args.task
        });

        this.server = args.server;

        this.mcpReq = {
            ...this.mcpReq,
            elicitInput: this._elicitInput.bind(this),
            requestSampling: this._requestSampling.bind(this)
        };

        // Override req with server-specific version that includes raw Request
        this.http = args.http;

        // Capture base notification for delegation
        const baseNotification = this.notification;
        this._notificationLogHelper = new NotificationLogHelper(this.server);

        // Override notification with server-specific version that includes logging
        const helper = this._notificationLogHelper;
        this.notification = {
            send: baseNotification.send,
            log: helper.log.bind(helper),
            debug: helper.debug.bind(helper),
            info: helper.info.bind(helper),
            warning: helper.warning.bind(helper),
            error: helper.error.bind(helper)
        };
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
    protected _requestSampling(params: CreateMessageRequest['params'], options?: RequestOptions) {
        return this.server.createMessage(params, options);
    }

    /**
     * Sends an elicitation request to the client.
     */
    protected async _elicitInput(params: ElicitRequest['params'], options?: RequestOptions): Promise<ElicitResult> {
        const request: ElicitRequest = {
            method: 'elicitation/create',
            params
        };
        return await this.server.request(request, ElicitResultSchema, { ...options, relatedRequestId: this.mcpReq.id });
    }
}
