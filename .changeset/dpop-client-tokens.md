---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/core': minor
---

Add DPoP (RFC 9449 / SEP-1932) sender-constrained access token support to the client.

- Opt in by implementing `OAuthClientProvider.dpop()` returning a `DpopSession` (new, along with `generateDpopKeyPair`, `accessTokenHash`, `isDpopNonceChallenge`). `auth()` / `exchangeAuthorization` / `refreshAuthorization` / `fetchToken` then sign a DPoP proof into token requests (retrying once on an authorization-server `use_dpop_nonce` challenge, with client authentication re-applied per attempt), and `StreamableHTTPClientTransport`, `SSEClientTransport` and `withOAuth` present a `token_type: "DPoP"` access token as `Authorization: DPoP <token>` plus a fresh per-request proof, retry a resource-server `use_dpop_nonce` challenge once, and pick up a `DPoP-Nonce` delivered on any response. Tokens the AS issued as `Bearer` are still presented as Bearer.
- DPoP is applied at the fetch layer: the transports wrap their resource-server `fetch` (including a caller-supplied `fetch` / `eventSourceInit.fetch`) with the new `withDpopFromProvider(provider)` middleware, so proofs are always bound to the request actually sent. `withDpop(session, getToken)` is exported for callers that manage tokens themselves (e.g. alongside a minimal `AuthProvider`); the `AuthProvider` interface itself is unchanged.
- `auth()` now recovers from `invalid_dpop_proof` on refresh (e.g. a refresh token bound to a key that is no longer held) by discarding the tokens and re-authorizing, like `invalid_grant`. `OAuthErrorCode` gains `InvalidDpopProof` and `UseDpopNonce`; `extractWWWAuthenticateParams` recognizes the `DPoP` challenge scheme; `OAuthMetadataSchema` gains `dpop_signing_alg_values_supported`.
