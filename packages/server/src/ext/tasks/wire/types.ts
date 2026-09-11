/*
 * MCP Tasks extension wire types (extension id: io.modelcontextprotocol/tasks).
 *
 * Adapted from modelcontextprotocol/ext-tasks, pinned at commit dcc8d2b
 * (SEP-2663 Final): `schema/draft/schema.ts`, re-based on
 * `@modelcontextprotocol/server` v2 types — the modern SDK ships the MRTR
 * `InputRequest`/`InputResponse` unions the upstream file's TODOs point at, so
 * those are re-exported rather than re-declared. The JSON-RPC request shapes
 * are declared standalone (not extending the SDK's `JSONRPCRequest`) so the
 * wire contract stays pinned to this file. `notifications/tasks` and the
 * subscription additions are omitted: v1 is polling-only (the engine contract)).
 *
 * This module (with ./schemas) is the ONLY import source for task wire types
 * in this repo — the SDK's deprecated 2025-11-25 task exports (`Task`,
 * `CreateTaskResult`, `TaskStatus`, `GetTaskRequest`, ...) carry the removed
 * legacy wire shape and must not be used (the engine contract)).
 * https://github.com/modelcontextprotocol/ext-tasks
 *
 * Copyright (c) Model Context Protocol contributors
 */

import type { InputRequests, InputResponses, Result } from '../../../index';

/**
 * A single input request / response embedded in a task, re-based on the SDK
 * v2 MRTR unions (sampling, roots, or elicitation). Keys in the containing
 * maps MUST be unique over the lifetime of a single task.
 */
export type { InputRequest, InputRequests, InputResponse, InputResponses } from '../../../index';

/** The MCP Tasks extension identifier. An empty-object capability declares support. */
export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';

/** All task statuses, in lifecycle order (terminal states last). */
export const TASK_STATUSES = ['working', 'input_required', 'completed', 'failed', 'cancelled'] as const;

/** The status of a task. */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Data associated with a task. */
export interface Task {
    /** The task identifier. */
    taskId: string;

    /** Current task status. */
    status: TaskStatus;

    /**
     * Optional human-readable message describing the current task state:
     * progress descriptions for "working", blocked work for "input_required",
     * reasons for "cancelled", summaries for "completed", diagnostics for
     * "failed".
     */
    statusMessage?: string;

    /** ISO 8601 timestamp when the task was created. */
    createdAt: string;

    /** ISO 8601 timestamp when the task was last updated. */
    lastUpdatedAt: string;

    /**
     * Time-to-live duration from creation in integer milliseconds, null for
     * unlimited. The server may discard the task after the TTL elapses. This
     * value MAY change over the lifetime of a task.
     */
    ttlMs: number | null;

    /**
     * Suggested polling interval in integer milliseconds. Clients SHOULD honor
     * this value to avoid overwhelming the server. This value MAY change over
     * the lifetime of a task.
     */
    pollIntervalMs?: number;
}

/** A task that is in a normal working state. */
export interface WorkingTask extends Task {
    status: 'working';
}

/** A task that is waiting for input from the client. */
export interface InputRequiredTask extends Task {
    status: 'input_required';

    /**
     * Server-to-client requests that need to be fulfilled during task
     * execution. Keys are arbitrary identifiers for matching requests to
     * responses.
     */
    inputRequests: InputRequests;
}

/** A task that has completed successfully. */
export interface CompletedTask extends Task {
    status: 'completed';

    /**
     * The final result of the task. The structure matches the result type of
     * the original request — for a `tools/call` task, the `CallToolResult`
     * structure.
     */
    result: { [key: string]: unknown };
}

/** A task that has failed due to a JSON-RPC error during execution. */
export interface FailedTask extends Task {
    status: 'failed';

    /** The JSON-RPC error that caused the task to fail. */
    error: { [key: string]: unknown };
}

/** A task that has been cancelled. */
export interface CancelledTask extends Task {
    status: 'cancelled';
}

/**
 * A task with status-specific fields inlined, as returned by `tasks/get`:
 * terminal results or pending input requests ride on the snapshot itself.
 */
export type DetailedTask = WorkingTask | InputRequiredTask | CompletedTask | FailedTask | CancelledTask;

/**
 * The result returned by a server in lieu of a standard result shape when it
 * elects to process a request asynchronously — flat `Result & Task`. The
 * `resultType` field MUST be `"task"` on the wire; it is declared explicitly
 * here (the upstream type leaves it to the old SDK `Result`'s index
 * signature, which the v2 `Result` no longer has).
 */
export type CreateTaskResult = Result & Task & { resultType: 'task' };

/** Parameters of a `tasks/get` request. */
export interface GetTaskParams {
    /** The task identifier to query. */
    taskId: string;

    /**
     * The modern (2026-07-28) per-request envelope: carries
     * `io.modelcontextprotocol/clientCapabilities` among other keys. Not part
     * of the upstream extension schema's params (which lists only `taskId`) —
     * declared here because every modern request threads it.
     */
    _meta?: Record<string, unknown>;
}

/** A request to retrieve the state of a task. */
export interface GetTaskRequest {
    jsonrpc: '2.0';
    id: string | number;
    method: 'tasks/get';
    params: GetTaskParams;
}

/**
 * The response to `tasks/get`: the appropriate {@link DetailedTask} variant
 * for the task's current status, with `resultType: "complete"` (MUST).
 */
export type GetTaskResult = Result & DetailedTask & { resultType: 'complete' };

/** Parameters of a `tasks/update` request. */
export interface UpdateTaskParams {
    /** The task identifier to update. */
    taskId: string;

    /**
     * Responses to outstanding inputRequests previously surfaced by the
     * server. Each key MUST correspond to a currently-outstanding inputRequest
     * key (unknown keys are ignored; partial responses are accepted).
     */
    inputResponses: InputResponses;

    /** The modern per-request envelope (see {@link GetTaskParams._meta}). */
    _meta?: Record<string, unknown>;
}

/** A request to provide input responses to a task in the input_required state. */
export interface UpdateTaskRequest {
    jsonrpc: '2.0';
    id: string | number;
    method: 'tasks/update';
    params: UpdateTaskParams;
}

/**
 * The response to `tasks/update`: an empty acknowledgement (eventually
 * consistent), with `resultType: "complete"` (MUST).
 */
export type UpdateTaskResult = Result & { resultType: 'complete' };

/** Parameters of a `tasks/cancel` request. */
export interface CancelTaskParams {
    /** The task identifier to cancel. */
    taskId: string;

    /** The modern per-request envelope (see {@link GetTaskParams._meta}). */
    _meta?: Record<string, unknown>;
}

/** A request to cancel a task. Cancellation is cooperative and eventually consistent. */
export interface CancelTaskRequest {
    jsonrpc: '2.0';
    id: string | number;
    method: 'tasks/cancel';
    params: CancelTaskParams;
}

/**
 * The response to `tasks/cancel`: an empty acknowledgement (ack does not mean
 * stopped), with `resultType: "complete"` (MUST).
 */
export type CancelTaskResult = Result & { resultType: 'complete' };

/**
 * The extension capability declaration for the tasks extension. An empty
 * object indicates support; no extension-specific settings are currently
 * defined.
 */
export type TasksExtensionCapability = Record<string, never>;
