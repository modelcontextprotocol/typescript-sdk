/**
 * Experimental server features.
 *
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @module experimental
 */

import type { NotificationOptions, RequestOptions } from '../shared/protocol.js';
import type { ElicitRequestURLParams, ElicitResult } from '../types.js';

/**
 * Interface for the server methods used by experimental features.
 * @internal
 */
interface ServerLike {
    elicitInput(params: ElicitRequestURLParams, options?: RequestOptions): Promise<ElicitResult>;
    createElicitationCompletionNotifier(elicitationId: string, options?: NotificationOptions): () => Promise<void>;
}

/**
 * Experimental server features for MCP.
 *
 * Access via `server.experimental`.
 *
 * WARNING: These APIs are experimental and may change without notice.
 */
export class ExperimentalServerFeatures {
    constructor(private server: ServerLike) {}

    /**
     * Creates a URL elicitation request.
     *
     * URL mode elicitation enables servers to direct users to external URLs
     * for out-of-band interactions that must not pass through the MCP client.
     * This is essential for auth flows, payment processing, and other sensitive operations.
     *
     * @experimental This API may change without notice.
     * @param params The URL elicitation parameters including url, message, and elicitationId.
     * @param options Optional request options.
     * @returns The result of the elicitation request.
     */
    async elicitUrl(params: ElicitRequestURLParams, options?: RequestOptions): Promise<ElicitResult> {
        return this.server.elicitInput(params, options);
    }

    /**
     * Creates a reusable callback that, when invoked, will send a `notifications/elicitation/complete`
     * notification for the specified elicitation ID.
     *
     * @experimental This API may change without notice.
     * @param elicitationId The ID of the elicitation to mark as complete.
     * @param options Optional notification options.
     * @returns A function that emits the completion notification when awaited.
     */
    createElicitationCompleteNotifier(elicitationId: string, options?: NotificationOptions): () => Promise<void> {
        return this.server.createElicitationCompletionNotifier(elicitationId, options);
    }
}
