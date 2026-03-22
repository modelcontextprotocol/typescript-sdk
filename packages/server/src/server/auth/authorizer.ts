import { AuthInfo } from '@modelcontextprotocol/core';

/**
 * Validates if the given `AuthInfo` has the required scopes.
 */
export class Authorizer {
    /**
     * Checks if the authenticated entity is authorized based on required scopes.
     *
     * @param authInfo - Information about the authenticated entity.
     * @param requiredScopes - Scopes required for the operation.
     * @returns `true` if authorized, `false` otherwise.
     */
    static isAuthorized(authInfo: AuthInfo | undefined, requiredScopes: string[] | undefined): boolean {
        if (!requiredScopes || requiredScopes.length === 0) {
            return true;
        }

        if (!authInfo || !authInfo.scopes) {
            return false;
        }

        // All required scopes must be present in the authInfo's scopes.
        return requiredScopes.every(scope => authInfo.scopes?.includes(scope));
    }
}
