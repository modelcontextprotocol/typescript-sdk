import type { AuthInfo, JSONRPCRequest, RequestId } from '@modelcontextprotocol/core-internal';

/** One scope check within an authorization option. */
export interface ScopeRequirement {
    /** Scope requested when none of this check's scopes are present. */
    challenge: string;
    /** Other exact scopes that satisfy this check. */
    anyOf: string[];
}

/** One named way to authorize a tool call. Every `allOf` entry must match. */
export interface ScopePath {
    name: string;
    allOf: ScopeRequirement[];
}

/**
 * Selects the authorization paths that apply to a request. Return `undefined`
 * to defer malformed or incomplete arguments to normal input validation.
 */
export type ScopePathSelector = (request: JSONRPCRequest) => readonly string[] | undefined;

/** Alternative ways to authorize a tool call. */
export interface ToolScopePolicy {
    /** The first applicable path is used to build a challenge. */
    anyOf: ScopePath[];
    /** Optionally restrict the paths that apply to a request. */
    select?: ScopePathSelector;
}

/** A string array requires every listed scope. */
export type ToolScopeConfig = string[] | ToolScopePolicy;

/** Configuration for HTTP `insufficient_scope` challenges. */
export interface ScopeChallengeConfig {
    /** URL of the RFC 9728 protected resource metadata. */
    resourceMetadataUrl: string;
    /** Customizes the challenge's human-readable error description. */
    buildErrorDescription?: (toolName: string, challengeScopes: string[], pathName: string) => string;
}

/** Returns the scope policy for a parsed request, when one applies. */
export type ScopeResolver = (request: JSONRPCRequest) => ToolScopePolicy | undefined;

/** @internal */
export function supportsScopeResolver(transport: unknown): transport is { setScopeResolver(resolver: ScopeResolver): void } {
    return (
        typeof transport === 'object' &&
        transport !== null &&
        'setScopeResolver' in transport &&
        typeof (transport as { setScopeResolver: unknown }).setScopeResolver === 'function'
    );
}

function assertScope(scope: unknown, location: string): asserts scope is string {
    if (typeof scope !== 'string' || scope.length === 0 || /\s/.test(scope)) {
        throw new TypeError(`${location} must be a non-empty OAuth scope without whitespace`);
    }
}

/** @internal */
export function normalizeToolScopePolicy(config: ToolScopeConfig): ToolScopePolicy {
    if (Array.isArray(config)) {
        const allOf = config.map((scope, index) => {
            assertScope(scope, `scopes[${index}]`);
            return { challenge: scope, anyOf: [] };
        });
        return { anyOf: [{ name: 'default', allOf }] };
    }

    if (config === null || typeof config !== 'object' || !Array.isArray(config.anyOf) || config.anyOf.length === 0) {
        throw new TypeError('scope policy must declare at least one anyOf path');
    }
    if (config.select !== undefined && typeof config.select !== 'function') {
        throw new TypeError('scope policy selector must be a function');
    }

    const names = new Set<string>();
    const anyOf = config.anyOf.map((path, pathIndex): ScopePath => {
        if (path === null || typeof path !== 'object' || typeof path.name !== 'string' || path.name.length === 0) {
            throw new TypeError(`scope policy path at index ${pathIndex} must have a non-empty name`);
        }
        if (names.has(path.name)) {
            throw new TypeError(`scope policy path name '${path.name}' is duplicated`);
        }
        names.add(path.name);
        if (!Array.isArray(path.allOf)) {
            throw new TypeError(`scope policy path '${path.name}' must declare allOf`);
        }

        const allOf = path.allOf.map((requirement, requirementIndex): ScopeRequirement => {
            if (requirement === null || typeof requirement !== 'object') {
                throw new TypeError(`scope allOf entry ${requirementIndex} in path '${path.name}' must be an object`);
            }
            assertScope(requirement.challenge, `challenge for allOf entry ${requirementIndex} in path '${path.name}'`);
            if (!Array.isArray(requirement.anyOf)) {
                throw new TypeError(`anyOf for allOf entry ${requirementIndex} in path '${path.name}' must be an array`);
            }
            for (const [scopeIndex, scope] of requirement.anyOf.entries()) {
                assertScope(scope, `anyOf[${scopeIndex}] for allOf entry ${requirementIndex} in path '${path.name}'`);
            }
            return {
                challenge: requirement.challenge,
                anyOf: [...new Set(requirement.anyOf.filter(scope => scope !== requirement.challenge))]
            };
        });
        return { name: path.name, allOf };
    });

    return { anyOf, ...(config.select !== undefined && { select: config.select }) };
}

/** @internal */
export function evaluateScopePolicy(
    policy: ToolScopePolicy,
    activeScopes: readonly string[],
    request: JSONRPCRequest
): { kind: 'allow'; pathName: string } | { kind: 'challenge'; pathName: string; scopes: string[] } | { kind: 'skip' } {
    const selectedNames = policy.select?.(request);
    if (selectedNames === undefined && policy.select !== undefined) {
        return { kind: 'skip' };
    }
    if (selectedNames !== undefined && (!Array.isArray(selectedNames) || selectedNames.length === 0)) {
        throw new TypeError('scope path selector must return at least one declared path name or undefined');
    }

    const selected = new Set(selectedNames ?? policy.anyOf.map(path => path.name));
    for (const name of selected) {
        if (!policy.anyOf.some(path => path.name === name)) {
            throw new TypeError(`scope path selector returned unknown path '${name}'`);
        }
    }
    const selectedPaths = policy.anyOf.filter(path => selected.has(path.name));
    const active = new Set(activeScopes);
    const heldScope = (requirement: ScopeRequirement): string | undefined =>
        [requirement.challenge, ...requirement.anyOf].find(scope => active.has(scope));

    for (const path of selectedPaths) {
        if (path.allOf.every(requirement => heldScope(requirement) !== undefined)) {
            return { kind: 'allow', pathName: path.name };
        }
    }

    const challengedPath = selectedPaths[0]!;
    const concreteScopes = challengedPath.allOf.map(requirement => heldScope(requirement) ?? requirement.challenge);
    return { kind: 'challenge', pathName: challengedPath.name, scopes: [...new Set(concreteScopes)] };
}

/** @internal */
export function findScopeChallenge(
    requests: readonly JSONRPCRequest[],
    authInfo: AuthInfo | undefined,
    resolve: ScopeResolver
): { toolName: string; pathName: string; scopes: string[]; requestId: RequestId } | undefined {
    // The auth middleware decides whether authentication is required.
    if (authInfo === undefined) return undefined;

    for (const request of requests) {
        if (request.method !== 'tools/call') continue;
        const toolName = (request.params as { name?: unknown } | undefined)?.name;
        if (typeof toolName !== 'string') continue;
        const policy = resolve(request);
        if (policy === undefined) continue;
        const decision = evaluateScopePolicy(policy, authInfo.scopes, request);
        if (decision.kind === 'challenge') {
            return {
                toolName,
                pathName: decision.pathName,
                scopes: decision.scopes,
                requestId: request.id
            };
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
    challenge: { toolName: string; pathName: string; scopes: string[]; requestId: RequestId },
    responseId: RequestId | null = challenge.requestId
): Response {
    const description = config.buildErrorDescription
        ? config.buildErrorDescription(challenge.toolName, challenge.scopes, challenge.pathName)
        : `Additional scopes required for ${challenge.pathName}: ${challenge.scopes.join(', ')}`;
    const wwwAuthenticate =
        `Bearer error="insufficient_scope"` +
        `, scope="${quoteAuthParam(challenge.scopes.join(' '))}"` +
        `, resource_metadata="${quoteAuthParam(config.resourceMetadataUrl)}"` +
        `, error_description="${quoteAuthParam(description)}"`;

    return Response.json(
        {
            jsonrpc: '2.0',
            error: { code: -32_600, message: `Insufficient scope for tool: ${challenge.toolName}` },
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
