// docs: typecheck-only
/**
 * Type-checked companion for `docs/clients/machine-auth.md`.
 *
 * Each `//#region` block is synced byte-for-byte into that page's `ts` fences by
 * `pnpm sync:snippets` (`pnpm sync:snippets --check` reports drift). Every flow
 * on the page needs a live authorization server, so there is nothing meaningful
 * to run — the regions only typecheck.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *
 * @module
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
import type { AuthProvider } from '@modelcontextprotocol/client';
import { CrossAppAccessProvider, discoverAndRequestJwtAuthGrant, PrivateKeyJwtProvider } from '@modelcontextprotocol/client';

// "Authenticate with client credentials" — the page's lead block. The import line
// is part of the region so the first fence on the page names where the providers
// come from.
//#region clientCredentials_connect
import { Client, ClientCredentialsProvider, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const authProvider = new ClientCredentialsProvider({
    clientId: 'reporting-job',
    clientSecret: 'reporting-job-secret'
});

const client = new Client({ name: 'reporting-job', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL('https://api.example.com/mcp'), { authProvider });

await client.connect(transport);
//#endregion clientCredentials_connect

// "Bring your own bearer token" — the minimal AuthProvider shape: token() only.
function bearerToken_provider(getStoredToken: () => Promise<string>) {
    //#region bearerToken_provider
    const authProvider: AuthProvider = { token: async () => getStoredToken() };

    const transport = new StreamableHTTPClientTransport(new URL('https://api.example.com/mcp'), { authProvider });
    //#endregion bearerToken_provider
    return transport;
}

// "Sign with a private key instead of a secret" — private_key_jwt token-endpoint auth.
function privateKeyJwt_provider(pemEncodedKey: string) {
    //#region privateKeyJwt_provider
    const authProvider = new PrivateKeyJwtProvider({
        clientId: 'reporting-job',
        privateKey: pemEncodedKey,
        algorithm: 'RS256'
    });

    const transport = new StreamableHTTPClientTransport(new URL('https://api.example.com/mcp'), { authProvider });
    //#endregion privateKeyJwt_provider
    return transport;
}

// "Act for an enterprise user with cross-app access" — SEP-990 / Enterprise
// Managed Authorization. The assertion callback turns the IdP ID Token into a
// JWT Authorization Grant; the provider exchanges that for the access token.
function crossAppAccess_provider(getIdToken: () => Promise<string>) {
    //#region crossAppAccess_provider
    const authProvider = new CrossAppAccessProvider({
        assertion: async ctx => {
            const grant = await discoverAndRequestJwtAuthGrant({
                idpUrl: 'https://idp.example.com',
                audience: ctx.authorizationServerUrl,
                resource: ctx.resourceUrl,
                idToken: await getIdToken(),
                clientId: 'idp-exchange-client',
                clientSecret: 'idp-exchange-secret',
                scope: ctx.scope,
                fetchFn: ctx.fetchFn
            });
            return grant.jwtAuthGrant;
        },
        clientId: 'reporting-job',
        clientSecret: 'reporting-job-secret'
    });

    const transport = new StreamableHTTPClientTransport(new URL('https://api.example.com/mcp'), { authProvider });
    //#endregion crossAppAccess_provider
    return transport;
}

void bearerToken_provider;
void privateKeyJwt_provider;
void crossAppAccess_provider;
