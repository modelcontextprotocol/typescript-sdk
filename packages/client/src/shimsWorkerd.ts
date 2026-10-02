/**
 * Cloudflare Workers runtime shims for client package
 *
 * This file is selected via package.json export conditions when running in workerd.
 */
import { preloadSchemas } from '@modelcontextprotocol/core-internal';

export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/core-internal/validators/cfWorker';

// Platform asymmetry: isolate platforms like workerd evaluate module scope
// during deployment/isolate warm-up, outside any request's billed CPU, while
// lazy construction would land inside the first request each fresh isolate
// serves. Node and browser shims stay lazy — there, module evaluation is
// process/page startup and boot latency is the cost that matters.
preloadSchemas();

/**
 * Whether `fetch()` may throw `TypeError` due to CORS. CORS is a browser-only concept —
 * in Cloudflare Workers, a `TypeError` from `fetch` is always a real network/configuration
 * error, never a CORS error.
 */
export const CORS_IS_POSSIBLE = false;
