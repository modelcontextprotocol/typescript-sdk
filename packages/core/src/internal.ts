// @modelcontextprotocol/core/internal
//
// Wholesale re-export of core's schema source modules for the SDK's own packages.
//
// The curated root entry (`@modelcontextprotocol/core`) exposes ONLY the public spec + OAuth
// `*Schema` constants. The sibling SDK packages additionally need the handful of names that are
// deliberately NOT public there — internal helper schemas (e.g. BaseRequestParamsSchema,
// SafeUrlSchema), the auth `type` exports, the protocol constants, and the JSON value types —
// because core-internal's modules at the old paths re-export these modules one-to-one.
//
// This subpath is an internal seam, not public API: anything meant for consumers belongs on the
// root entry (which a drift test pins). Names here may change without notice.
export * from './auth';
export * from './constants';
export * from './schemas';
export type { JSONArray, JSONObject, JSONValue } from './types';
