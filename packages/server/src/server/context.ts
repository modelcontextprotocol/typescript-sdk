import type {
    BaseContext,
    CreateMessageRequest,
    CreateMessageResult,
    ElicitRequest,
    ElicitResult,
    LoggingMessageNotification,
    Notification,
    Request,
    RequestOptions,
    ServerNotification,
    ServerRequest
} from '@modelcontextprotocol/core';

/**
 * Server-specific context type for request handlers.
 * Extends BaseContext with server-specific methods for logging, elicitation, and sampling.
 *
 * @typeParam RequestT - Additional request types beyond ServerRequest
 * @typeParam NotificationT - Additional notification types beyond ServerNotification
 */
export type ServerContext<RequestT extends Request = Request, NotificationT extends Notification = Notification> = Omit<
    BaseContext<ServerRequest | RequestT, ServerNotification | NotificationT>,
    'mcpReq' | 'http' | 'notification'
> & {
    /**
     * MCP request context containing protocol-level information and server-specific methods.
     */
    mcpReq: BaseContext<ServerRequest | RequestT, ServerNotification | NotificationT>['mcpReq'] & {
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
     * HTTP request context with authentication, raw Request object, and SSE controls.
     */
    http?: BaseContext['http'] & {
        /**
         * The raw Request object (fetch API Request).
         * Provides access to url, headers, and other request properties.
         */
        req: globalThis.Request;
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
     * Notification context with send method and logging helpers.
     */
    notification: BaseContext<ServerRequest | RequestT, ServerNotification | NotificationT>['notification'] & {
        /**
         * Sends a logging message to the client.
         */
        log: (params: LoggingMessageNotification['params']) => Promise<void>;
        /**
         * Sends a debug log message to the client.
         */
        debug: (message: string, extraLogData?: Record<string, unknown>) => Promise<void>;
        /**
         * Sends an info log message to the client.
         */
        info: (message: string, extraLogData?: Record<string, unknown>) => Promise<void>;
        /**
         * Sends a warning log message to the client.
         */
        warning: (message: string, extraLogData?: Record<string, unknown>) => Promise<void>;
        /**
         * Sends an error log message to the client.
         */
        error: (message: string, extraLogData?: Record<string, unknown>) => Promise<void>;
    };
};
