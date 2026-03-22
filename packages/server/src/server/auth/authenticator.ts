import { AuthInfo, RequestId } from '@modelcontextprotocol/core';

/**
 * Interface for authenticating MCP requests.
 */
export interface Authenticator {
    /**
     * Authenticates an incoming request.
     *
     * @param request - Information about the request being made, including headers if available.
     * @returns Information about the authenticated entity, or `undefined` if authentication failed.
     */
    authenticate(request: AuthenticateRequest): Promise<AuthInfo | undefined>;

    /**
     * Returns the name of the authentication scheme (e.g., 'Bearer').
     */
    readonly scheme: string;
}

/**
 * Information provided to authenticators to validate a request.
 */
export interface AuthenticateRequest {
    /**
     * The JSON-RPC ID of the request.
     */
    requestId?: RequestId;

    /**
     * The method being called.
     */
    method?: string;

    /**
     * Any headers associated with the request (e.g., from an HTTP transport).
     */
    headers?: Record<string, string>;
}
