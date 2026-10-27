// @modelcontextprotocol/core/ext/tasks
//
// Shared surface of the MCP Tasks extension (SEP-2663): wire constants, Zod
// schemas and the types inferred from them. The server half is
// `@modelcontextprotocol/server/ext/tasks`, the client half
// `@modelcontextprotocol/client/ext/tasks`.

export { TASK_STATUSES, TASKS_EXTENSION_ID } from './constants';
export * from './schemas';
export type * from './types';
