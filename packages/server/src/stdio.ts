// Subpath entry for stdio serving.
//
// Exported separately from the root entry to keep the process-stdio surface (`StdioServerTransport`
// and the `serveStdio` entry point, which constructs one by default) out of the default bundle
// surface — server stdio has only type-level Node imports, but matching the client's `./stdio`
// subpath gives consumers a consistent shape across packages. Import from
// `@modelcontextprotocol/server/stdio` only in process-stdio runtimes (Node.js, Bun, Deno).

export type { ServeStdioOptions, StdioServerHandle } from './server/serveStdio';
export { serveStdio } from './server/serveStdio';
export { StdioServerTransport } from './server/stdio';
