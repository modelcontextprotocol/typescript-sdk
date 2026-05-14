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
export type { AjvJsonSchemaValidator } from './validators/ajvProvider.js';
// Validator providers are intentionally NOT re-exported as runtime values here: AJV
// and @cfworker/json-schema are optional peers, and importing either provider from
// the root barrel would force that backend on all consumers. Internal runtime shims
// import concrete defaults via explicit core validator subpaths.
export type { CfWorkerJsonSchemaValidator, CfWorkerSchemaDraft } from './validators/cfWorkerProvider.js';
export * from './validators/fromJsonSchema.js';
/**
 * JSON Schema validation
 *
 * This module provides configurable JSON Schema validation for the MCP SDK.
 * Choose a validator based on your runtime environment:
 *
 * - `AjvJsonSchemaValidator`: Best for Node.js (default, fastest)
 *   Used automatically by client/server Node shims.
 *
 * - `CfWorkerJsonSchemaValidator`: Best for edge runtimes
 *   Used automatically by client/server browser/workerd shims.
 *
 * Client and server packages bundle their runtime default validator backends, so most users should
 * rely on automatic runtime selection. Advanced users can pass their own validator implementation
 * through client/server options.
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
