/**
 * Single source of truth for request method → schema mappings.
 *
 * Each entry maps a method name to [RequestSchema, ResultSchema].
 * All type maps and runtime lookups are derived from these definitions.
 */

import type { Infer } from 'zod/v4';
import type { AnySchema } from '../util/zodCompat.js';
import type { CreateTaskResult } from './types.js';
import {
    // Shared
    PingRequestSchema,
    EmptyResultSchema,

    // Client → Server
    InitializeRequestSchema,
    InitializeResultSchema,
    CompleteRequestSchema,
    CompleteResultSchema,
    SetLevelRequestSchema,
    GetPromptRequestSchema,
    GetPromptResultSchema,
    ListPromptsRequestSchema,
    ListPromptsResultSchema,
    ListResourcesRequestSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesRequestSchema,
    ListResourceTemplatesResultSchema,
    ReadResourceRequestSchema,
    ReadResourceResultSchema,
    SubscribeRequestSchema,
    UnsubscribeRequestSchema,
    CallToolRequestSchema,
    CallToolResultSchema,
    ListToolsRequestSchema,
    ListToolsResultSchema,

    // Server → Client
    CreateMessageRequestSchema,
    CreateMessageResultSchema,
    ElicitRequestSchema,
    ElicitResultSchema,
    ListRootsRequestSchema,
    ListRootsResultSchema,

    // Tasks (bidirectional)
    GetTaskRequestSchema,
    GetTaskResultSchema,
    GetTaskPayloadRequestSchema,
    GetTaskPayloadResultSchema,
    ListTasksRequestSchema,
    ListTasksResultSchema,
    CancelTaskRequestSchema,
    CancelTaskResultSchema,
} from './types.js';

type MethodSchema = readonly [request: AnySchema, result: AnySchema];

/**
 * Client → Server request methods.
 * These are requests that clients send and servers handle.
 */
export const clientMethodSchemas = {
    'initialize':               [InitializeRequestSchema, InitializeResultSchema],
    'completion/complete':      [CompleteRequestSchema, CompleteResultSchema],
    'logging/setLevel':         [SetLevelRequestSchema, EmptyResultSchema],
    'prompts/get':              [GetPromptRequestSchema, GetPromptResultSchema],
    'prompts/list':             [ListPromptsRequestSchema, ListPromptsResultSchema],
    'resources/list':           [ListResourcesRequestSchema, ListResourcesResultSchema],
    'resources/templates/list': [ListResourceTemplatesRequestSchema, ListResourceTemplatesResultSchema],
    'resources/read':           [ReadResourceRequestSchema, ReadResourceResultSchema],
    'resources/subscribe':      [SubscribeRequestSchema, EmptyResultSchema],
    'resources/unsubscribe':    [UnsubscribeRequestSchema, EmptyResultSchema],
    'tools/call':               [CallToolRequestSchema, CallToolResultSchema],
    'tools/list':               [ListToolsRequestSchema, ListToolsResultSchema],
} as const satisfies Record<string, MethodSchema>;

/**
 * Server → Client request methods.
 * These are requests that servers send and clients handle.
 */
export const serverMethodSchemas = {
    'sampling/createMessage':   [CreateMessageRequestSchema, CreateMessageResultSchema],
    'elicitation/create':       [ElicitRequestSchema, ElicitResultSchema],
    'roots/list':               [ListRootsRequestSchema, ListRootsResultSchema],
} as const satisfies Record<string, MethodSchema>;

/**
 * Bidirectional request methods.
 * These can be sent by either client or server.
 */
export const sharedMethodSchemas = {
    'ping':                     [PingRequestSchema, EmptyResultSchema],
    'tasks/get':                [GetTaskRequestSchema, GetTaskResultSchema],
    'tasks/result':             [GetTaskPayloadRequestSchema, GetTaskPayloadResultSchema],
    'tasks/list':               [ListTasksRequestSchema, ListTasksResultSchema],
    'tasks/cancel':             [CancelTaskRequestSchema, CancelTaskResultSchema],
} as const satisfies Record<string, MethodSchema>;

/**
 * Combined mapping of all request methods to their schemas.
 */
export const methodSchemas = {
    ...clientMethodSchemas,
    ...serverMethodSchemas,
    ...sharedMethodSchemas,
} as const;

// =============================================================================
// Type Definitions (derived from the mappings)
// =============================================================================

/** All valid request method names */
export type RequestMethod = keyof typeof methodSchemas;

/** Methods that clients can send (client → server + shared) */
export type ClientRequestMethod = keyof typeof clientMethodSchemas | keyof typeof sharedMethodSchemas;

/** Methods that servers can send (server → client + shared) */
export type ServerRequestMethod = keyof typeof serverMethodSchemas | keyof typeof sharedMethodSchemas;

/** Maps method name → request type */
export type RequestTypeMap = {
    [M in RequestMethod]: Infer<(typeof methodSchemas)[M][0]>
};

/** Maps method name → result type */
export type ResultTypeMap = {
    [M in RequestMethod]: Infer<(typeof methodSchemas)[M][1]>
};

/** Methods that support task creation (can return CreateTaskResult) */
export type TaskAugmentedMethod = 'tools/call' | 'sampling/createMessage' | 'elicitation/create';

/** Maps method name → handler result type (includes CreateTaskResult for task-augmented methods) */
export type HandlerResultTypeMap = {
    [M in RequestMethod]: M extends TaskAugmentedMethod
        ? ResultTypeMap[M] | CreateTaskResult
        : ResultTypeMap[M]
};

// =============================================================================
// Runtime Lookups (direct property access - very fast)
// =============================================================================

/** Get the request schema for a method */
export function getRequestSchema<M extends RequestMethod>(method: M) {
    return methodSchemas[method][0];
}

/** Get the result schema for a method */
export function getResultSchema<M extends RequestMethod>(method: M) {
    return methodSchemas[method][1];
}
