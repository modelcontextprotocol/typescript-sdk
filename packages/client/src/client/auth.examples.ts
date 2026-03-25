/**
 * Type-checked examples for `auth.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import type { AuthorizationServerMetadata } from '@modelcontextprotocol/core';

import type { OAuthClientProvider } from './auth.js';
import { fetchToken } from './auth.js';

/**
 * Base class providing no-op implementations of required OAuthClientProvider methods.
 * Used as a base for concise examples that focus on specific methods.
 */
abstract class MyProviderBase implements OAuthClientProvider {
    get redirectUrl(): URL | undefined {
        return;
    }
    get clientMetadata() {
        return { redirect_uris: [] as string[] };
    }
    clientInformation(): undefined {
        return;
    }
    tokens(): undefined {
        return;
    }
    saveTokens() {
        return Promise.resolve();
    }
    redirectToAuthorization() {
        return Promise.resolve();
    }
    saveCodeVerifier() {
        return Promise.resolve();
    }
    codeVerifier() {
        return Promise.resolve('');
    }
}

/**
 * Example: Using fetchToken with a client_credentials provider.
 */
async function fetchToken_clientCredentials(authServerUrl: URL, metadata: AuthorizationServerMetadata) {
    //#region fetchToken_clientCredentials
    // Provider for client_credentials:
    class MyProvider extends MyProviderBase implements OAuthClientProvider {
        prepareTokenRequest(scope?: string) {
            const params = new URLSearchParams({ grant_type: 'client_credentials' });
            if (scope) params.set('scope', scope);
            return params;
        }
    }

    const tokens = await fetchToken(new MyProvider(), authServerUrl, { metadata });
    //#endregion fetchToken_clientCredentials
    return tokens;
}
