// @modelcontextprotocol/client/experimental/server-card
//
// Client-side helpers for the experimental MCP Server Card extension
// (SEP-2127): hardened fetchers, domain-level AI Catalog discovery, remote
// input resolution, and post-connect reconciliation. Stateless by design;
// caching, consent, dedup, and persistence are host policy.
//
// Experimental: tracks the `experimental-ext-server-card` spec repository and
// may change or be removed in any release.

export type { DiscoveredServerCard, DiscoverServerCardsOptions } from './discover';
export { discoverServerCards } from './discover';
export type { ServerCardErrorCode } from './errors';
export { ServerCardError } from './errors';
export type { AICatalogFetchResult, FetchAICatalogOptions, FetchServerCardOptions, ServerCardFetchResult } from './fetch';
export { fetchAICatalog, fetchServerCard, getAICatalogUrl } from './fetch';
export type { DiscoveryFetchOptions } from './guard';
export type { ServerCardMismatch } from './reconcile';
export { reconcileServerCard } from './reconcile';
export type { RemoteInputRequirement, ResolvedRemote } from './resolve';
export { requiredRemoteInputs, resolveRemote } from './resolve';

// Re-exported so client authors import everything from one module. Types and
// constants only; the Zod schemas stay on the core subpath.
export type {
    AICatalog,
    AICatalogEntry,
    ServerCard,
    ServerCardInput,
    ServerCardKeyValueInput,
    ServerCardRemote
} from '@modelcontextprotocol/core/experimental/server-card';
export {
    AI_CATALOG_MEDIA_TYPE,
    AI_CATALOG_WELL_KNOWN_PATH,
    SERVER_CARD_MEDIA_TYPE,
    SERVER_CARD_PATH_SUFFIX,
    SERVER_CARD_SCHEMA_URL
} from '@modelcontextprotocol/core/experimental/server-card';
