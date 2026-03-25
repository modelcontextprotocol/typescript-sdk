/**
 * Node.js runtime shims for client package
 *
 * This file is selected via package.json export conditions when running in Node.js.
 */
export { AjvJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/core';

/**
 * Whether `fetch()` may throw `TypeError` due to CORS. CORS is a browser-only concept —
 * in Node.js, a `TypeError` from `fetch` is always a real network/configuration error
 * (DNS resolution, connection refused, invalid URL), never a CORS error.
 */
export const CORS_IS_POSSIBLE = false;
