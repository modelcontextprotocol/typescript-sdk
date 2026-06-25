/**
 * Type-checked examples for `fromJsonSchema.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 *
 * @module
 */

import { fromJsonSchema } from './fromJsonSchema';
import type { jsonSchemaValidator } from './types';

declare const validator: jsonSchemaValidator;

/**
 * Example: wrap a raw JSON Schema object for use with registerTool.
 *
 * Consumers importing `fromJsonSchema` from `@modelcontextprotocol/server` or
 * `@modelcontextprotocol/client` omit the second argument — the runtime shim
 * supplies the appropriate default validator.
 */
function fromJsonSchema_basicUsage() {
    //#region fromJsonSchema_basicUsage
    const inputSchema = fromJsonSchema<{ name: string }>(
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        validator
    );
    // Use with server.registerTool('greet', { inputSchema }, handler)
    //#endregion fromJsonSchema_basicUsage
    return inputSchema;
}
