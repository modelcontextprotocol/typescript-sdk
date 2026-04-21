// v1 compat: `@modelcontextprotocol/sdk/types.js`
// In v1 this was the giant types.ts file with all spec types + Zod schemas.
// v2 splits them: spec TypeScript types live in the server barrel (via core/public),
// zod schema constants live at @modelcontextprotocol/server/zod-schemas.

export * from '@modelcontextprotocol/server';
export * from '@modelcontextprotocol/server/zod-schemas';
// Explicit tie-break for symbols both barrels export.
export { fromJsonSchema } from '@modelcontextprotocol/server';
// Explicit re-exports of commonly-used spec types (belt-and-suspenders over the
// wildcard above; some d.ts toolchains drop type-only symbols across export-*).
export type {
    CallToolResult,
    ClientCapabilities,
    GetPromptResult,
    Implementation,
    ListResourcesResult,
    ListToolsResult,
    Prompt,
    ReadResourceResult,
    Resource,
    ServerCapabilities,
    Tool
} from '@modelcontextprotocol/server';

/**
 * @deprecated Use {@link ResourceTemplateType}.
 *
 * v1's `types.js` exported the spec-derived ResourceTemplate data type under
 * this name. v2 renamed it to `ResourceTemplateType` to avoid clashing with the
 * `ResourceTemplate` helper class exported by `@modelcontextprotocol/server`.
 */
export type { ResourceTemplateType as ResourceTemplate } from '@modelcontextprotocol/server';

/** @deprecated Use {@link ProtocolError}. */
export { ProtocolError as McpError } from '@modelcontextprotocol/server';
/** @deprecated Use {@link ProtocolErrorCode}. */
export { ProtocolErrorCode as ErrorCode } from '@modelcontextprotocol/server';
