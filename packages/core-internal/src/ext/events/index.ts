// @modelcontextprotocol/core-internal/ext/events
//
// Internal layer of the MCP Events extension (SEP-3415), shared by the client
// and server packages: the error table and `EventsError`, canonical JSON, and
// Standard Webhooks signing. Not on core-internal's root barrel: import it from
// this subpath, so it stays out of the client and server root module graphs.
export { canonicalJson } from './canonicalJson';
export type { EventsErrorKind } from './codes';
export { EVENTS_ERROR_CODES } from './codes';
export { EventsError } from './errors';
export {
    generateWebhookId,
    generateWebhookSecret,
    parseWebhookSecret,
    signWebhook,
    timingSafeEqualString,
    verifyWebhookSignature
} from './webhookSignature';
