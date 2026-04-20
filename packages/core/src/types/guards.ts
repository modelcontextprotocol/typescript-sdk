import {
    CallToolResultSchema,
    InitializedNotificationSchema,
    InitializeRequestSchema,
    JSONRPCErrorResponseSchema,
    JSONRPCMessageSchema,
    JSONRPCNotificationSchema,
    JSONRPCRequestSchema,
    JSONRPCResponseSchema,
    JSONRPCResultResponseSchema,
    TaskAugmentedRequestParamsSchema
} from './schemas.js';
import type {
    CallToolResult,
    CompleteRequest,
    CompleteRequestPrompt,
    CompleteRequestResourceTemplate,
    InitializedNotification,
    InitializeRequest,
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    JSONRPCResultResponse,
    TaskAugmentedRequestParams
} from './types.js';

/**
 * Validates and parses an unknown value as a JSON-RPC message.
 *
 * Use this to validate incoming messages in custom transport implementations.
 * Throws if the value does not conform to the JSON-RPC message schema.
 *
 * @param value - The value to validate (typically a parsed JSON object).
 * @returns The validated {@linkcode JSONRPCMessage}.
 * @throws If validation fails.
 */
export function parseJSONRPCMessage(value: unknown): JSONRPCMessage {
    return JSONRPCMessageSchema.parse(value);
}

export const isJSONRPCRequest = (value: unknown): value is JSONRPCRequest => JSONRPCRequestSchema.safeParse(value).success;

export const isJSONRPCNotification = (value: unknown): value is JSONRPCNotification => JSONRPCNotificationSchema.safeParse(value).success;

/**
 * Checks if a value is a valid {@linkcode JSONRPCResultResponse}.
 * @param value - The value to check.
 *
 * @returns True if the value is a valid {@linkcode JSONRPCResultResponse}, false otherwise.
 */
export const isJSONRPCResultResponse = (value: unknown): value is JSONRPCResultResponse =>
    JSONRPCResultResponseSchema.safeParse(value).success;

/**
 * Checks if a value is a valid {@linkcode JSONRPCErrorResponse}.
 * @param value - The value to check.
 *
 * @returns True if the value is a valid {@linkcode JSONRPCErrorResponse}, false otherwise.
 */
export const isJSONRPCErrorResponse = (value: unknown): value is JSONRPCErrorResponse =>
    JSONRPCErrorResponseSchema.safeParse(value).success;

/**
 * Checks if a value is a valid {@linkcode JSONRPCResponse} (either a result or error response).
 * @param value - The value to check.
 *
 * @returns True if the value is a valid {@linkcode JSONRPCResponse}, false otherwise.
 */
export const isJSONRPCResponse = (value: unknown): value is JSONRPCResponse => JSONRPCResponseSchema.safeParse(value).success;

/**
 * Checks if a value is a valid {@linkcode CallToolResult}.
 * @param value - The value to check.
 *
 * @returns True if the value is a valid {@linkcode CallToolResult}, false otherwise.
 */
export const isCallToolResult = (value: unknown): value is CallToolResult => {
    if (typeof value !== 'object' || value === null || !('content' in value)) return false;
    return CallToolResultSchema.safeParse(value).success;
};

/**
 * Checks if a value is a valid {@linkcode TaskAugmentedRequestParams}.
 * @param value - The value to check.
 *
 * @returns True if the value is a valid {@linkcode TaskAugmentedRequestParams}, false otherwise.
 */
export const isTaskAugmentedRequestParams = (value: unknown): value is TaskAugmentedRequestParams =>
    TaskAugmentedRequestParamsSchema.safeParse(value).success;

export const isInitializeRequest = (value: unknown): value is InitializeRequest => InitializeRequestSchema.safeParse(value).success;

export const isInitializedNotification = (value: unknown): value is InitializedNotification =>
    InitializedNotificationSchema.safeParse(value).success;

export function assertCompleteRequestPrompt(request: CompleteRequest): asserts request is CompleteRequestPrompt {
    if (request.params.ref.type !== 'ref/prompt') {
        throw new TypeError(`Expected CompleteRequestPrompt, but got ${request.params.ref.type}`);
    }
    void (request as CompleteRequestPrompt);
}

export function assertCompleteRequestResourceTemplate(request: CompleteRequest): asserts request is CompleteRequestResourceTemplate {
    if (request.params.ref.type !== 'ref/resource') {
        throw new TypeError(`Expected CompleteRequestResourceTemplate, but got ${request.params.ref.type}`);
    }
    void (request as CompleteRequestResourceTemplate);
}
