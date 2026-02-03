import type { AuthInfo } from './types.js';

/**
 * Extra information about a message.
 */
export interface MessageExtraInfo {
    /**
     * The raw Request object (fetch API Request).
     * Provides access to url, headers, and other request properties.
     */
    request?: Request;

    /**
     * The authentication information.
     */
    authInfo?: AuthInfo;

    /**
     * Callback to close the SSE stream for this request, triggering client reconnection.
     * Only available when using NodeStreamableHTTPServerTransport with eventStore configured.
     */
    closeSSEStream?: () => void;

    /**
     * Callback to close the standalone GET SSE stream, triggering client reconnection.
     * Only available when using NodeStreamableHTTPServerTransport with eventStore configured.
     */
    closeStandaloneSSEStream?: () => void;
}
