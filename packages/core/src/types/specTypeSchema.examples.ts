/**
 * Type-checked examples for `specTypeSchema.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { isSpecType, specTypeSchemas } from './specTypeSchema.js';

declare const untrusted: unknown;
declare const value: unknown;
declare const mixed: unknown[];

function specTypeSchemas_basicUsage() {
    //#region specTypeSchemas_basicUsage
    const result = specTypeSchemas.CallToolResult.parse(untrusted);
    // result is CallToolResult; throws SpecTypeValidationError on invalid input

    // Entries are Standard Schemas, so the underlying validator is also available:
    const validated = specTypeSchemas.CallToolResult['~standard'].validate(untrusted);
    if (validated.issues === undefined) {
        // validated.value is CallToolResult
    }
    //#endregion specTypeSchemas_basicUsage
    void result;
}

function specTypeSchemas_parse() {
    //#region specTypeSchemas_parse
    const result = specTypeSchemas.CallToolResult.parse(untrusted);
    // result is CallToolResult; throws SpecTypeValidationError on invalid input
    //#endregion specTypeSchemas_parse
    void result;
}

function specTypeSchemas_safeParse() {
    //#region specTypeSchemas_safeParse
    const parsed = specTypeSchemas.Tool.safeParse(untrusted);
    if (parsed.success) {
        // parsed.data is Tool
    } else {
        // parsed.issues describes the failures
    }
    //#endregion specTypeSchemas_safeParse
    void parsed;
}

function isSpecType_basicUsage() {
    /* eslint-disable unicorn/no-array-callback-reference -- showcasing the guard-as-callback pattern */
    //#region isSpecType_basicUsage
    if (isSpecType.ContentBlock(value)) {
        // value is ContentBlock
    }

    const blocks = mixed.filter(isSpecType.ContentBlock);
    //#endregion isSpecType_basicUsage
    /* eslint-enable unicorn/no-array-callback-reference */
    void blocks;
}

void specTypeSchemas_basicUsage;
void specTypeSchemas_parse;
void specTypeSchemas_safeParse;
void isSpecType_basicUsage;
