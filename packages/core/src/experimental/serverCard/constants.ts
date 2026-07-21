/**
 * Wire constants for the experimental MCP Server Card extension (SEP-2127).
 *
 * Experimental: this module tracks the `experimental-ext-server-card` spec
 * repository and may change or be removed in any release.
 */

/**
 * The canonical `$schema` URL every v1 Server Card document must carry.
 * Schema URLs are versioned by the `vN` segment rather than by date; a
 * breaking revision of the Server Card shape publishes a new `vN` family.
 */
export const SERVER_CARD_SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';

/**
 * Media type for Server Card documents. Servers should serve cards with this
 * `Content-Type` and clients should send it in `Accept` when fetching a card.
 */
export const SERVER_CARD_MEDIA_TYPE = 'application/mcp-server-card+json';

/**
 * Reserved path suffix for the recommended card location: MCP reserves
 * `GET <streamable-http-url>/server-card`. The suffix is appended to the
 * streamable HTTP endpoint path, never to the domain root.
 */
export const SERVER_CARD_PATH_SUFFIX = '/server-card';

/**
 * Media type for AI Catalog documents (external Agent-Card spec).
 */
export const AI_CATALOG_MEDIA_TYPE = 'application/ai-catalog+json';

/**
 * Well-known path where hosts may publish an AI Catalog for domain-level
 * discovery.
 */
export const AI_CATALOG_WELL_KNOWN_PATH = '/.well-known/ai-catalog.json';
