// Subpath entry for the stdio server transport.
//
// Exported separately from the root entry to keep `StdioServerTransport` out of the default bundle
// surface — server stdio has only type-level Node imports, but matching the client's `./stdio`
// subpath gives consumers a consistent shape across packages. Import from
// `@modelcontextprotocol/server/stdio` only in process-stdio runtimes (Node.js, Bun, Deno).

export { StdioServerTransport } from './server/stdio.js';
