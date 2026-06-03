export interface ImportMapping {
    target: string;
    status: 'moved' | 'removed' | 'renamed';
    renamedSymbols?: Record<string, string>;
    /** Route specific symbols to a different target package than `target`. */
    symbolTargetOverrides?: Record<string, string>;
    removalMessage?: string;
    /** No entries currently set this; scaffolding for when a v1 symbol has no v2 equivalent yet. */
    isV2Gap?: boolean;
    /** Emitted as an info diagnostic after a successful move, suggesting eventual migration to v2 equivalents. */
    migrationHint?: string;
    /**
     * Subpath suffix appended after `RESOLVE_BY_CONTEXT` resolves the base package (e.g. `/validators/ajv`).
     * The final target becomes `@modelcontextprotocol/{client,server}<subpathSuffix>`.
     */
    subpathSuffix?: string;
}

export const IMPORT_MAP: Record<string, ImportMapping> = {
    '@modelcontextprotocol/sdk/client/index.js': {
        target: '@modelcontextprotocol/client',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/client/auth.js': {
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
            StreamableHTTPServerTransport: '@modelcontextprotocol/node'
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
    '@modelcontextprotocol/sdk/server/zod-compat.js': {
        target: '',
        status: 'removed',
        removalMessage:
            'zod-compat removed in v2. AnySchema and SchemaOutput types have no v2 equivalent — v2 uses StandardSchemaV1 from @standard-schema/spec. Rewrite generic function signatures to use StandardSchemaV1 directly.'
    },

    '@modelcontextprotocol/sdk/server/auth/types.js': {
        target: '@modelcontextprotocol/server-legacy/auth',
        status: 'moved',
        migrationHint: 'Legacy auth types. AuthInfo is also re-exported by @modelcontextprotocol/server.'
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
        renamedSymbols: {
            ResourceTemplate: 'ResourceTemplateType'
        }
    },
    '@modelcontextprotocol/sdk/shared/protocol.js': {
        target: 'RESOLVE_BY_CONTEXT',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/shared/transport.js': {
        target: 'RESOLVE_BY_CONTEXT',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/shared/uriTemplate.js': {
        target: 'RESOLVE_BY_CONTEXT',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/shared/auth.js': {
        target: 'RESOLVE_BY_CONTEXT',
        status: 'moved'
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
