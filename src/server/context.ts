import {
    CreateMessageRequest,
    CreateMessageResultSchema,
    ElicitRequest,
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
import { RequestHandlerExtra, RequestOptions } from '../shared/protocol.js';
import { ZodType } from 'zod';
import type { z } from 'zod';
import { Server } from './index.js';
import { LifespanContext, RequestContext } from '../shared/requestContext.js';
import { AuthInfo } from './auth/types.js';

/**
 * A context object that is passed to request handlers.
 *
 * Implements the RequestHandlerExtra interface for backwards compatibility.
 * Notes:
 * Keeps this backwards compatible with the old RequestHandlerExtra interface and provides getter methods for backwards compatibility.
 * In a breaking change, this can be removed and the RequestContext can be used directly via ctx.requestContext.
 *
 * TODO(Konstantin): Could be restructured better when breaking changes are allowed. More
 */
export class Context<
    LifespanContextT extends LifespanContext | undefined = undefined,
    RequestT extends Request = Request,
    NotificationT extends Notification = Notification,
    ResultT extends Result = Result
> implements RequestHandlerExtra<ServerRequest | RequestT, ServerNotification | NotificationT>
{
    private readonly server: Server<RequestT, NotificationT, ResultT, LifespanContextT>;

    /**
     * The request context.
     * A type-safe context that is passed to request handlers.
     */
    public readonly requestCtx: RequestContext<
        LifespanContextT,
        RequestT | ServerRequest,
        NotificationT | ServerNotification,
        ResultT | ServerResult
    >;

    constructor(args: {
        server: Server<RequestT, NotificationT, ResultT, LifespanContextT>;
        requestCtx: RequestContext<LifespanContextT, RequestT | ServerRequest, NotificationT | ServerNotification, ResultT | ServerResult>;
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
    public sendRequest = <U extends ZodType<object>>(
        request: RequestT | ServerRequest,
        resultSchema: U,
        options?: RequestOptions
    ): Promise<z.infer<U>> => {
        return this.requestCtx.sendRequest(request, resultSchema, { ...options, relatedRequestId: this.requestId });
    };

    /**
     * Sends a request to sample an LLM via the client.
     */
    public requestSampling(params: CreateMessageRequest['params'], options?: RequestOptions) {
        const request: CreateMessageRequest = {
            method: 'sampling/createMessage',
            params
        };
        return this.server.request(request, CreateMessageResultSchema, { ...options, relatedRequestId: this.requestId });
    }

    /**
     * Sends an elicitation request to the client.
     */
    public elicit(params: ElicitRequest['params'], options?: RequestOptions) {
        const request: ElicitRequest = {
            method: 'elicitation/create',
            params
        };
        return this.server.request(request, ElicitResultSchema, { ...options, relatedRequestId: this.requestId });
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
