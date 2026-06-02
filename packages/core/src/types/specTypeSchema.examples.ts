/**
 * Type-checked examples for `specTypeSchema.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { isSpecType, parseSpecType, safeParseSpecType, specTypeSchemas } from './specTypeSchema.js';

declare const untrusted: unknown;
declare const value: unknown;
declare const mixed: unknown[];

function specTypeSchemas_basicUsage() {
    //#region specTypeSchemas_basicUsage
    const result = specTypeSchemas.CallToolResult['~standard'].validate(untrusted);
    if (result.issues === undefined) {
        // result.value is CallToolResult
    }
    //#endregion specTypeSchemas_basicUsage
    void result;
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

function parseSpecType_basicUsage() {
    //#region parseSpecType_basicUsage
    const result = parseSpecType('CallToolResult', untrusted);
    // result is CallToolResult; throws SpecTypeValidationError on invalid input
    //#endregion parseSpecType_basicUsage
    void result;
}

function safeParseSpecType_basicUsage() {
    //#region safeParseSpecType_basicUsage
    const parsed = safeParseSpecType('Tool', untrusted);
    if (parsed.success) {
        // parsed.data is Tool
    } else {
        // parsed.issues describes the failures
    }
    //#endregion safeParseSpecType_basicUsage
    void parsed;
}

void specTypeSchemas_basicUsage;
void isSpecType_basicUsage;
void parseSpecType_basicUsage;
void safeParseSpecType_basicUsage;
