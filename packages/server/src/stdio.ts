// Subpath entry for the stdio server transport.
//
// Exported separately from the root entry so that bundling `@modelcontextprotocol/server` for browser or
// Cloudflare Workers targets does not pull in `node:stream`. Import from `@modelcontextprotocol/server/stdio`
// only in process-stdio runtimes (Node.js, Bun, Deno).

export { StdioServerTransport } from './server/stdio.js';
