/**
 * Type-checked examples for `sdkErrors.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { SdkError, SdkErrorCode } from './sdkErrors.js';

/**
 * Example: Throwing and catching SDK errors.
 */
function SdkError_basicUsage() {
    //#region SdkError_basicUsage
    try {
        // Throwing an SDK error
        throw new SdkError(SdkErrorCode.NotConnected, 'Transport is not connected');
    } catch (error) {
        // Checking error type by code
        if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
            // Handle timeout
        }
    }
    //#endregion SdkError_basicUsage
}
