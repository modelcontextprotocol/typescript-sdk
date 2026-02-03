/**
 * Default runtime shims
 *
 * This module re-exports from the Node.js shims as the default fallback.
 * Runtime-specific implementations are selected via package.json export conditions.
 *
 * @example
 * ```typescript
 * // Automatically selects the right validator for your runtime
 * import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/core/_shims';
 * const validator = new DefaultJsonSchemaValidator();
 * ```
 */

export * from './shimsNode.js';
