/**
 * Cloudflare Workers (workerd) runtime shims
 *
 * This module provides Cloudflare Workers-specific implementations for the MCP SDK.
 * It is automatically selected when running in workerd environments (Cloudflare Workers, Pages, etc.).
 */

/**
 * Default JSON Schema validator for Cloudflare Workers environments.
 * Uses @cfworker/json-schema which is compatible with the Workers runtime.
 */
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from '../validation/cfWorkerProvider.js';
