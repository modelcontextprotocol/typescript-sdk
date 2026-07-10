import type { Rolldown } from 'tsdown';

/**
 * Absolute paths of the core-internal schema source modules that are published verbatim as
 * @modelcontextprotocol/core (types/schemas.ts + shared/auth.ts). Single source of truth for
 * {@link externalizeCoreSchemas}; keep in sync with the aliases in packages/core/tsdown.config.ts.
 */
export declare const CORE_SCHEMA_MODULES: readonly string[];

/**
 * tsdown/rolldown plugin that rewrites every import resolving to one of {@link CORE_SCHEMA_MODULES} into an external
 * import of '@modelcontextprotocol/core', so built packages share ONE evaluated copy of the spec + OAuth Zod schema
 * graph per application. Asserts at build time, in both directions, that the rewrite actually happened — see the
 * implementation in externalizeCoreSchemas.tsdown.mjs for the full rationale.
 */
export declare function externalizeCoreSchemas(): Rolldown.Plugin;
