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
        target: '@modelcontextprotocol/client',
        status: 'moved',
        symbolTargetOverrides: {
            StdioClientTransport: '@modelcontextprotocol/client/stdio',
            DEFAULT_INHERITED_ENV_VARS: '@modelcontextprotocol/client/stdio',
            getDefaultEnvironment: '@modelcontextprotocol/client/stdio',
            StdioServerParameters: '@modelcontextprotocol/client/stdio'
        }
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
        migrationHint: 'SSEServerTransport is deprecated. Migrate to StreamableHTTPServerTransport from @modelcontextprotocol/server.'
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
        migrationHint: 'Legacy OAuth AS provider. For RS-only auth, see @modelcontextprotocol/express.'
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
        target: '@modelcontextprotocol/server',
        status: 'moved'
    },
    '@modelcontextprotocol/sdk/experimental/tasks.js': {
        target: '@modelcontextprotocol/server',
        status: 'moved'
    },

    '@modelcontextprotocol/sdk/inMemory.js': {
        target: 'RESOLVE_BY_CONTEXT',
        status: 'moved'
    }
};

export function isAuthImport(specifier: string): boolean {
    return specifier.includes('/server/auth/') || specifier.includes('/server/auth.');
}
