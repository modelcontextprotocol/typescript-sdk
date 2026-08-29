# oauth-workload-identity

Workload Identity Federation (WIF, [SEP-1933](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1933), extension id `io.modelcontextprotocol/auth/wif`) over the RFC 7523 **`jwt-bearer`** grant, fully self-verifying with no browser and no client secret.

A workload running on a modern platform already holds a signed statement of its own identity: a Kubernetes projected service account token, a SPIFFE JWT-SVID, a cloud instance identity token. WIF is the flow that turns that platform-issued JWT into an MCP access token: the client posts it to the Authorization Server's token endpoint as `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` with the JWT in the `assertion` parameter, and the AS returns a Bearer token if it trusts that issuer for that subject.

The point is that no long-lived secret is provisioned anywhere. `client_credentials` (see [`../oauth-client-credentials/`](../oauth-client-credentials/README.md)) needs a `client_secret` to be minted, stored, distributed and rotated; WIF replaces it with a short-lived credential the platform mints on its own schedule and the workload never has to keep. `WorkloadIdentityProvider` is non-interactive by construction: it exposes no `redirectUrl`, and it refuses to re-present an assertion the AS has already rejected rather than retrying or falling back to an interactive grant.

## What runs

- `server.ts` starts one process playing three roles:
    - a **workload issuer** with no listener: an ES256 keypair generated at startup, standing in for the Kubernetes API server or a SPIFFE server. It mints one workload JWT (`iss` the issuer, `sub` `spiffe://demo.example/mcp-workload`, `aud` the AS issuer identifier, five-minute `exp`, random `jti`) and writes it to a file, the way the kubelet projects a service account token into a pod.
    - a minimal **`jwt-bearer`-only Authorization Server** on `--port + 1`. Its RFC 8414 metadata advertises `grant_types_supported: ['urn:ietf:params:oauth:grant-type:jwt-bearer']` and `token_endpoint_auth_methods_supported: ['none']`. Its `/token` endpoint verifies the assertion with `jose.jwtVerify` against the workload issuer's key (issuer, subject and audience all checked) and mints an opaque access token. `@mcp-examples/shared`'s AS helper only implements `client_credentials`, so this story ships its own token endpoint.
    - the MCP **resource server** on `--port` - `createMcpHandler` behind `requireBearerAuth` from `@modelcontextprotocol/express`, advertising the AS via `mcpAuthMetadataRouter` (RFC 9728 + RFC 8414).
- `client.ts` first asserts a bare request is `401` with a `WWW-Authenticate` challenge, then connects with a `WorkloadIdentityProvider` whose `assertion` is a `fileAssertionSource(path)` callback. The SDK auth driver discovers the AS from the challenge, posts the `jwt-bearer` grant to `/token`, attaches the returned Bearer token, and the `whoami` tool's `ctx.authInfo` carries the federated workload subject and granted `scopes` end to end.

Both halves derive the token file path from the MCP port (`os.tmpdir()/mcp-wif-workload-token-<port>.jwt`), so no handshake is needed between the two processes. Set `WIF_WORKLOAD_TOKEN_PATH` on both to point at a different location; the server writes it fresh and fails at startup rather than overwriting a file that already exists there.

## Run it

```bash
pnpm --filter @mcp-examples/oauth-workload-identity server -- --http --port 3000
pnpm --filter @mcp-examples/oauth-workload-identity client -- --http http://127.0.0.1:3000/mcp
```

The client prints the tool list and exits `0`; any mismatch throws and exits non-zero. HTTP-only; runs on both protocol eras (the client honours `--legacy` via `parseExampleArgs().era`).

## Audience: what the assertion's `aud` must say

The workload JWT's `aud` is the **authorization server's issuer identifier** - the `issuer` value from its RFC 8414 metadata, here `http://127.0.0.1:<port + 1>`. That is what the MCP conformance profile expects, and where [draft-ietf-oauth-rfc7523bis](https://datatracker.ietf.org/doc/draft-ietf-oauth-rfc7523bis/) is heading (the draft permits either the issuer identifier or the token endpoint URL for authorization grants). The assertion is addressed to the AS that will consume it, never to the MCP server the resulting access token is spent on; an AS must reject an assertion whose audience does not name it.

When the assertion comes from a callback, the callback owns that decision, which is why `WorkloadAssertionContext` hands it the discovered `authorizationServerUrl` (and `resourceUrl`) - a token-service call can mint an assertion for exactly the AS the SDK just discovered. This example's assertion is pre-minted at startup instead, so its audience is fixed. The demo AS accepts the issuer identifier with or without a trailing slash, because platform token services differ on that detail.

## Where assertions come from in production

- **Kubernetes projected service account tokens.** A `serviceAccountToken` volume projection with `audience: <AS issuer identifier>` writes a JWT into the pod and the kubelet rewrites that file in place as the token rotates. `fileAssertionSource` re-reads the file on every token request, which is exactly what that rotation pattern requires; read it once at startup instead and the process pins a credential that stops working when it expires.
- **SPIFFE JWT-SVIDs.** A workload fetches a JWT-SVID for the AS audience from the SPIFFE Workload API over its local socket, so the assertion never touches the filesystem. That is a callback that calls the Workload API instead of `readFile`, with the same `WorkloadAssertionCallback` shape.
- **Cloud instance and workload identity tokens.** GitHub Actions OIDC, GCP's identity token endpoint, Azure managed identity and similar services expose a metadata or token endpoint that mints an audience-scoped JWT on demand; the callback receives `fetchFn` for exactly that call.

`fileAssertionSource` lives in this example rather than in `@modelcontextprotocol/client`: the client package's root entry stays runtime-neutral for browser and Cloudflare Workers bundlers, so it cannot reach for `node:fs`. It is four lines, and copying it is the intended path.
