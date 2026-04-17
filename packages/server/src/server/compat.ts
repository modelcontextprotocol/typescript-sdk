/**
 * v1 compat alias. The low-level `Server` class is now the same as `McpServer`.
 * @deprecated Import {@linkcode McpServer} from `./mcpServer.js` directly.
 */
export { McpServer as Server } from './mcpServer.js';
export type { ServerOptions } from './mcpServer.js';
