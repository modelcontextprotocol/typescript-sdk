// v1-compat subpath: `@modelcontextprotocol/server/zod-schemas`
//
// Re-exports the Zod schema constants (`*Schema`) that v1's `types.js`
// exposed alongside the spec types. v2 keeps these out of the main barrel
// (they pull in zod at runtime); this subpath lets the `@modelcontextprotocol/sdk`
// meta-package's `types.js` shim restore them for v1 callers of
// `setRequestHandler(SomeRequestSchema, handler)`.
//
// Source of truth: core's internal types/schemas.ts + shared/auth.ts.

// eslint-disable-next-line import/export -- intentional bulk re-export of internal zod constants
export * from '@modelcontextprotocol/core';
