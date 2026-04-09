// Subpath entry for the stdio client transport.
//
// Exported separately from the root entry so that bundling `@modelcontextprotocol/client` for browser or
// Cloudflare Workers targets does not pull in `node:child_process`, `node:stream`, or `cross-spawn`. Import
// from `@modelcontextprotocol/client/stdio` only in process-spawning runtimes (Node.js, Bun, Deno).

export type { StdioServerParameters } from './client/stdio.js';
export { DEFAULT_INHERITED_ENV_VARS, getDefaultEnvironment, StdioClientTransport } from './client/stdio.js';
