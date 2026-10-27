/**
 * Wire constants for the MCP Tasks extension (SEP-2663).
 *
 * Runtime-neutral: this module imports nothing.
 */

/** The MCP Tasks extension identifier. An empty-object capability declares support. */
export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';

/** All task statuses, in lifecycle order (terminal states last). */
export const TASK_STATUSES = ['working', 'input_required', 'completed', 'failed', 'cancelled'] as const;
