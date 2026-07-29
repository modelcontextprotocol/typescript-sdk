// Subpath entry for Node-specific fetch dispatcher helpers.
//
// Exported separately from the root entry so that bundling
// `@modelcontextprotocol/client` for browser or Cloudflare Workers targets
// does not pull in `undici` or `node:process` checks. Import from
// `@modelcontextprotocol/client/node` only in Node.js runtimes.

export { createDefaultNodeDispatcher, createDefaultNodeDispatcherSync } from './client/nodeDispatcher';
export type { DispatcherLike } from '@modelcontextprotocol/core-internal';
