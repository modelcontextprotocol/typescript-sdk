export * from './auth/errors.js';
export * from './errors/sdkErrors.js';
export * from './shared/auth.js';
export * from './shared/authUtils.js';
export * from './shared/metadataUtils.js';
export * from './shared/protocol.js';
export * from './shared/responseMessage.js';
export * from './shared/stdio.js';
export * from './shared/toolNameValidation.js';
export * from './shared/transport.js';
export * from './shared/uriTemplate.js';
export * from './types/types.js';
export * from './util/inMemory.js';
export * from './util/zodCompat.js';
export * from './util/zodJsonSchemaCompat.js';

// experimental exports
export * from './experimental/index.js';
export * from './validation/ajvProvider.js';
export * from './validation/cfWorkerProvider.js';
/**
 * JSON Schema validation
 *
 * This module provides configurable JSON Schema validation for the MCP SDK.
 * Choose a validator based on your runtime environment:
 *
 * - AjvJsonSchemaValidator: Best for Node.js (default, fastest)
 *   Import from: @modelcontextprotocol/sdk/validation/ajv
 *   Requires peer dependencies: ajv, ajv-formats
 *
 * - CfWorkerJsonSchemaValidator: Best for edge runtimes
 *   Import from: @modelcontextprotocol/sdk/validation/cfworker
 *   Requires peer dependency: @cfworker/json-schema
 *
 * @example
 * ```typescript
 * // For Node.js with AJV
 * import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
 * const validator = new AjvJsonSchemaValidator();
 *
 * // For Cloudflare Workers
 * import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
 * const validator = new CfWorkerJsonSchemaValidator();
 * ```
 *
 * @module validation
 */

// Core types only - implementations are exported via separate entry points
export type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from './validation/types.js';
