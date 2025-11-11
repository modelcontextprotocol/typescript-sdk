/**
 * Compatibility wrapper for converting Zod schemas to JSON Schema.
 * Supports both Zod 3 (via zod-to-json-schema) and Zod 4 (via native z.toJSONSchema).
 */

import { ZodType } from 'zod';

// Store the imported function to avoid repeated dynamic imports
let zodToJsonSchemaFn: ((schema: ZodType, options?: { strictUnions?: boolean; pipeStrategy?: 'input' | 'output' }) => unknown) | null =
    null;
let importAttempted = false;

/**
 * Converts a Zod schema to JSON Schema, supporting both Zod 3 and Zod 4.
 */
export function zodToJsonSchema(schema: ZodType, options?: { strictUnions?: boolean; pipeStrategy?: 'input' | 'output' }): unknown {
    // Try Zod 4's native toJSONSchema first
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const z = schema.constructor as any;
    if (z.toJSONSchema && typeof z.toJSONSchema === 'function') {
        // Zod 4 native support
        try {
            return z.toJSONSchema(schema);
        } catch {
            // Fall through to zod-to-json-schema
        }
    }

    // Fall back to zod-to-json-schema for Zod 3
    if (!importAttempted) {
        importAttempted = true;
        try {
            // Dynamic import for optional dependency - works in both ESM and CJS
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const zodToJsonSchemaModule = eval('require')('zod-to-json-schema');
            zodToJsonSchemaFn =
                zodToJsonSchemaModule.zodToJsonSchema || zodToJsonSchemaModule.default?.zodToJsonSchema || zodToJsonSchemaModule.default;
        } catch (e: unknown) {
            const error = e as { code?: string; message?: string };
            if (error?.code === 'MODULE_NOT_FOUND' || error?.message?.includes('Cannot find module')) {
                throw new Error(
                    'zod-to-json-schema is required for Zod 3 support but is not installed. ' +
                        'Please install it: npm install zod-to-json-schema'
                );
            }
            throw e;
        }
    }

    if (!zodToJsonSchemaFn) {
        throw new Error('zod-to-json-schema module found but zodToJsonSchema function not available');
    }

    return zodToJsonSchemaFn(schema, options);
}
