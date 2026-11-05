/**
 * @modelcontextprotocol/core/ext/tasks
 *
 * Shared surface of the MCP Tasks extension (SEP-2663): wire constants, Zod
 * schemas and the types inferred from them. The server half is
 * `@modelcontextprotocol/server/ext/tasks`, the client half
 * `@modelcontextprotocol/client/ext/tasks`.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 * @module
 */
export { TASK_STATUSES, TASKS_EXTENSION_ID } from './constants';
export * from './schemas';
export type * from './types';
