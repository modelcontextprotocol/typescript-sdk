/**
 * Cloudflare Workers runtime shims for server package
 *
 * This file is selected via package.json export conditions when running in workerd.
 */
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/core';
