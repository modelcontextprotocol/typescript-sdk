import { AuthInfo } from 'src/server/auth/types.js';
import { Notification, Request, RequestId, RequestInfo, RequestMeta, Result } from 'src/types.js';
import { Protocol, RequestHandlerExtra, RequestOptions } from './protocol.js';
import { ZodType } from 'zod';
import type { z } from 'zod';

export type LifespanContext = {
    [key: string]: unknown | undefined;
};
/**
 * A context object that is passed to request handlers.
 *
 * Implements the RequestHandlerExtra interface for backwards compatibility.
 *
 * TODO(Konstantin): Could be restructured better when breaking changes are allowed.
 */
export class RequestContext<
    LifespanContextT extends LifespanContext | undefined,
    RequestT extends Request = Request,
    NotificationT extends Notification = Notification,
    ResultT extends Result = Result
> implements RequestHandlerExtra<RequestT, NotificationT>
{
    /**
     * An abort signal used to communicate if the request was cancelled from the sender's side.
     */
    public readonly signal: AbortSignal;

    /**
     * Information about a validated access token, provided to request handlers.
     */
    public readonly authInfo?: AuthInfo;

    /**
     * The original HTTP request.
     */
    public readonly requestInfo?: RequestInfo;

    /**
     * The JSON-RPC ID of the request being handled.
     * This can be useful for tracking or logging purposes.
     */
    public readonly requestId: RequestId;

    /**
     * Metadata from the original request.
     */
    public readonly _meta?: RequestMeta;

    /**
     * The session ID from the transport, if available.
     */
    public readonly sessionId?: string;

    /**
     * The lifespan context. A type-safe context that is passed to request handlers.
     */
    public readonly lifespanContext: LifespanContextT;

    private readonly protocol: Protocol<RequestT, NotificationT, ResultT>;
    constructor(args: {
        signal: AbortSignal;
        authInfo?: AuthInfo;
        requestInfo?: RequestInfo;
        requestId: RequestId;
        _meta?: RequestMeta;
        sessionId?: string;
        lifespanContext: LifespanContextT;
        protocol: Protocol<RequestT, NotificationT, ResultT>;
    }) {
        this.signal = args.signal;
        this.authInfo = args.authInfo;
        this.requestInfo = args.requestInfo;
        this.requestId = args.requestId;
        this._meta = args._meta;
        this.sessionId = args.sessionId;
        this.lifespanContext = args.lifespanContext;
        this.protocol = args.protocol;
    }

    /**
     * Sends a notification that relates to the current request being handled.
     *
     * This is used by certain transports to correctly associate related messages.
     */
    public sendNotification = (notification: NotificationT): Promise<void> => {
        return this.protocol.notification(notification, { relatedRequestId: this.requestId });
    };

    /**
     * Sends a request that relates to the current request being handled.
     *
     * This is used by certain transports to correctly associate related messages.
     */
    public sendRequest = <U extends ZodType<object>>(request: RequestT, resultSchema: U, options?: RequestOptions): Promise<z.infer<U>> => {
        return this.protocol.request(request, resultSchema, { ...options, relatedRequestId: this.requestId });
    };
}
