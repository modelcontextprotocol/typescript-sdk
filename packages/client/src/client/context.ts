import type {
    ClientNotification,
    ClientRequest,
    ClientResult,
    JSONRPCRequest,
    Notification,
    Request,
    Result
} from '@modelcontextprotocol/core';
import { BaseContext } from '@modelcontextprotocol/core';

import type { Client } from './client.js';

/**
 * A context object that is passed to client-side request handlers.
 * Used when the client handles requests from the server (e.g., sampling, elicitation).
 */
export class ClientContext<
    RequestT extends Request = Request,
    NotificationT extends Notification = Notification,
    ResultT extends Result = Result
> extends BaseContext<ClientRequest | RequestT, ClientNotification | NotificationT, ClientResult | ResultT> {
    private readonly client: Client<RequestT, NotificationT, ResultT>;

    constructor(args: {
        sessionId?: string;
        request: JSONRPCRequest;
        mcpReq: Omit<ClientContext<ClientRequest | RequestT, ClientNotification | NotificationT, ClientResult | ResultT>['mcpReq'], 'send'>;
        http?: ClientContext<ClientRequest | RequestT, ClientNotification | NotificationT, ClientResult | ResultT>['http'];
        task: ClientContext<ClientRequest | RequestT, ClientNotification | NotificationT, ClientResult | ResultT>['task'];
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
