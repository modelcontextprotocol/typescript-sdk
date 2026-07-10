// @modelcontextprotocol/core/internal
//
// ⚠️  SDK-INTERNAL CONTRACT — NOT PUBLIC API.
//
// This subpath is a private seam between the @modelcontextprotocol packages: core-internal's
// re-export shims resolve their old module paths through it, and the client/server/server-legacy
// bundles import it as a real external dependency instead of carrying their own schema copies.
// Its surface is whatever the sibling packages need in lockstep with this exact core version —
// it may change in ANY release, including patches, with no deprecation cycle.
//
// Do not import from this subpath in application code. Everything meant for consumers is on the
// package's public root entry (`@modelcontextprotocol/core`), which a drift test pins.
//
// Why the split: the curated root entry exposes ONLY the public spec + OAuth `*Schema` constants.
// The sibling SDK packages additionally need the handful of names that are deliberately NOT
// public there — internal helper schemas (e.g. BaseRequestParamsSchema, SafeUrlSchema), the auth
// `type` exports, the protocol constants, and the JSON value types.

/** @internal */
export * from './auth';
/** @internal */
export * from './constants';
/** @internal */
export * from './schemas';
/** @internal */
export type { JSONArray, JSONObject, JSONValue } from './types';
