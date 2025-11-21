/**
 * Experimental client features.
 *
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @module experimental
 */

import { ElicitationCompleteNotificationSchema, type ElicitationCompleteNotification } from '../types.js';
import type { AnyObjectSchema } from '../server/zod-compat.js';

/**
 * Handler for URL elicitation completion notifications.
 */
export type ElicitationCompleteHandler = (notification: ElicitationCompleteNotification) => void;

/**
 * Interface for the client methods used by experimental features.
 * @internal
 */
interface ClientLike {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setNotificationHandler<T extends AnyObjectSchema>(schema: T, handler: (notification: any) => void): void;
}

/**
 * Experimental client features for MCP.
 *
 * Access via `client.experimental`.
 *
 * WARNING: These APIs are experimental and may change without notice.
 */
export class ExperimentalClientFeatures {
    constructor(private client: ClientLike) {}

    /**
     * Sets a handler for URL elicitation completion notifications.
     *
     * When a server completes an out-of-band URL elicitation interaction,
     * it sends a `notifications/elicitation/complete` notification.
     * This handler allows the client to react programmatically.
     *
     * @experimental This API may change without notice.
     * @param handler The handler function to call when a completion notification is received.
     */
    setElicitationCompleteHandler(handler: ElicitationCompleteHandler): void {
        this.client.setNotificationHandler(ElicitationCompleteNotificationSchema, handler);
    }
}
