import { AuthInfo } from './auth/types.js';
import { Notification, Request, RequestId, RequestInfo, RequestMeta, Result } from '../types.js';
import { Protocol, RequestHandlerExtra, RequestTaskStore, TaskRequestOptions } from '../shared/protocol.js';
import { AnySchema, SchemaOutput } from './zod-compat.js';

/**
 * A context object that is passed to request handlers.
 *
 * Implements the RequestHandlerExtra interface for backwards compatibility.
 */
export class RequestContext<
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
     * The task store, if available.
     */
    public readonly taskStore?: RequestTaskStore;

    public readonly taskId?: string;

    public readonly taskRequestedTtl?: number | null;

    private readonly protocol: Protocol<RequestT, NotificationT, ResultT>;
    constructor(args: {
        signal: AbortSignal;
        authInfo?: AuthInfo;
        requestInfo?: RequestInfo;
        requestId: RequestId;
        _meta?: RequestMeta;
        sessionId?: string;
        protocol: Protocol<RequestT, NotificationT, ResultT>;
        taskStore?: RequestTaskStore;
        taskId?: string;
        taskRequestedTtl?: number | null;
        closeSSEStream: (() => void) | undefined;
        closeStandaloneSSEStream: (() => void) | undefined;
    }) {
        this.signal = args.signal;
        this.authInfo = args.authInfo;
        this.requestInfo = args.requestInfo;
        this.requestId = args.requestId;
        this._meta = args._meta;
        this.sessionId = args.sessionId;
        this.protocol = args.protocol;
        this.taskStore = args.taskStore;
        this.taskId = args.taskId;
        this.taskRequestedTtl = args.taskRequestedTtl;
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
    public sendRequest = <U extends AnySchema>(request: RequestT, resultSchema: U, options?: TaskRequestOptions): Promise<SchemaOutput<U>> => {
        return this.protocol.request(request, resultSchema, { ...options, relatedRequestId: this.requestId });
    };

    public closeSSEStream = (): void => {
        return this.closeSSEStream();
    }

    public closeStandaloneSSEStream = (): void => {
        return this.closeStandaloneSSEStream();
    }
}