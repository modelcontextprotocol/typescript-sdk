import type {
    ClientNotification,
    ClientRequest,
    ClientRequestContext,
    ContextInterface,
    JSONRPCRequest,
    McpContext,
    Notification,
    ProtocolInterface,
    Request,
    Result,
    TaskContext
} from '@modelcontextprotocol/core';
import { BaseContext } from '@modelcontextprotocol/core';

import type { Client } from './client.js';

/**
 * Type alias for client-side request handler context.
 * Extends the base ContextInterface with ClientRequestContext.
 * The generic parameters match the Client's combined types.
 */
export type ClientContextInterface<
    RequestT extends Request = Request,
    NotificationT extends Notification = Notification
> = ContextInterface<ClientRequest | RequestT, ClientNotification | NotificationT, ClientRequestContext>;

/**
 * A context object that is passed to client-side request handlers.
 * Used when the client handles requests from the server (e.g., sampling, elicitation).
 */
export class ClientContext<
        RequestT extends Request = Request,
        NotificationT extends Notification = Notification,
        ResultT extends Result = Result
    >
    extends BaseContext<ClientRequest | RequestT, ClientNotification | NotificationT, ClientRequestContext>
    implements ClientContextInterface<RequestT, NotificationT>
{
    private readonly client: Client<RequestT, NotificationT, ResultT>;

    constructor(args: {
        client: Client<RequestT, NotificationT, ResultT>;
        request: JSONRPCRequest;
        mcpContext: McpContext;
        requestCtx: ClientRequestContext;
        task: TaskContext | undefined;
    }) {
        super({
            request: args.request,
            mcpContext: args.mcpContext,
            requestCtx: args.requestCtx,
            task: args.task
        });
        this.client = args.client;
    }

    /**
     * Returns the client instance for sending notifications and requests.
     */
    protected getProtocol(): ProtocolInterface<ClientRequest | RequestT, ClientNotification | NotificationT> {
        return this.client;
    }
}
