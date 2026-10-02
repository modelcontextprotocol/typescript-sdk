import type { RequestHandler, Response } from 'express';
import express from 'express';
import type { Options as RateLimitOptions } from 'express-rate-limit';
import { rateLimit } from 'express-rate-limit';
import * as z from 'zod/v4';

import { InvalidClientError, InvalidRequestError, OAuthError, ServerError, TooManyRequestsError } from '../errors';
import { allowedMethods } from '../middleware/allowedMethods';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- AuthorizationParams referenced in JSDoc {@linkcode}
import type { AuthorizationParams, OAuthServerProvider } from '../provider';

export type AuthorizationHandlerOptions = {
    provider: OAuthServerProvider;
    /**
     * The authorization server's issuer identifier. When set, the handler appends it as the
     * `iss` query parameter (RFC 9207) to any redirect — success or error — that targets the
     * client's validated `redirect_uri`, and also supplies it to the provider as
     * {@linkcode AuthorizationParams.issuer}. `mcpAuthRouter` always sets this from its
     * `issuerUrl`.
     */
    issuerUrl?: URL;
    /**
     * Rate limiting configuration for the authorization endpoint.
     * Set to false to disable rate limiting for this endpoint.
     */
    rateLimit?: Partial<RateLimitOptions> | false;
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validates a requested redirect_uri against a registered one.
 *
 * Per RFC 8252 §7.3 (OAuth 2.0 for Native Apps), authorization servers MUST
 * allow any port for loopback redirect URIs (localhost, 127.0.0.1, [::1]) to
 * accommodate native clients that obtain an ephemeral port from the OS. For
 * non-loopback URIs, exact match is required.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8252#section-7.3
 */
export function redirectUriMatches(requested: string, registered: string): boolean {
    if (requested === registered) {
        return true;
    }
    let req: URL, reg: URL;
    try {
        req = new URL(requested);
        reg = new URL(registered);
    } catch {
        return false;
    }
    // Port relaxation only applies when both URIs target a loopback host.
    if (!LOOPBACK_HOSTS.has(req.hostname) || !LOOPBACK_HOSTS.has(reg.hostname)) {
        return false;
    }
    // RFC 8252 relaxes the port only — scheme, host, path, and query must
    // still match exactly. Note: hostname must match exactly too (the RFC
    // does not allow localhost↔127.0.0.1 cross-matching).
    return req.protocol === reg.protocol && req.hostname === reg.hostname && req.pathname === reg.pathname && req.search === reg.search;
}

// Parameters that must be validated in order to issue redirects.
const ClientAuthorizationParamsSchema = z.object({
    client_id: z.string(),
    redirect_uri: z
        .string()
        .optional()
        .refine(value => value === undefined || URL.canParse(value), { message: 'redirect_uri must be a valid URL' })
});

// Parameters that must be validated for a successful authorization request. Failure can be reported to the redirect URI.
const RequestAuthorizationParamsSchema = z.object({
    response_type: z.literal('code'),
    code_challenge: z.string(),
    code_challenge_method: z.literal('S256'),
    scope: z.string().optional(),
    state: z.string().optional(),
    resource: z.string().url().optional()
});

export function authorizationHandler({ provider, issuerUrl, rateLimit: rateLimitConfig }: AuthorizationHandlerOptions): RequestHandler {
    const issuer = issuerUrl?.href;
    // Create a router to apply middleware
    const router = express.Router();
    router.use(allowedMethods(['GET', 'POST']));
    router.use(express.urlencoded({ extended: false }));

    // Apply rate limiting unless explicitly disabled
    if (rateLimitConfig !== false) {
        router.use(
            rateLimit({
                windowMs: 15 * 60 * 1000, // 15 minutes
                max: 100, // 100 requests per windowMs
                standardHeaders: true,
                legacyHeaders: false,
                message: new TooManyRequestsError('You have exceeded the rate limit for authorization requests').toResponseObject(),
                ...rateLimitConfig
            })
        );
    }

    router.all('/', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');

        // In the authorization flow, errors are split into two categories:
        // 1. Pre-redirect errors (direct response with 400)
        // 2. Post-redirect errors (redirect with error parameters)

        // Phase 1: Validate client_id and redirect_uri. Any errors here must be direct responses.
        let client_id, redirect_uri, client;
        try {
            const result = ClientAuthorizationParamsSchema.safeParse(req.method === 'POST' ? req.body : req.query);
            if (!result.success) {
                throw new InvalidRequestError(result.error.message);
            }

            client_id = result.data.client_id;
            redirect_uri = result.data.redirect_uri;

            client = await provider.clientsStore.getClient(client_id);
            if (!client) {
                throw new InvalidClientError('Invalid client_id');
            }

            if (redirect_uri !== undefined) {
                const requested = redirect_uri;
                if (!client.redirect_uris.some(registered => redirectUriMatches(requested, registered))) {
                    throw new InvalidRequestError('Unregistered redirect_uri');
                }
            } else if (client.redirect_uris.length === 1) {
                redirect_uri = client.redirect_uris[0];
            } else {
                throw new InvalidRequestError('redirect_uri must be specified when client has multiple registered URIs');
            }
        } catch (error) {
            // Pre-redirect errors - return direct response
            //
            // These don't need to be JSON encoded, as they'll be displayed in a user
            // agent, but OTOH they all represent exceptional situations (arguably,
            // "programmer error"), so presenting a nice HTML page doesn't help the
            // user anyway.
            if (error instanceof OAuthError) {
                const status = error instanceof ServerError ? 500 : 400;
                res.status(status).json(error.toResponseObject());
            } else {
                const serverError = new ServerError('Internal Server Error');
                res.status(500).json(serverError.toResponseObject());
            }

            return;
        }

        // Phase 2: Validate other parameters. Any errors here should go into redirect responses.
        let state;
        try {
            // Parse and validate authorization parameters
            const parseResult = RequestAuthorizationParamsSchema.safeParse(req.method === 'POST' ? req.body : req.query);
            if (!parseResult.success) {
                throw new InvalidRequestError(parseResult.error.message);
            }

            const { scope, code_challenge, resource } = parseResult.data;
            state = parseResult.data.state;

            // Validate scopes
            let requestedScopes: string[] = [];
            if (scope !== undefined) {
                requestedScopes = scope.split(' ');
            }

            // All validation passed, proceed with authorization. RFC 9207: the metadata
            // advertises `authorization_response_iss_parameter_supported`, so make that claim
            // true from SDK code by appending `iss` to whatever redirect the provider issues
            // back to the client's validated redirect_uri — the provider need not do anything.
            // Redirects elsewhere (e.g. to an upstream authorize endpoint) are left untouched.
            await provider.authorize(
                client,
                {
                    state,
                    scopes: requestedScopes,
                    redirectUri: redirect_uri!,
                    codeChallenge: code_challenge,
                    resource: resource ? new URL(resource) : undefined,
                    issuer
                },
                issuer ? withIssOnCallbackRedirect(res, redirect_uri!, issuer) : res
            );
        } catch (error) {
            // Post-redirect errors - redirect with error parameters
            if (error instanceof OAuthError) {
                res.redirect(302, createErrorRedirect(redirect_uri!, error, state, issuer));
            } else {
                const serverError = new ServerError('Internal Server Error');
                res.redirect(302, createErrorRedirect(redirect_uri!, serverError, state, issuer));
            }
        }
    });

    return router;
}

/**
 * Wraps `res.redirect` so that when the provider redirects to the client's validated
 * `redirect_uri` (i.e. the OAuth authorization response), `iss` is appended per RFC 9207.
 * Only redirects whose origin and path match `redirectUri` are touched; an `iss` already
 * set by the provider is preserved. This is what backs the
 * `authorization_response_iss_parameter_supported: true` metadata claim without requiring
 * `OAuthServerProvider.authorize()` implementations to change.
 */
function withIssOnCallbackRedirect(res: Response, redirectUri: string, issuer: string): Response {
    const cb = new URL(redirectUri);
    const appendIss = (url: string): string => {
        let target: URL;
        try {
            target = new URL(url);
        } catch {
            return url;
        }
        if (target.origin === cb.origin && target.pathname === cb.pathname && !target.searchParams.has('iss')) {
            target.searchParams.set('iss', issuer);
            return target.href;
        }
        return url;
    };
    const original = res.redirect.bind(res) as (...args: unknown[]) => void;
    res.redirect = ((statusOrUrl: number | string, maybeUrl?: string | number): void => {
        if (typeof statusOrUrl === 'number') original(statusOrUrl, appendIss(String(maybeUrl)));
        // Express 4 still accepts the deprecated reversed form `res.redirect(url, status)`.
        else if (typeof maybeUrl === 'number') original(appendIss(statusOrUrl), maybeUrl);
        else original(appendIss(statusOrUrl));
    }) as Response['redirect'];
    return res;
}

/**
 * Helper function to create redirect URL with error parameters
 */
function createErrorRedirect(redirectUri: string, error: OAuthError, state?: string, issuer?: string): string {
    const errorUrl = new URL(redirectUri);
    errorUrl.searchParams.set('error', error.errorCode);
    errorUrl.searchParams.set('error_description', error.message);
    if (error.errorUri) {
        errorUrl.searchParams.set('error_uri', error.errorUri);
    }
    if (state) {
        errorUrl.searchParams.set('state', state);
    }
    if (issuer) {
        // RFC 9207 §2: the iss parameter is required on error responses too.
        errorUrl.searchParams.set('iss', issuer);
    }
    return errorUrl.href;
}
