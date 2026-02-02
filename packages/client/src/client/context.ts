import type {
    ClientNotification,
    ClientRequest,
    ClientResult,
    ContextInterface,
    HttpReqContext,
    JSONRPCRequest,
    McpReqContextInput,
    Notification,
    Request,
    Result,
    TaskContext
} from '@modelcontextprotocol/core';
import { BaseContext } from '@modelcontextprotocol/core';

import type { Client } from './client.js';

/**
 * Type alias for client-side request handler context.
 * Extends the base ContextInterface with no additional fields.
 * The generic parameters match the Client's combined types.
 */
export type ClientContextInterface<
    RequestT extends Request = Request,
    NotificationT extends Notification = Notification
> = ContextInterface<ClientRequest | RequestT, ClientNotification | NotificationT>;

/**
 * A context object that is passed to client-side request handlers.
 * Used when the client handles requests from the server (e.g., sampling, elicitation).
 */
export class ClientContext<
        RequestT extends Request = Request,
        NotificationT extends Notification = Notification,
        ResultT extends Result = Result
    >
    extends BaseContext<ClientRequest | RequestT, ClientNotification | NotificationT, ClientResult | ResultT>
    implements ClientContextInterface<RequestT, NotificationT>
{
    private readonly client: Client<RequestT, NotificationT, ResultT>;

    constructor(args: {
        sessionId?: string;
        request: JSONRPCRequest;
        mcpReq: McpReqContextInput;
        http?: HttpReqContext;
        task: TaskContext | undefined;
        client: Client<RequestT, NotificationT, ResultT>;
    }) {
        super({
            request: args.request,
            sessionId: args.sessionId,
            mcpReq: args.mcpReq,
            http: args.http,
            task: args.task
        });
        this.client = args.client;
    }

    /**
     * Returns the client instance for sending notifications and requests.
     */
    protected getProtocol(): Client<RequestT, NotificationT, ResultT> {
        return this.client;
    }
}
