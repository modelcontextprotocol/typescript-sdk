---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Move stdio transports to a `./stdio` subpath export. Import `StdioClientTransport`, `getDefaultEnvironment`, `DEFAULT_INHERITED_ENV_VARS`, and `StdioServerParameters` from `@modelcontextprotocol/client/stdio`, and `StdioServerTransport` from `@modelcontextprotocol/server/stdio`. The `@modelcontextprotocol/client` root entry no longer pulls in `node:child_process`, `node:stream`, or `cross-spawn`, fixing bundling for browser and Cloudflare Workers targets; the `@modelcontextprotocol/server` root entry drops its `node:stream` reference. Node.js, Bun, and Deno consumers update the import path; runtime behavior is unchanged.
