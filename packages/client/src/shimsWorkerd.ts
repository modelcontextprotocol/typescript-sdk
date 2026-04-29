/**
 * Cloudflare Workers runtime shims for client package
 *
 * This file is selected via package.json export conditions when running in workerd.
 */
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/core/validators/cfWorker';

/**
 * Whether `fetch()` may throw `TypeError` due to CORS. CORS is a browser-only concept —
 * in Cloudflare Workers, a `TypeError` from `fetch` is always a real network/configuration
 * error, never a CORS error.
 */
export const CORS_IS_POSSIBLE = false;
