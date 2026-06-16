---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/express': minor
'@modelcontextprotocol/hono': minor
'@modelcontextprotocol/fastify': minor
'@modelcontextprotocol/node': minor
---

Add Origin header validation alongside the existing Host header validation. The server package gains framework-agnostic helpers (`validateOriginHeader`, `localhostAllowedOrigins`, `originValidationResponse`); the Express, Hono and Fastify adapters gain `originValidation` /
`localhostOriginValidation` middleware and a new `allowedOrigins` option on their app factories, which now arm Origin validation by default for localhost-class binds (mirroring the Host validation ladder; the 0.0.0.0-without-allowlist warning is unchanged). Requests
without an `Origin` header pass — non-browser MCP clients are unaffected — while a present `Origin` that is not allowed or cannot be parsed (including the opaque `null` origin) is rejected with `403`. The Node adapter ships `hostHeaderValidation` / `originValidation`
request guards for plain `node:http` servers, which previously had no validation helpers.
