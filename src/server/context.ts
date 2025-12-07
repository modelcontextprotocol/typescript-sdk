import {
    CreateMessageRequest,
    CreateMessageResult,
    ElicitRequest,
    ElicitResult,
    ElicitResultSchema,
    LoggingMessageNotification,
    Notification,
    Request,
    RequestId,
    RequestInfo,
    RequestMeta,
    Result,
    ServerNotification,
    ServerRequest,
    ServerResult
} from '../types.js';
import { RequestHandlerExtra, RequestOptions, RequestTaskStore } from '../shared/protocol.js';
import { Server } from './index.js';
import { RequestContext } from './requestContext.js';
import { AuthInfo } from './auth/types.js';
import { AnySchema, SchemaOutput } from './zod-compat.js';

export interface ContextInterface<RequestT extends Request = Request, NotificationT extends Notification = Notification> extends RequestHandlerExtra<ServerRequest | RequestT, NotificationT | ServerNotification> {
    elicit(params: ElicitRequest['params'], options?: RequestOptions): Promise<ElicitResult>;
    requestSampling: (params: CreateMessageRequest['params'], options?: RequestOptions) => Promise<CreateMessageResult>;
    log(params: LoggingMessageNotification['params'], sessionId?: string): Promise<void>;
    debug(message: string, extraLogData?: Record<string, unknown>, sessionId?: string): Promise<void>;
    info(message: string, extraLogData?: Record<string, unknown>, sessionId?: string): Promise<void>;
    warning(message: string, extraLogData?: Record<string, unknown>, sessionId?: string): Promise<void>;
    error(message: string, extraLogData?: Record<string, unknown>, sessionId?: string): Promise<void>;
}
/**
 * A context object that is passed to request handlers.
 *
 * Implements the RequestHandlerExtra interface for backwards compatibility.
 */
export class Context<
    RequestT extends Request = Request,
    NotificationT extends Notification = Notification,
    ResultT extends Result = Result
> implements ContextInterface<RequestT, NotificationT>
{
    private readonly server: Server<RequestT, NotificationT, ResultT>;

    /**
     * The request context.
     * A type-safe context that is passed to request handlers.
     */
    public readonly requestCtx: RequestContext< 
        RequestT | ServerRequest,
        NotificationT | ServerNotification,
        ResultT | ServerResult
    >;

    constructor(args: {
        server: Server<RequestT, NotificationT, ResultT>;
        requestCtx: RequestContext<RequestT | ServerRequest, NotificationT | ServerNotification, ResultT | ServerResult>;
    }) {
        this.server = args.server;
        this.requestCtx = args.requestCtx;
    }

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

    public get _meta(): RequestMeta | undefined {
        return this.requestCtx._meta;
    }

    public get sessionId(): string | undefined {
        return this.requestCtx.sessionId;
    }

    public get taskId(): string | undefined {
        return this.requestCtx.taskId;
    }

    public get taskStore(): RequestTaskStore | undefined {
        return this.requestCtx.taskStore;
    }

    public get taskRequestedTtl(): number | undefined {
        return this.requestCtx.taskRequestedTtl ?? undefined;
    }

    public closeSSEStream = (): void => {
        return this.requestCtx?.closeSSEStream();
    }

    public closeStandaloneSSEStream = (): void => {
        return this.requestCtx?.closeStandaloneSSEStream();
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
    public async elicit(params: ElicitRequest['params'], options?: RequestOptions): Promise<ElicitResult> {
        const request: ElicitRequest = {
            method: 'elicitation/create',
            params
        };
        return await this.server.request(request, ElicitResultSchema, { ...options, relatedRequestId: this.requestId });
    }

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