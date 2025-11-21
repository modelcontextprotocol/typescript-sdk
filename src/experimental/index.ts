/**
 * Experimental MCP features.
 *
 * APIs in this module may change without notice in future versions.
 * Use at your own risk.
 *
 * @module experimental
 */

// URL Elicitation - experimental feature introduced in MCP 2025-11-25
export {
    // Schemas
    ElicitRequestURLParamsSchema,
    ElicitationCompleteNotificationParamsSchema,
    ElicitationCompleteNotificationSchema,

    // Types
    type ElicitRequestURLParams,
    type ElicitationCompleteNotificationParams,
    type ElicitationCompleteNotification,

    // Error class
    UrlElicitationRequiredError
} from '../types.js';

// Re-export experimental feature classes
export { ExperimentalServerFeatures } from '../server/experimental.js';
export { ExperimentalClientFeatures, type ElicitationCompleteHandler } from '../client/experimental.js';
