export * from './auth/errors.js';
export * from './errors/sdkErrors.js';
export * from './shared/auth.js';
export * from './shared/authUtils.js';
export * from './shared/metadataUtils.js';
export * from './shared/protocol.js';
export * from './shared/responseMessage.js';
export * from './shared/stdio.js';
export type { RequestTaskStore, TaskContext, TaskManagerOptions, TaskRequestOptions } from './shared/taskManager.js';
export { extractTaskManagerOptions, NullTaskManager, TaskManager } from './shared/taskManager.js';
export * from './shared/toolNameValidation.js';
export * from './shared/transport.js';
export * from './shared/uriTemplate.js';
export * from './types/index.js';
export * from './util/inMemory.js';
export * from './util/schema.js';
export * from './util/standardSchema.js';
export * from './util/zodCompat.js';

// experimental exports
export * from './experimental/index.js';
export * from './validators/ajvProvider.js';
// cfWorkerProvider is intentionally NOT re-exported here: it statically imports
// `@cfworker/json-schema` (an optional peer), and bundling it into the main barrel
// would force that import on all Node consumers. Import via `@modelcontextprotocol/core/validators/cfWorker`
// (used by the workerd/browser `_shims` and the public `/validators/cf-worker` subpaths).
export type { CfWorkerSchemaDraft } from './validators/cfWorkerProvider.js';
export * from './validators/fromJsonSchema.js';
/**
 * JSON Schema validation
 *
 * This module provides configurable JSON Schema validation for the MCP SDK.
 * Choose a validator based on your runtime environment:
 *
 * - {@linkcode AjvJsonSchemaValidator}: Best for Node.js (default, fastest)
 *   Bundled — no additional dependencies required.
 *
 * - `CfWorkerJsonSchemaValidator`: Best for edge runtimes
 *   Import from: `@modelcontextprotocol/server/validators/cf-worker` or `@modelcontextprotocol/client/validators/cf-worker`
 *   Bundled — no additional dependencies required.
 *
 * @example For Node.js with AJV
 * ```ts source="./index.examples.ts#validation_ajv"
 * const validator = new AjvJsonSchemaValidator();
 * ```
 *
 * @example For Cloudflare Workers
 * ```ts source="./index.examples.ts#validation_cfWorker"
 * const validator = new CfWorkerJsonSchemaValidator();
 * ```
 *
 * @module validation
 */

// Core types only - implementations are exported via separate entry points
export type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from './validators/types.js';
