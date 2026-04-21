/**
 * v1-compat module path. The low-level `Server` class is now an alias for
 * {@linkcode McpServer}; see {@link ./compat.ts} and {@link ./mcpServer.ts}.
 * @deprecated Import from `@modelcontextprotocol/server` directly.
 */
export { Server } from './compat.js';
export type { ServerOptions, ServerTasksCapabilityWithRuntime } from './mcpServer.js';
