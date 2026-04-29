export * from '@modelcontextprotocol/server';
// Shadow with v1-compat subclasses (later export wins for `export *` collisions)
export { McpServer, Server } from '../compatWrappers.js';
