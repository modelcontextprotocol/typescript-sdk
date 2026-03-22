import { AuthInfo } from '@modelcontextprotocol/core';
import { AuthenticateRequest, Authenticator } from './authenticator.js';

/**
 * Validates a Bearer token.
 *
 * @param token - The Bearer token to validate.
 * @returns Information about the authenticated entity, or `undefined` if validation failed.
 */
export type BearerTokenValidator = (token: string) => Promise<AuthInfo | undefined>;

/**
 * An authenticator for the Bearer authentication scheme.
 */
export class BearerTokenAuthenticator implements Authenticator {
    /**
     * Creates a new `BearerTokenAuthenticator` with the given validator.
     *
     * @param _validator - Function to validate the Bearer token.
     */
    constructor(private readonly _validator: BearerTokenValidator) {}

    /**
     * Returns the name of the authentication scheme.
     */
    readonly scheme = 'Bearer';

    /**
     * Authenticates an incoming request by extracting the Bearer token from the `Authorization` header.
     *
     * @param request - Information about the request.
     * @returns Information about the authenticated entity, or `undefined` if authentication failed.
     */
    async authenticate(request: AuthenticateRequest): Promise<AuthInfo | undefined> {
        const authHeader = request.headers?.['authorization'];
        if (!authHeader) {
            return undefined;
        }

        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (!match) {
            return undefined;
        }

        const token = match[1];
        if (!token) {
            return undefined;
        }

        return await this._validator(token);
    }
}
