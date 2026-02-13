/**
 * Cross-App Access utilities for the Identity Assertion Authorization Grant flow.
 *
 * Provides standalone functions for RFC 8693 Token Exchange (ID token → JAG).
 * Used by {@link CrossAppAccessProvider} and available for direct use.
 */

import type { FetchLike } from '@modelcontextprotocol/core';

import { discoverAuthorizationServerMetadata } from './auth.js';

/**
 * Options for requesting a JWT Authorization Grant from an Identity Provider.
 */
export interface RequestJwtAuthGrantOptions {
    /** The IDP's token endpoint URL. */
    tokenEndpoint: string;
    /** The MCP authorization server URL (used as the `audience` parameter). */
    audience: string;
    /** The MCP resource server URL (used as the `resource` parameter). */
    resource: string;
    /** The OIDC ID token to exchange. */
    idToken: string;
    /** Client ID for authentication with the IDP. */
    clientId: string;
    /** Client secret for authentication with the IDP. */
    clientSecret?: string;
    /** Optional scopes to request. */
    scope?: string;
    /** Optional fetch function for HTTP requests. */
    fetchFn?: FetchLike;
}

/**
 * Requests a JWT Authorization Grant (JAG) from an Identity Provider via
 * RFC 8693 Token Exchange. Returns the JAG to be used as a JWT Bearer
 * assertion (RFC 7523) against the MCP authorization server.
 */
export async function requestJwtAuthorizationGrant(options: RequestJwtAuthGrantOptions): Promise<string> {
    const effectiveFetch = options.fetchFn ?? fetch;

    const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
        subject_token: options.idToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        audience: options.audience,
        resource: options.resource,
        client_id: options.clientId,
        ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
        ...(options.scope ? { scope: options.scope } : {})
    });

    const response = await effectiveFetch(options.tokenEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
        },
        body
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`JWT Authorization Grant request failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (typeof data.access_token !== 'string' || !data.access_token) {
        throw new Error('Token exchange response missing access_token');
    }
    if (data.issued_token_type !== 'urn:ietf:params:oauth:token-type:id-jag') {
        throw new Error(`Expected issued_token_type 'urn:ietf:params:oauth:token-type:id-jag', got '${data.issued_token_type}'`);
    }
    if (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'n_a') {
        throw new Error(`Expected token_type 'n_a', got '${data.token_type}'`);
    }

    return data.access_token;
}

/**
 * Options for discovering and requesting a JWT Authorization Grant.
 * Extends {@link RequestJwtAuthGrantOptions} but replaces `tokenEndpoint`
 * with `idpUrl` / `idpTokenEndpoint` for automatic discovery.
 */
export interface DiscoverAndRequestJwtAuthGrantOptions extends Omit<RequestJwtAuthGrantOptions, 'tokenEndpoint'> {
    /** Identity Provider's base URL for OAuth/OIDC discovery. */
    idpUrl: string;
    /** IDP token endpoint URL. When provided, skips IDP metadata discovery. */
    idpTokenEndpoint?: string;
}

/**
 * Discovers the IDP's token endpoint via metadata, then requests a JAG.
 * Convenience wrapper over {@link requestJwtAuthorizationGrant}.
 */
export async function discoverAndRequestJwtAuthGrant(options: DiscoverAndRequestJwtAuthGrantOptions): Promise<string> {
    const { idpUrl, idpTokenEndpoint, ...rest } = options;

    let tokenEndpoint = idpTokenEndpoint;

    if (!tokenEndpoint) {
        try {
            const idpMetadata = await discoverAuthorizationServerMetadata(idpUrl, { fetchFn: options.fetchFn });
            tokenEndpoint = idpMetadata?.token_endpoint;
        } catch {
            // Discovery failed — fall back to idpUrl
        }
    }

    return requestJwtAuthorizationGrant({
        ...rest,
        tokenEndpoint: tokenEndpoint ?? idpUrl
    });
}
