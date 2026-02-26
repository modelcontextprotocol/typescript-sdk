/**
 * Type-checked examples for `authExtensions.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { ClientCredentialsProvider, createPrivateKeyJwtAuth, PrivateKeyJwtProvider } from './authExtensions.js';
import { StreamableHTTPClientTransport } from './streamableHttp.js';

/**
 * Example: Creating a private key JWT authentication function.
 */
function createPrivateKeyJwtAuth_basicUsage(pemEncodedPrivateKey: string) {
    //#region createPrivateKeyJwtAuth_basicUsage
    const addClientAuth = createPrivateKeyJwtAuth({
        issuer: 'my-client',
        subject: 'my-client',
        privateKey: pemEncodedPrivateKey,
        alg: 'RS256'
    });
    // pass addClientAuth as provider.addClientAuthentication implementation
    //#endregion createPrivateKeyJwtAuth_basicUsage
    return addClientAuth;
}

/**
 * Example: Using ClientCredentialsProvider for OAuth client credentials flow.
 */
function ClientCredentialsProvider_basicUsage(serverUrl: URL) {
    //#region ClientCredentialsProvider_basicUsage
    const provider = new ClientCredentialsProvider({
        clientId: 'my-client',
        clientSecret: 'my-secret'
    });

    const transport = new StreamableHTTPClientTransport(serverUrl, {
        authProvider: provider
    });
    //#endregion ClientCredentialsProvider_basicUsage
    return transport;
}

/**
 * Example: Using PrivateKeyJwtProvider for OAuth with private key JWT.
 */
function PrivateKeyJwtProvider_basicUsage(pemEncodedPrivateKey: string, serverUrl: URL) {
    //#region PrivateKeyJwtProvider_basicUsage
    const provider = new PrivateKeyJwtProvider({
        clientId: 'my-client',
        privateKey: pemEncodedPrivateKey,
        algorithm: 'RS256'
    });

    const transport = new StreamableHTTPClientTransport(serverUrl, {
        authProvider: provider
    });
    //#endregion PrivateKeyJwtProvider_basicUsage
    return transport;
}
