export interface ImportMapping {
    target: string;
    status: 'moved' | 'removed' | 'renamed';
    renamedSymbols?: Record<string, string>;
    /** Route specific symbols to a different target package than `target`. */
    symbolTargetOverrides?: Record<string, string>;
    /**
     * Route an imported symbol to this package (instead of `target`) when its rename-resolved name is
     * a Zod schema constant re-exported by core — a member of `SPEC_SCHEMA_NAMES` (spec schemas,
     * for `sdk/types.js`) or `AUTH_SCHEMA_NAMES` (OAuth/OpenID schemas, for `sdk/shared/auth.js`). The
     * schemas now live in `@modelcontextprotocol/core` (so `<Name>Schema.parse(...)` keeps
     * working), while the corresponding types/constants/guards resolve by context. Matching on
     * membership (not a `*Schema` suffix) keeps TYPES whose name ends in `Schema` — e.g. the
     * elicitation primitives `BooleanSchema`/`StringSchema`/`EnumSchema` — routed by context, where
     * their types live. `symbolTargetOverrides` (exact-name) takes precedence.
     */
    schemaSymbolTarget?: string;
    removalMessage?: string;
    /**
     * Symbols from this module that have no v2 export anywhere. They are dropped from
     * the rewritten import and the call site gets an action-required marker carrying
     * the message, instead of an import of a member the target package does not have.
     */
    removedSymbols?: Record<string, string>;
    /** Marks a module-level removal as a known v2 gap (downgrades the removal diagnostic to the v2-gap category). For per-symbol removals use `removedSymbols`. */
    isV2Gap?: boolean;
    /** Emitted as an info diagnostic after a successful move, suggesting eventual migration to v2 equivalents. */
    migrationHint?: string;
    /**
     * Subpath suffix appended after `RESOLVE_BY_CONTEXT` resolves the base package (e.g. `/validators/ajv`).
     * The final target becomes `@modelcontextprotocol/{client,server}<subpathSuffix>`.
     */
    subpathSuffix?: string;
}

/**
 * Resource-server auth helpers whose maintained v2 home is `@modelcontextprotocol/express`;
 * the server-legacy/auth copy they route to by default is a frozen v1 snapshot, so import
 * and re-export sites get a marker prompting a deliberate re-point.
 */
export const RS_ONLY_AUTH_SYMBOLS: ReadonlySet<string> = new Set([
    'requireBearerAuth',
    'mcpAuthMetadataRouter',
    'getOAuthProtectedResourceMetadataUrl',
    'OAuthTokenVerifier'
]);

export const IMPORT_MAP: Record<string, ImportMapping> = {
    '@modelcontextprotocol/sdk/client/index.js': {
        target: '@modelcontextprotocol/client',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/client/auth.js': {
        target: '@modelcontextprotocol/client',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/client/auth-extensions.js': {
        target: '@modelcontextprotocol/client',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/client/streamableHttp.js': {
        target: '@modelcontextprotocol/client',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/client/sse.js': {
        target: '@modelcontextprotocol/client',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/client/stdio.js': {
        target: '@modelcontextprotocol/client/stdio',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/client/websocket.js': {
        target: '',
        status: 'removed',
        removalMessage: 'WebSocketClientTransport removed in v2. Use StreamableHTTPClientTransport or StdioClientTransport.'
    },

    '@modelcontextprotocol/sdk/server/mcp.js': {
        target: '@modelcontextprotocol/server',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/server/index.js': {
        target: '@modelcontextprotocol/server',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/server/stdio.js': {
        target: '@modelcontextprotocol/server/stdio',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/server/streamableHttp.js': {
        target: '@modelcontextprotocol/server',
        status: 'renamed',
        renamedSymbols: {
            StreamableHTTPServerTransport: 'NodeStreamableHTTPServerTransport'
        },
        symbolTargetOverrides: {
            StreamableHTTPServerTransport: '@modelcontextprotocol/node',
            // The companion options type moved with the transport. @modelcontextprotocol/node
            // re-exports it under the same name (a backward-compat alias for
            // WebStandardStreamableHTTPServerTransportOptions), so route it there without renaming.
            StreamableHTTPServerTransportOptions: '@modelcontextprotocol/node'
        }
    },
    '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js': {
        target: '@modelcontextprotocol/server',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/server/sse.js': {
        target: '@modelcontextprotocol/server-legacy/sse',
        status: 'moved',
        migrationHint:
            'SSEServerTransport is deprecated. Migrate to NodeStreamableHTTPServerTransport from @modelcontextprotocol/node or WebStandardStreamableHTTPServerTransport from @modelcontextprotocol/server.'
    },
    '@modelcontextprotocol/sdk/server/middleware.js': {
        target: '@modelcontextprotocol/express',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js': {
        target: '@modelcontextprotocol/express',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/server/express.js': {
        target: '@modelcontextprotocol/express',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/server/zod-compat.js': {
        target: '',
        status: 'removed',
        removalMessage:
            'zod-compat removed in v2. AnySchema and SchemaOutput types have no v2 equivalent — v2 uses StandardSchemaV1 from @standard-schema/spec. Rewrite generic function signatures to use StandardSchemaV1 directly.'
    },

    '@modelcontextprotocol/sdk/server/auth/types.js': {
        // The module's only export (AuthInfo) is re-exported by both leaf packages, so
        // routing by context avoids pulling the deprecated legacy package into projects
        // that use no authorization-server helpers.
        target: 'RESOLVE_BY_CONTEXT',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/server/auth/provider.js': {
        target: '@modelcontextprotocol/server-legacy/auth',
        status: 'moved',
        migrationHint: 'Legacy OAuth AS provider. For RS-only auth, see requireBearerAuth from @modelcontextprotocol/express.'
    },
    '@modelcontextprotocol/sdk/server/auth/router.js': {
        target: '@modelcontextprotocol/server-legacy/auth',
        status: 'moved',
        migrationHint: 'Legacy OAuth AS router. For metadata-only endpoints, see mcpAuthMetadataRouter from @modelcontextprotocol/express.'
    },
    '@modelcontextprotocol/sdk/server/auth/middleware.js': {
        target: '@modelcontextprotocol/server-legacy/auth',
        status: 'moved',
        migrationHint: 'Legacy OAuth AS middleware. For bearer-only auth, see requireBearerAuth from @modelcontextprotocol/express.'
    },
    '@modelcontextprotocol/sdk/server/auth/errors.js': {
        target: '@modelcontextprotocol/server-legacy/auth',
        status: 'moved',
        migrationHint: 'Legacy error subclasses. v2 consolidates to OAuthError + OAuthErrorCode in @modelcontextprotocol/server.'
    },

    '@modelcontextprotocol/sdk/types.js': {
        target: 'RESOLVE_BY_CONTEXT',
        status: 'moved',
        schemaSymbolTarget: '@modelcontextprotocol/core',
        renamedSymbols: {
            ResourceTemplate: 'ResourceTemplateType'
        }
    },
    '@modelcontextprotocol/sdk/shared/protocol.js': {
        target: 'RESOLVE_BY_CONTEXT',
        status: 'moved',
        removedSymbols: {
            Protocol:
                'The Protocol base class is not exported by the v2 packages. To observe or handle inbound requests ' +
                'that have no registered handler, use client.fallbackRequestHandler / server.fallbackRequestHandler; ' +
                'build custom behavior on Client or Server instead of subclassing Protocol. ' +
                'See the migration guide: Behavioral changes > Client connection & dispatch.',
            mergeCapabilities:
                'mergeCapabilities() is not exported by the v2 packages. Pass the complete capabilities object to the ' +
                'Client/Server constructor, or merge capability objects with a plain object spread.'
        }
    },
    '@modelcontextprotocol/sdk/shared/transport.js': {
        target: 'RESOLVE_BY_CONTEXT',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/shared/auth-utils.js': {
        target: 'RESOLVE_BY_CONTEXT',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/client/middleware.js': {
        target: '@modelcontextprotocol/client',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/shared/uriTemplate.js': {
        target: 'RESOLVE_BY_CONTEXT',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/shared/auth.js': {
        target: 'RESOLVE_BY_CONTEXT',
        status: 'moved',
        // OAuth/OpenID Zod schema constants (AUTH_SCHEMA_NAMES) are re-exported by core as a
        // separate group, so route them there (keeping `OAuthTokensSchema.parse(...)` working). The
        // OAuth/OpenID TYPES (OAuthTokens, etc.) carry no `schemaSymbolTarget` match and resolve by
        // context to @modelcontextprotocol/client | /server.
        schemaSymbolTarget: '@modelcontextprotocol/core'
    },
    '@modelcontextprotocol/sdk/shared/stdio.js': {
        target: 'RESOLVE_BY_CONTEXT',
        status: 'moved'
    },

    '@modelcontextprotocol/sdk/server/completable.js': {
        target: '@modelcontextprotocol/server',
        status: 'moved'
    },

    '@modelcontextprotocol/sdk/experimental/tasks': {
        target: '',
        status: 'removed',
        removalMessage: 'Experimental tasks removed in v2 (SEP-2663 — tasks moved to the Extensions Track). No v2 equivalent.'
    },
    '@modelcontextprotocol/sdk/experimental/tasks.js': {
        target: '',
        status: 'removed',
        removalMessage: 'Experimental tasks removed in v2 (SEP-2663 — tasks moved to the Extensions Track). No v2 equivalent.'
    },

    '@modelcontextprotocol/sdk/inMemory.js': {
        target: 'RESOLVE_BY_CONTEXT',
        status: 'moved'
    }
};

// v1 `validation/*` paths → v2 `validators/*` subpaths. The canonical `*-provider.js` filename and
// the short aliases from the v1 README, with and without `.js` suffix.
const VALIDATOR_V1_VARIANTS: Record<string, readonly string[]> = {
    '/validators/ajv': ['validation/ajv-provider.js', 'validation/ajv.js', 'validation/ajv'],
    '/validators/cf-worker': ['validation/cfworker-provider.js', 'validation/cfworker.js', 'validation/cfworker']
};
for (const [subpathSuffix, v1Specifiers] of Object.entries(VALIDATOR_V1_VARIANTS)) {
    for (const v1Specifier of v1Specifiers) {
        IMPORT_MAP[`@modelcontextprotocol/sdk/${v1Specifier}`] = {
            target: 'RESOLVE_BY_CONTEXT',
            status: 'moved',
            subpathSuffix
        };
    }
}

// `validation/index` / `validation/types` carry only the `jsonSchemaValidator` interface + helpers.
for (const barrelSpecifier of ['@modelcontextprotocol/sdk/validation/index.js', '@modelcontextprotocol/sdk/validation/types.js']) {
    IMPORT_MAP[barrelSpecifier] = { target: 'RESOLVE_BY_CONTEXT', status: 'moved' };
}

export function isAuthImport(specifier: string): boolean {
    return specifier.includes('/server/auth/') || specifier.includes('/server/auth.');
}

// SDK subpath specifiers can be written with or without a JS extension
// (e.g. `@modelcontextprotocol/sdk/types` vs `.../types.js`) depending on the
// consumer's module resolution (`bundler`/`nodenext` allow the extensionless form).
// Normalize the extension so both spellings resolve to the same mapping. Built
// after every IMPORT_MAP entry above is populated; entries whose `.js` and
// extensionless forms coexist (e.g. `experimental/tasks`) share an identical
// mapping, so the collapse is lossless.
function stripJsExtension(specifier: string): string {
    return specifier.replace(/\.(?:js|mjs|cjs)$/, '');
}

const NORMALIZED_IMPORT_MAP: Record<string, ImportMapping> = {};
for (const [key, mapping] of Object.entries(IMPORT_MAP)) {
    NORMALIZED_IMPORT_MAP[stripJsExtension(key)] = mapping;
}

/**
 * Resolves the v2 mapping for a v1 SDK import/export/mock specifier, tolerating
 * JS extension variance. An exact match always wins; otherwise the specifier is
 * matched ignoring a trailing `.js`/`.mjs`/`.cjs` (or its absence).
 */
export function lookupImportMapping(specifier: string): ImportMapping | undefined {
    return IMPORT_MAP[specifier] ?? NORMALIZED_IMPORT_MAP[stripJsExtension(specifier)];
}
