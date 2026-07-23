# oauth-client-credentials

OAuth 2.0 **`client_credentials`** grant — machine-to-machine MCP auth, fully self-verifying with no browser.

`client_credentials` is the grant a backend service uses to authenticate **as itself** (not on behalf of a user): it presents a pre-registered `client_id`/`client_secret` directly to the Authorization Server's token endpoint and receives a Bearer access token. There is no
redirect, no authorization code, no user consent screen.

The interactive **authorization-code** flow (the one that opens a browser and asks a human to sign in) lives under [`../oauth/`](../oauth/README.md); the runner drives it headlessly via the demo AS's `OAUTH_DEMO_AUTO_CONSENT=1` auto-approve mode.

## What runs

- `server.ts` starts two listeners in one process:
    - the MCP **resource server** on `--port` — `createMcpHandler` behind `requireBearerAuth` from `@modelcontextprotocol/express`, advertising the AS via `mcpAuthMetadataRouter` (RFC 9728 + RFC 8414).
    - a minimal **`client_credentials`-only Authorization Server** on `--port + 1` (`createClientCredentialsAuthServer` from `@mcp-examples/shared`). The repo's full better-auth/OIDC demo AS only implements `authorization_code`, so this story ships its own purpose-built AS.
- `client.ts` first asserts a bare request is `401` with a `WWW-Authenticate` challenge, then connects with a `ClientCredentialsProvider` on the transport. The SDK auth driver discovers the AS from the challenge, posts `grant_type=client_credentials` (HTTP Basic auth) to
  `/token`, attaches the returned Bearer token, and the `whoami` tool's `ctx.authInfo` carries the granted `clientId` and `scopes` end to end.

## Run it

```bash
pnpm --filter @mcp-examples/oauth-client-credentials server -- --http --port 3000
pnpm --filter @mcp-examples/oauth-client-credentials client -- --http http://127.0.0.1:3000/mcp
```

HTTP-only; runs on both protocol eras (the client honours `--legacy` via `parseExampleArgs().era`).

## `private_key_jwt` client authentication

To authenticate the `client_credentials` grant with a signed JWT assertion (RFC 7523 §2.2) instead of a shared secret, swap `ClientCredentialsProvider` for `PrivateKeyJwtProvider`:

```ts
import { PrivateKeyJwtProvider } from '@modelcontextprotocol/client';

const authProvider = new PrivateKeyJwtProvider({
    clientId: 'my-service',
    privateKey: pemEncodedKey,
    algorithm: 'RS256'
});
```

The full snippet lives in [Machine auth › Sign with a private key instead of a secret](../../docs/clients/machine-auth.md#sign-with-a-private-key-instead-of-a-secret) (`guides/clients/machine-auth.examples.ts` → `privateKeyJwt_provider`). There is no runnable leg for it in this story — the in-repo `client_credentials` AS only implements `client_secret_basic`/`client_secret_post`.
