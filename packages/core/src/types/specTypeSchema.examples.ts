/**
 * Type-checked examples for `specTypeSchema.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { isSpecType, specTypeSchema } from './specTypeSchema.js';

declare const untrusted: unknown;
declare const value: unknown;
declare const mixed: unknown[];

async function specTypeSchema_basicUsage() {
    //#region specTypeSchema_basicUsage
    const result = await specTypeSchema('CallToolResult')['~standard'].validate(untrusted);
    if (result.issues === undefined) {
        // result.value is CallToolResult
    }
    //#endregion specTypeSchema_basicUsage
    void result;
}

function isSpecType_basicUsage() {
    //#region isSpecType_basicUsage
    if (isSpecType('ContentBlock', value)) {
        // value is ContentBlock
    }

    const blocks = mixed.filter(v => isSpecType('ContentBlock', v));
    //#endregion isSpecType_basicUsage
    void blocks;
}

void specTypeSchema_basicUsage;
void isSpecType_basicUsage;
