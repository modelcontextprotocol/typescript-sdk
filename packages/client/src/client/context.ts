import type { BaseContext, ClientNotification, ClientRequest, Notification, Request } from '@modelcontextprotocol/core';

/**
 * Client-specific context type for request handlers.
 * Used when the client handles requests from the server (e.g., sampling, elicitation).
 *
 * @typeParam RequestT - Additional request types beyond ClientRequest
 * @typeParam NotificationT - Additional notification types beyond ClientNotification
 */
export type ClientContext<RequestT extends Request = Request, NotificationT extends Notification = Notification> = BaseContext<
    ClientRequest | RequestT,
    ClientNotification | NotificationT
>;
