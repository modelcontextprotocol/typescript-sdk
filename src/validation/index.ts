/**
 * JSON Schema validation
 *
 * This module provides configurable JSON Schema validation for the MCP SDK.
 * The SDK automatically selects the appropriate validator based on your runtime
 * environment using export conditions:
 *
 * - Node.js: Automatically uses AjvJsonSchemaValidator (fastest, requires ajv and ajv-formats)
 * - Cloudflare Workers (workerd): Automatically uses CfWorkerJsonSchemaValidator (requires @cfworker/json-schema)
 *
 * Simply import the default validator and it will work in your environment:
 *
 * @example
 * ```typescript
 * // Automatically selects the right validator for your runtime
 * import DefaultValidator from '@modelcontextprotocol/sdk/validation/default';
 * const validator = new DefaultValidator();
 * ```
 *
 * For advanced use cases, you can also import validators directly:
 * - `@modelcontextprotocol/sdk/validation/ajv` - AjvJsonSchemaValidator (Node.js)
 * - `@modelcontextprotocol/sdk/validation/cfworker` - CfWorkerJsonSchemaValidator (edge runtimes)
 *
 * @module validation
 */

// Core types only - implementations are exported via separate entry points
export type { JsonSchemaType, JsonSchemaValidator, JsonSchemaValidatorResult, jsonSchemaValidator } from './types.js';
