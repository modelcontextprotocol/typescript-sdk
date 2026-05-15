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
 * Client and server packages automatically select a JSON Schema validator backend based on the
 * runtime: AJV-backed on Node.js, `@cfworker/json-schema`-backed on browser/workerd. Both backends
 * are bundled into the corresponding shim, so consumers do not need to install or import validator
 * packages for the default behaviour.
 *
 * To override validation, pass an object implementing the {@link jsonSchemaValidator} interface as
 * `jsonSchemaValidator` on the client/server options. See `validators/types.ts` for the contract
 * and a sample implementation.
 *
 * @module validation
 */

// Core types only - implementations are exported via separate entry points
export type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from './validators/types.js';
