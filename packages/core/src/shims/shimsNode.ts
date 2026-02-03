/**
 * Node.js runtime shims
 *
 * This module provides Node.js-specific implementations for the MCP SDK.
 * It is automatically selected when running in Node.js environments.
 */

/**
 * Default JSON Schema validator for Node.js environments.
 * Uses Ajv for fast, spec-compliant validation.
 */
export { AjvJsonSchemaValidator as DefaultJsonSchemaValidator } from '../validation/ajvProvider.js';
