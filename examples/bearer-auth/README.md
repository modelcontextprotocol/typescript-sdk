# bearer-auth

Resource-server-only auth: `requireBearerAuth` + `mcpAuthMetadataRouter` from `@modelcontextprotocol/express` in front of `createMcpHandler`. The client asserts `401` + `WWW-Authenticate` without a token, and that the verified `authInfo` reaches the factory (`ctx.authInfo`) with
one.

**HTTP-only** by definition. The full interactive OAuth set lives under `../oauth/` (excluded from the harness).
