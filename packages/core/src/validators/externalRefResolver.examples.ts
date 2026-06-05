/**
 * Type-checked examples for `externalRefResolver.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 *
 * @module
 */

import { resolveExternalSchemaRefs } from './externalRefResolver.js';
import type { JsonSchemaType } from './types.js';

declare const toolOutputSchema: JsonSchemaType;

/**
 * Example: opt in to resolving external `$ref`s ahead of time.
 */
async function resolveExternalSchemaRefs_basic() {
    //#region resolveExternalSchemaRefs_basic
    const resolved = await resolveExternalSchemaRefs(toolOutputSchema, {
        allowlist: ['schemas.example.com']
    });
    // `resolved` has no external $refs; hand it to registerTool / fromJsonSchema as usual.
    //#endregion resolveExternalSchemaRefs_basic
    return resolved;
}

export { resolveExternalSchemaRefs_basic };
