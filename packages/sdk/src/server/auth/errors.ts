// v1 compat: `@modelcontextprotocol/sdk/server/auth/errors.js`
// Re-exports the frozen v1 OAuth error classes from the legacy package so that
// errors thrown from this subpath share the same `OAuthError` identity that
// `mcpAuthRouter`/`requireBearerAuth` (re-exported by sibling subpaths) check
// with `instanceof`.
export * from '@modelcontextprotocol/server-auth-legacy';
