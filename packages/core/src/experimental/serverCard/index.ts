// @modelcontextprotocol/core/experimental/server-card
//
// Zod schemas, inferred types, and wire constants for the experimental MCP
// Server Card extension (SEP-2127) and the AI Catalog discovery document it
// uses. This subpath is the schema source of truth for the sibling SDK
// packages; the server and client experimental subpaths re-export the types
// and constants only, keeping their public surfaces Zod-free.
//
// Experimental: tracks the `experimental-ext-server-card` spec repository and
// may change or be removed in any release. Nothing here is part of the stable
// core root surface.

export type { AICatalog, AICatalogEntry, AICatalogHost } from './catalog';
export { AICatalogEntrySchema, AICatalogHostSchema, AICatalogSchema } from './catalog';
export {
    AI_CATALOG_MEDIA_TYPE,
    AI_CATALOG_WELL_KNOWN_PATH,
    SERVER_CARD_MEDIA_TYPE,
    SERVER_CARD_PATH_SUFFIX,
    SERVER_CARD_SCHEMA_URL
} from './constants';
export type { ServerCard, ServerCardInput, ServerCardKeyValueInput, ServerCardRemote, ServerCardRepository } from './schema';
export {
    ServerCardInputSchema,
    ServerCardKeyValueInputSchema,
    ServerCardRemoteSchema,
    ServerCardRepositorySchema,
    ServerCardSchema
} from './schema';
