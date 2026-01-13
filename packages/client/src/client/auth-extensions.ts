/**
 * OAuth provider extensions for specialized authentication flows.
 *
 * This module provides ready-to-use OAuthClientProvider implementations
 * for common machine-to-machine authentication scenarios.
 */

import type { OAuthClientInformation, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/core';
import type { CryptoKey, JWK } from 'jose';

import type { AddClientAuthentication, OAuthClientProvider } from './auth.js';

/**
 * Helper to produce a private_key_jwt client authentication function.
 *
 * Usage:
 *   const addClientAuth = createPrivateKeyJwtAuth({ issuer, subject, privateKey, alg, audience? });
 *   // pass addClientAuth as provider.addClientAuthentication implementation
 */
export function createPrivateKeyJwtAuth(options: {
    issuer: string;
    subject: string;
    privateKey: string | Uint8Array | Record<string, unknown>;
    alg: string;
    audience?: string | URL;
    lifetimeSeconds?: number;
    claims?: Record<string, unknown>;
}): AddClientAuthentication {
    return async (_headers, params, url, metadata) => {
        // Lazy import to avoid heavy dependency unless used
        if (typeof globalThis.crypto === 'undefined') {
            throw new TypeError(
                'crypto is not available, please ensure you add have Web Crypto API support for older Node.js versions (see https://github.com/modelcontextprotocol/typescript-sdk#nodejs-web-crypto-globalthiscrypto-compatibility)'
            );
        }

        const jose = await import('jose');

        const audience = String(options.audience ?? metadata?.issuer ?? url);
        const lifetimeSeconds = options.lifetimeSeconds ?? 300;

        const now = Math.floor(Date.now() / 1000);
        const jti = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

        const baseClaims = {
            iss: options.issuer,
            sub: options.subject,
            aud: audience,
            exp: now + lifetimeSeconds,
            iat: now,
            jti
        };
        const claims = options.claims ? { ...baseClaims, ...options.claims } : baseClaims;

        // Import key for the requested algorithm
        const alg = options.alg;
        let key: unknown;
        if (typeof options.privateKey === 'string') {
            if (alg.startsWith('RS') || alg.startsWith('ES') || alg.startsWith('PS')) {
                key = await jose.importPKCS8(options.privateKey, alg);
            } else if (alg.startsWith('HS')) {
                key = new TextEncoder().encode(options.privateKey);
            } else {
                throw new Error(`Unsupported algorithm ${alg}`);
            }
        } else if (options.privateKey instanceof Uint8Array) {
            if (alg.startsWith('HS')) {
                key = options.privateKey;
            } else {
                // Assume PKCS#8 DER in Uint8Array for asymmetric algorithms
                key = await jose.importPKCS8(new TextDecoder().decode(options.privateKey), alg);
            }
        } else {
            // Treat as JWK
            key = await jose.importJWK(options.privateKey as JWK, alg);
        }

        // Sign JWT
        const assertion = await new jose.SignJWT(claims)
            .setProtectedHeader({ alg, typ: 'JWT' })
            .setIssuer(options.issuer)
            .setSubject(options.subject)
            .setAudience(audience)
            .setIssuedAt(now)
            .setExpirationTime(now + lifetimeSeconds)
            .setJti(jti)
            .sign(key as unknown as Uint8Array | CryptoKey);

        params.set('client_assertion', assertion);
        params.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    };
}

/**
 * Options for creating a ClientCredentialsProvider.
 */
export interface ClientCredentialsProviderOptions {
    /**
     * The client_id for this OAuth client.
     */
    clientId: string;

    /**
     * The client_secret for client_secret_basic authentication.
     */
    clientSecret: string;

    /**
     * Optional client name for metadata.
     */
    clientName?: string;
}

/**
 * OAuth provider for client_credentials grant with client_secret_basic authentication.
 *
 * This provider is designed for machine-to-machine authentication where
 * the client authenticates using a client_id and client_secret.
 *
 * @example
 * const provider = new ClientCredentialsProvider({
 *   clientId: 'my-client',
 *   clientSecret: 'my-secret'
 * });
 *
 * const transport = new StreamableHTTPClientTransport(serverUrl, {
 *   authProvider: provider
 * });
 */
export class ClientCredentialsProvider implements OAuthClientProvider {
    private _tokens?: OAuthTokens;
    private _clientInfo: OAuthClientInformation;
    private _clientMetadata: OAuthClientMetadata;

    constructor(options: ClientCredentialsProviderOptions) {
        this._clientInfo = {
            client_id: options.clientId,
            client_secret: options.clientSecret
        };
        this._clientMetadata = {
            client_name: options.clientName ?? 'client-credentials-client',
            redirect_uris: [],
            grant_types: ['client_credentials'],
            token_endpoint_auth_method: 'client_secret_basic'
        };
    }

    get redirectUrl(): undefined {
        return undefined;
    }

    get clientMetadata(): OAuthClientMetadata {
        return this._clientMetadata;
    }

    clientInformation(): OAuthClientInformation {
        return this._clientInfo;
    }

    saveClientInformation(info: OAuthClientInformation): void {
        this._clientInfo = info;
    }

    tokens(): OAuthTokens | undefined {
        return this._tokens;
    }

    saveTokens(tokens: OAuthTokens): void {
        this._tokens = tokens;
    }

    redirectToAuthorization(): void {
        throw new Error('redirectToAuthorization is not used for client_credentials flow');
    }

    saveCodeVerifier(): void {
        // Not used for client_credentials
    }

    codeVerifier(): string {
        throw new Error('codeVerifier is not used for client_credentials flow');
    }

    prepareTokenRequest(scope?: string): URLSearchParams {
        const params = new URLSearchParams({ grant_type: 'client_credentials' });
        if (scope) params.set('scope', scope);
        return params;
    }
}

/**
 * Options for creating a PrivateKeyJwtProvider.
 */
export interface PrivateKeyJwtProviderOptions {
    /**
     * The client_id for this OAuth client.
     */
    clientId: string;

    /**
     * The private key for signing JWT assertions.
     * Can be a PEM string, Uint8Array, or JWK object.
     */
    privateKey: string | Uint8Array | Record<string, unknown>;

    /**
     * The algorithm to use for signing (e.g., 'RS256', 'ES256').
     */
    algorithm: string;

    /**
     * Optional client name for metadata.
     */
    clientName?: string;

    /**
     * Optional JWT lifetime in seconds (default: 300).
     */
    jwtLifetimeSeconds?: number;
}

/**
 * OAuth provider for client_credentials grant with private_key_jwt authentication.
 *
 * This provider is designed for machine-to-machine authentication where
 * the client authenticates using a signed JWT assertion (RFC 7523 Section 2.2).
 *
 * @example
 * const provider = new PrivateKeyJwtProvider({
 *   clientId: 'my-client',
 *   privateKey: pemEncodedPrivateKey,
 *   algorithm: 'RS256'
 * });
 *
 * const transport = new StreamableHTTPClientTransport(serverUrl, {
 *   authProvider: provider
 * });
 */
export class PrivateKeyJwtProvider implements OAuthClientProvider {
    private _tokens?: OAuthTokens;
    private _clientInfo: OAuthClientInformation;
    private _clientMetadata: OAuthClientMetadata;
    addClientAuthentication: AddClientAuthentication;

    constructor(options: PrivateKeyJwtProviderOptions) {
        this._clientInfo = {
            client_id: options.clientId
        };
        this._clientMetadata = {
            client_name: options.clientName ?? 'private-key-jwt-client',
            redirect_uris: [],
            grant_types: ['client_credentials'],
            token_endpoint_auth_method: 'private_key_jwt'
        };
        this.addClientAuthentication = createPrivateKeyJwtAuth({
            issuer: options.clientId,
            subject: options.clientId,
            privateKey: options.privateKey,
            alg: options.algorithm,
            lifetimeSeconds: options.jwtLifetimeSeconds
        });
    }

    get redirectUrl(): undefined {
        return undefined;
    }

    get clientMetadata(): OAuthClientMetadata {
        return this._clientMetadata;
    }

    clientInformation(): OAuthClientInformation {
        return this._clientInfo;
    }

    saveClientInformation(info: OAuthClientInformation): void {
        this._clientInfo = info;
    }

    tokens(): OAuthTokens | undefined {
        return this._tokens;
    }

    saveTokens(tokens: OAuthTokens): void {
        this._tokens = tokens;
    }

    redirectToAuthorization(): void {
        throw new Error('redirectToAuthorization is not used for client_credentials flow');
    }

    saveCodeVerifier(): void {
        // Not used for client_credentials
    }

    codeVerifier(): string {
        throw new Error('codeVerifier is not used for client_credentials flow');
    }

    prepareTokenRequest(scope?: string): URLSearchParams {
        const params = new URLSearchParams({ grant_type: 'client_credentials' });
        if (scope) params.set('scope', scope);
        return params;
    }
}

/**
 * Options for creating a StaticPrivateKeyJwtProvider.
 */
export interface StaticPrivateKeyJwtProviderOptions {
    /**
     * The client_id for this OAuth client.
     */
    clientId: string;

    /**
     * A pre-built JWT client assertion to use for authentication.
     *
     * This token should already contain the appropriate claims
     * (iss, sub, aud, exp, etc.) and be signed by the client's key.
     */
    jwtBearerAssertion: string;

    /**
     * Optional client name for metadata.
     */
    clientName?: string;
}

/**
 * OAuth provider for client_credentials grant with a static private_key_jwt assertion.
 *
 * This provider mirrors {@link PrivateKeyJwtProvider} but instead of constructing and
 * signing a JWT on each request, it accepts a pre-built JWT assertion string and
 * uses it directly for authentication.
 */
export class StaticPrivateKeyJwtProvider implements OAuthClientProvider {
    private _tokens?: OAuthTokens;
    private _clientInfo: OAuthClientInformation;
    private _clientMetadata: OAuthClientMetadata;
    addClientAuthentication: AddClientAuthentication;

    constructor(options: StaticPrivateKeyJwtProviderOptions) {
        this._clientInfo = {
            client_id: options.clientId
        };
        this._clientMetadata = {
            client_name: options.clientName ?? 'static-private-key-jwt-client',
            redirect_uris: [],
            grant_types: ['client_credentials'],
            token_endpoint_auth_method: 'private_key_jwt'
        };

        const assertion = options.jwtBearerAssertion;
        this.addClientAuthentication = async (_headers, params) => {
            params.set('client_assertion', assertion);
            params.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
        };
    }

    get redirectUrl(): undefined {
        return undefined;
    }

    get clientMetadata(): OAuthClientMetadata {
        return this._clientMetadata;
    }

    clientInformation(): OAuthClientInformation {
        return this._clientInfo;
    }

    saveClientInformation(info: OAuthClientInformation): void {
        this._clientInfo = info;
    }

    tokens(): OAuthTokens | undefined {
        return this._tokens;
    }

    saveTokens(tokens: OAuthTokens): void {
        this._tokens = tokens;
    }

    redirectToAuthorization(): void {
        throw new Error('redirectToAuthorization is not used for client_credentials flow');
    }

    saveCodeVerifier(): void {
        // Not used for client_credentials
    }

    codeVerifier(): string {
        throw new Error('codeVerifier is not used for client_credentials flow');
    }

    prepareTokenRequest(scope?: string): URLSearchParams {
        const params = new URLSearchParams({ grant_type: 'client_credentials' });
        if (scope) params.set('scope', scope);
        return params;
    }
}
