import type { AuthInfo, JSONRPCRequest, RequestId } from '@modelcontextprotocol/core-internal';

/** OAuth scopes to request before handling an MCP request. */
export interface ScopeChallenge {
    /** The exact, complete scope set to include in the challenge. Each scope must be printable ASCII without whitespace. */
    scopes: readonly [string, ...string[]];
    /** Optional printable-ASCII human-readable detail for the OAuth challenge. */
    errorDescription?: string;
}

/** Determines whether an MCP request needs an OAuth scope challenge. */
export type ScopeChallengeHandler = (context: {
    request: JSONRPCRequest;
    authInfo?: AuthInfo;
}) => ScopeChallenge | undefined | Promise<ScopeChallenge | undefined>;

/** Configuration for HTTP `insufficient_scope` challenges. */
export interface ScopeChallengeConfig {
    /** URL of the RFC 9728 protected resource metadata. */
    resourceMetadataUrl: string;
}

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
    if (typeof scope !== 'string' || !/^[\u0021-\u007E]+$/.test(scope)) {
        throw new TypeError(`${location} must be a non-empty printable ASCII OAuth scope without whitespace`);
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
    if (challenge.errorDescription !== undefined && !/^[\u0020-\u007E]*$/.test(challenge.errorDescription)) {
        throw new TypeError('scope challenge errorDescription must contain only printable ASCII characters');
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

function quoteAuthParam(value: string): string {
    return value.replaceAll('\\', '\\\\').replaceAll('"', String.raw`\"`);
}

/** @internal */
export function createScopeChallengeResponse(
    config: ScopeChallengeConfig,
    challenge: ScopeChallenge,
    responseId: RequestId | null
): Response {
    const wwwAuthenticate =
        'Bearer' +
        ' error="insufficient_scope"' +
        `, scope="${quoteAuthParam(challenge.scopes.join(' '))}"` +
        `, resource_metadata="${quoteAuthParam(config.resourceMetadataUrl)}"` +
        (challenge.errorDescription === undefined ? '' : `, error_description="${quoteAuthParam(challenge.errorDescription)}"`);

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
