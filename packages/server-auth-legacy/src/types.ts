/**
 * Information about a validated access token, provided to request handlers.
 *
 * Re-exported from `@modelcontextprotocol/core` so that tokens verified by the
 * legacy `requireBearerAuth` middleware are structurally compatible with
 * the v2 SDK's request-handler context.
 */
export type { AuthInfo } from '@modelcontextprotocol/core';
