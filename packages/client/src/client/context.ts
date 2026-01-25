import type {
    BaseRequestContext,
    ClientNotification,
    ClientRequest,
    ClientResult,
    ContextInterface,
    JSONRPCRequest,
    McpContext,
    Notification,
    Request,
    Result,
    TaskContext
} from '@modelcontextprotocol/core';
import { BaseContext } from '@modelcontextprotocol/core';

import type { Client } from './client.js';

/**
 * Client-specific request context.
 * Clients don't receive HTTP requests, so this is minimal.
 * Extends BaseRequestContext with any client-specific fields.
 */
export type ClientRequestContext = BaseRequestContext & {
    // Client doesn't receive HTTP requests, just JSON-RPC messages over transport.
    // Additional client-specific fields can be added here if needed.
};

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
    extends BaseContext<ClientRequest | RequestT, ClientNotification | NotificationT, ClientRequestContext, ClientResult | ResultT>
    implements ClientContextInterface<RequestT, NotificationT>
{
    private readonly client: Client<RequestT, NotificationT, ResultT>;

    constructor(args: {
        client: Client<RequestT, NotificationT, ResultT>;
        request: JSONRPCRequest;
        mcpContext: McpContext;
        requestCtx: ClientRequestContext;
        task?: TaskContext;
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
    protected getProtocol(): Client<RequestT, NotificationT, ResultT> {
        return this.client;
    }
}
