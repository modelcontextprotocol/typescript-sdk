/**
 * Cloudflare Workers (workerd) runtime shims for server package
 *
 * This file is selected via package.json export conditions when running in Cloudflare Workers.
 */
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/core';
