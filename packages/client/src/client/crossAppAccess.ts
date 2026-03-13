/**
 * Cross-App Access (Enterprise Managed Authorization) Layer 2 utilities.
 *
 * Provides standalone functions for RFC 8693 Token Exchange and RFC 7523 JWT Authorization Grant
 * flows as specified in the Enterprise Managed Authorization specification (SEP-990).
 *
 * @see https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/draft/enterprise-managed-authorization.mdx
 * @module
 */

import type { FetchLike } from '@modelcontextprotocol/core';
import { IdJagTokenExchangeResponseSchema, OAuthErrorResponseSchema, OAuthTokensSchema } from '@modelcontextprotocol/core';

import type { ClientAuthMethod } from './auth.js';
import { applyClientAuthentication, discoverAuthorizationServerMetadata } from './auth.js';

/**
 * Options for requesting a JWT Authorization Grant via RFC 8693 Token Exchange.
 */
export interface RequestJwtAuthGrantOptions {
    /**
     * The IdP's token endpoint URL where the token exchange request will be sent.
     */
    tokenEndpoint: string | URL;

    /**
     * The authorization server URL of the target MCP server (used as `audience` in the token exchange request).
     */
    audience: string | URL;

    /**
     * The resource identifier of the target MCP server (RFC 9728).
     */
    resource: string | URL;

    /**
     * The identity assertion (ID Token) from the enterprise IdP.
     * This should be the OpenID Connect ID Token obtained during user authentication.
     */
    idToken: string;

    /**
     * The client ID registered with the IdP for token exchange.
     */
    clientId: string;

    /**
     * The client secret for authenticating with the IdP.
     *
     * Optional: the IdP may register the MCP client as a public client. RFC 8693 does
     * not mandate confidential clients for token exchange. Omitting this parameter
     * omits `client_secret` from the request body.
     */
    clientSecret?: string;

    /**
     * Optional space-separated list of scopes to request for the target MCP server.
     */
    scope?: string;

    /**
     * Custom fetch implementation. Defaults to global fetch.
     */
    fetchFn?: FetchLike;
}

/**
 * Options for discovering the IdP's token endpoint and requesting a JWT Authorization Grant.
 * Extends {@linkcode RequestJwtAuthGrantOptions} with IdP discovery.
 */
export interface DiscoverAndRequestJwtAuthGrantOptions extends Omit<RequestJwtAuthGrantOptions, 'tokenEndpoint'> {
    /**
     * The IdP's issuer URL for OAuth metadata discovery.
     * Will be used to discover the token endpoint via `.well-known/oauth-authorization-server`.
     */
    idpUrl: string | URL;
}

/**
 * Result from a successful JWT Authorization Grant token exchange.
 */
export interface JwtAuthGrantResult {
    /**
     * The JWT Authorization Grant (ID-JAG) that can be used to request an access token from the MCP server.
     */
    jwtAuthGrant: string;

    /**
     * Optional expiration time in seconds for the JWT Authorization Grant.
     */
    expiresIn?: number;

    /**
     * Optional scope granted by the IdP (may differ from requested scope).
     */
    scope?: string;
}

/**
 * Requests a JWT Authorization Grant (ID-JAG) from an enterprise IdP using RFC 8693 Token Exchange.
 *
 * This function performs step 2 of the Enterprise Managed Authorization flow:
 * exchanges an ID Token for a JWT Authorization Grant that can be used with the target MCP server.
 *
 * @param options - Configuration for the token exchange request
 * @returns The JWT Authorization Grant and related metadata
 * @throws {Error} If the token exchange fails or returns an error response
 *
 * @example
 * ```ts
 * const result = await requestJwtAuthorizationGrant({
 *     tokenEndpoint: 'https://idp.example.com/token',
 *     audience: 'https://auth.chat.example/',
 *     resource: 'https://mcp.chat.example/',
 *     idToken: 'eyJhbGciOiJS...',
 *     clientId: 'my-idp-client',
 *     clientSecret: 'my-idp-secret',
 *     scope: 'chat.read chat.history'
 * });
 *
 * // Use result.jwtAuthGrant with the MCP server's authorization server
 * ```
 */
export async function requestJwtAuthorizationGrant(options: RequestJwtAuthGrantOptions): Promise<JwtAuthGrantResult> {
    const { tokenEndpoint, audience, resource, idToken, clientId, clientSecret, scope, fetchFn = fetch } = options;

    // Prepare token exchange request per RFC 8693
    const params = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
        audience: String(audience),
        resource: String(resource),
        subject_token: idToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        client_id: clientId
    });

    // Only include client_secret when provided — sending an empty/undefined secret
    // triggers `invalid_client` on strict IdPs that registered this as a public client.
    if (clientSecret) {
        params.set('client_secret', clientSecret);
    }

    if (scope) {
        params.set('scope', scope);
    }

    const response = await fetchFn(String(tokenEndpoint), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
    });

    if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));

        // Try to parse as OAuth error response
        const parseResult = OAuthErrorResponseSchema.safeParse(errorBody);
        if (parseResult.success) {
            const { error, error_description } = parseResult.data;
            throw new Error(`Token exchange failed: ${error}${error_description ? ` - ${error_description}` : ''}`);
        }

        throw new Error(`Token exchange failed with status ${response.status}: ${JSON.stringify(errorBody)}`);
    }

    const parseResult = IdJagTokenExchangeResponseSchema.safeParse(await response.json());
    if (!parseResult.success) {
        throw new Error(`Invalid token exchange response: ${parseResult.error.message}`);
    }

    return {
        jwtAuthGrant: parseResult.data.access_token,
        expiresIn: parseResult.data.expires_in,
        scope: parseResult.data.scope
    };
}

/**
 * Discovers the IdP's token endpoint and requests a JWT Authorization Grant.
 *
 * This is a convenience wrapper around {@linkcode requestJwtAuthorizationGrant} that
 * first performs OAuth metadata discovery to find the token endpoint.
 *
 * @param options - Configuration including IdP URL for discovery
 * @returns The JWT Authorization Grant and related metadata
 * @throws {Error} If discovery fails or the token exchange fails
 *
 * @example
 * ```ts
 * const result = await discoverAndRequestJwtAuthGrant({
 *     idpUrl: 'https://idp.example.com',
 *     audience: 'https://auth.chat.example/',
 *     resource: 'https://mcp.chat.example/',
 *     idToken: await getIdToken(),
 *     clientId: 'my-idp-client',
 *     clientSecret: 'my-idp-secret'
 * });
 * ```
 */
export async function discoverAndRequestJwtAuthGrant(options: DiscoverAndRequestJwtAuthGrantOptions): Promise<JwtAuthGrantResult> {
    const { idpUrl, fetchFn = fetch, ...restOptions } = options;

    // Discover IdP's authorization server metadata
    const metadata = await discoverAuthorizationServerMetadata(String(idpUrl), { fetchFn });

    if (!metadata?.token_endpoint) {
        throw new Error(`Failed to discover token endpoint for IdP: ${idpUrl}`);
    }

    // Perform token exchange
    return requestJwtAuthorizationGrant({
        ...restOptions,
        tokenEndpoint: metadata.token_endpoint,
        fetchFn
    });
}

/**
 * Exchanges a JWT Authorization Grant for an access token at the MCP server's authorization server.
 *
 * This function performs step 3 of the Enterprise Managed Authorization flow:
 * uses the JWT Authorization Grant to obtain an access token from the MCP server.
 *
 * @param options - Configuration for the JWT grant exchange
 * @returns OAuth tokens (access token, token type, etc.)
 * @throws {Error} If the exchange fails or returns an error response
 *
 * Defaults to `client_secret_basic` (HTTP Basic Authorization header), matching
 * `CrossAppAccessProvider`'s declared `token_endpoint_auth_method` and the
 * SEP-990 conformance test requirements. Use `authMethod: 'client_secret_post'` only
 * when the authorization server explicitly requires it.
 *
 * @example
 * ```ts
 * const tokens = await exchangeJwtAuthGrant({
 *     tokenEndpoint: 'https://auth.chat.example/token',
 *     jwtAuthGrant: 'eyJhbGci...',
 *     clientId: 'my-mcp-client',
 *     clientSecret: 'my-mcp-secret'
 * });
 *
 * // Use tokens.access_token to access the MCP server
 * ```
 */
export async function exchangeJwtAuthGrant(options: {
    tokenEndpoint: string | URL;
    jwtAuthGrant: string;
    clientId: string;
    clientSecret?: string;
    /**
     * Client authentication method. Defaults to `'client_secret_basic'` to align with
     * `CrossAppAccessProvider` and SEP-990 conformance requirements.
     * Callers with no `clientSecret` should pass `'none'` for public-client auth.
     */
    authMethod?: ClientAuthMethod;
    fetchFn?: FetchLike;
}): Promise<{ access_token: string; token_type: string; expires_in?: number; scope?: string }> {
    const { tokenEndpoint, jwtAuthGrant, clientId, clientSecret, authMethod = 'client_secret_basic', fetchFn = fetch } = options;

    // Prepare JWT bearer grant request per RFC 7523
    const params = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwtAuthGrant
    });

    const headers = new Headers({
        'Content-Type': 'application/x-www-form-urlencoded'
    });

    applyClientAuthentication(authMethod, { client_id: clientId, client_secret: clientSecret }, headers, params);

    const response = await fetchFn(String(tokenEndpoint), {
        method: 'POST',
        headers,
        body: params.toString()
    });

    if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));

        // Try to parse as OAuth error response
        const parseResult = OAuthErrorResponseSchema.safeParse(errorBody);
        if (parseResult.success) {
            const { error, error_description } = parseResult.data;
            throw new Error(`JWT grant exchange failed: ${error}${error_description ? ` - ${error_description}` : ''}`);
        }

        throw new Error(`JWT grant exchange failed with status ${response.status}: ${JSON.stringify(errorBody)}`);
    }

    const responseBody = await response.json();

    // Validate response using core schema
    const parseResult = OAuthTokensSchema.safeParse(responseBody);
    if (!parseResult.success) {
        throw new Error(`Invalid token response: ${parseResult.error.message}`);
    }

    return parseResult.data;
}
