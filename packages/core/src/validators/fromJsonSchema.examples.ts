/**
 * Type-checked examples for `fromJsonSchema.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 *
 * @module
 */

import { AjvJsonSchemaValidator } from './ajvProvider.js';
import { fromJsonSchema } from './fromJsonSchema.js';

/**
 * Example: wrap a raw JSON Schema object for use with registerTool.
 */
function fromJsonSchema_basicUsage() {
    //#region fromJsonSchema_basicUsage
    const inputSchema = fromJsonSchema<{ name: string }>(
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        new AjvJsonSchemaValidator()
    );
    // Use with server.registerTool('greet', { inputSchema }, handler)
    //#endregion fromJsonSchema_basicUsage
    return inputSchema;
}
