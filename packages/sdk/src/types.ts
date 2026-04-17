// v1 compat: `@modelcontextprotocol/sdk/types.js`
// In v1 this was the giant types.ts file with all spec types + Zod schemas.
// v2 dropped the Zod schema constants from the public surface; spec TypeScript
// types are re-exported here from the server package.

export * from '@modelcontextprotocol/server';
// v1's types.js also exported the Zod *Schema constants used with
// setRequestHandler/setNotificationHandler. v2 moved those to a separate
// subpath; re-export them here for v1-compat.
export * from '@modelcontextprotocol/server/zod-schemas';
/**
 * @deprecated Use {@link ResourceTemplateType}.
 *
 * v1's `types.js` exported the spec-derived ResourceTemplate data type under
 * this name. v2 renamed it to `ResourceTemplateType` to avoid clashing with the
 * `ResourceTemplate` helper class exported by `@modelcontextprotocol/server`.
 * This alias lives only in the meta-package compat subpath; exporting it from
 * core/public causes tsdown to mark server's class as type-only in bundled .d.mts.
 */
export type { ResourceTemplateType as ResourceTemplate } from '@modelcontextprotocol/server';
