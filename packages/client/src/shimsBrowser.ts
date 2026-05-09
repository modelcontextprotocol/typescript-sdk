/**
 * Browser runtime shims for client package
 *
 * This file is selected via package.json export conditions when running in a browser.
 */
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/core/validators/cfWorker';

/**
 * Whether `fetch()` may throw `TypeError` due to CORS. Only true in browser contexts
 * (including Web Workers / Service Workers). In Node.js and Cloudflare Workers, a
 * `TypeError` from `fetch` is always a real network/configuration error.
 */
export const CORS_IS_POSSIBLE = true;
