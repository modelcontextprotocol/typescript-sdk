import type { AuthInfo, JSONRPCRequest, RequestId } from '@modelcontextprotocol/core-internal';

import { buildWwwAuthenticateHeader } from './middleware/bearerAuth';
import { getOAuthProtectedResourceMetadataUrl } from './middleware/oauthMetadata';

/** OAuth scopes to request before handling an MCP request. */
export interface ScopeChallenge {
    /** The exact, complete scope set to include in the challenge. Each scope must satisfy the OAuth `scope-token` grammar. */
    scopes: readonly [string, ...string[]];
    /** Optional human-readable detail satisfying the RFC 6750 `error-description` grammar. */
    errorDescription?: string;
}

/** Determines whether an MCP request needs an OAuth scope challenge. */
export type ScopeChallengeHandler = (context: {
    request: JSONRPCRequest;
    authInfo?: AuthInfo;
}) => ScopeChallenge | undefined | Promise<ScopeChallenge | undefined>;

/** @internal */
export function supportsScopeChallengeResolver(
    transport: unknown
): transport is { setScopeChallengeResolver(resolver: ScopeChallengeHandler): void } {
    return (
        typeof transport === 'object' &&
        transport !== null &&
        'setScopeChallengeResolver' in transport &&
        typeof (transport as { setScopeChallengeResolver: unknown }).setScopeChallengeResolver === 'function'
    );
}

function assertScope(scope: unknown, location: string): asserts scope is string {
    if (typeof scope !== 'string' || !/^[\u0021\u0023-\u005B\u005D-\u007E]+$/.test(scope)) {
        throw new TypeError(`${location} must satisfy the OAuth scope-token grammar`);
    }
}

function validateScopeChallenge(challenge: ScopeChallenge): ScopeChallenge {
    if (challenge === null || typeof challenge !== 'object' || !Array.isArray(challenge.scopes) || challenge.scopes.length === 0) {
        throw new TypeError('scope challenge must contain at least one scope');
    }
    for (const [index, scope] of challenge.scopes.entries()) {
        assertScope(scope, `scope challenge scopes[${index}]`);
    }
    if (challenge.errorDescription !== undefined && typeof challenge.errorDescription !== 'string') {
        throw new TypeError('scope challenge errorDescription must be a string');
    }
    if (challenge.errorDescription !== undefined && !/^[\u0020-\u0021\u0023-\u005B\u005D-\u007E]+$/.test(challenge.errorDescription)) {
        throw new TypeError('scope challenge errorDescription must satisfy the RFC 6750 error-description grammar');
    }
    return challenge;
}

/**
 * Creates a handler that requires every supplied scope exactly.
 *
 * Requests without authentication are left to the server's authentication gate.
 */
export function requireScopes(...scopes: readonly [string, ...string[]]): ScopeChallengeHandler {
    if (scopes.length === 0) {
        throw new TypeError('requireScopes must contain at least one scope');
    }
    for (const [index, scope] of scopes.entries()) {
        assertScope(scope, `requireScopes scope[${index}]`);
    }
    const requiredScopes = [...scopes] as [string, ...string[]];
    return ({ authInfo }) => {
        if (authInfo === undefined) return;
        const activeScopes = new Set(authInfo.scopes);
        if (requiredScopes.every(scope => activeScopes.has(scope))) return;
        return { scopes: requiredScopes };
    };
}

/** @internal */
export async function findScopeChallenge(
    requests: readonly JSONRPCRequest[],
    authInfo: AuthInfo | undefined,
    resolve: ScopeChallengeHandler
): Promise<{ challenge: ScopeChallenge; requestId: RequestId } | undefined> {
    for (const request of requests) {
        const challenge = await resolve({ request, ...(authInfo !== undefined && { authInfo }) });
        if (challenge !== undefined) {
            return { challenge: validateScopeChallenge(challenge), requestId: request.id };
        }
    }
    return undefined;
}

/**
 * The RFC 9728 Protected Resource Metadata URL to advertise on a scope
 * challenge, derived from the verified {@link AuthInfo}: the URL the
 * authentication gate stamped (`authInfo.resourceMetadataUrl`, set by the
 * bearer-auth helpers from their `resourceMetadataUrl` option), falling back
 * to the well-known location for an HTTP(S) RFC 8707 `resource` identifier, or
 * `undefined` when neither is available (the `resource_metadata` parameter is
 * then omitted, matching the bearer-auth challenges).
 *
 * @internal
 */
export function scopeChallengeResourceMetadataUrl(authInfo: AuthInfo | undefined): string | undefined {
    if (authInfo?.resourceMetadataUrl !== undefined) {
        return authInfo.resourceMetadataUrl;
    }
    if (authInfo?.resource?.protocol === 'https:' || authInfo?.resource?.protocol === 'http:') {
        return getOAuthProtectedResourceMetadataUrl(authInfo.resource);
    }
    return undefined;
}

/** @internal */
export function createScopeChallengeResponse(
    challenge: ScopeChallenge,
    responseId: RequestId | null,
    resourceMetadataUrl: string | undefined
): Response {
    // One formatter for every challenge this package emits: identical
    // parameter order and quoting to the bearer-auth 401/403 answers.
    const wwwAuthenticate = buildWwwAuthenticateHeader(
        'insufficient_scope',
        challenge.errorDescription ?? 'Insufficient scope',
        challenge.scopes,
        resourceMetadataUrl
    );

    return Response.json(
        {
            jsonrpc: '2.0',
            error: { code: -32_600, message: 'Insufficient scope' },
            id: responseId
        },
        {
            status: 403,
            headers: {
                'Content-Type': 'application/json',
                'WWW-Authenticate': wwwAuthenticate
            }
        }
    );
}
