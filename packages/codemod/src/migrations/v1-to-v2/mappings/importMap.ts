export interface ImportMapping {
    target: string;
    status: 'moved' | 'removed' | 'renamed';
    renamedSymbols?: Record<string, string>;
    /** Route specific symbols to a different target package than `target`. */
    symbolTargetOverrides?: Record<string, string>;
    removalMessage?: string;
    isV2Gap?: boolean;
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
        target: '',
        status: 'removed',
        removalMessage: 'SSE server transport removed in v2. Migrate to NodeStreamableHTTPServerTransport from @modelcontextprotocol/node.'
    },
    '@modelcontextprotocol/sdk/server/middleware.js': {
        target: '@modelcontextprotocol/express',
        status: 'moved'
    },

    '@modelcontextprotocol/sdk/server/auth/types.js': {
        target: '',
        status: 'removed',
        removalMessage:
            'Server auth removed in v2. AuthInfo is now re-exported by @modelcontextprotocol/client and @modelcontextprotocol/server.'
    },
    '@modelcontextprotocol/sdk/server/auth/provider.js': {
        target: '',
        status: 'removed',
        removalMessage:
            'Server auth provider removed in v2. For Resource-Server auth (token verification), see @modelcontextprotocol/express. For full OAuth AS, see @modelcontextprotocol/server-auth-legacy (PR #1908).'
    },
    '@modelcontextprotocol/sdk/server/auth/router.js': {
        target: '',
        status: 'removed',
        removalMessage:
            'Server auth router removed in v2. For metadata endpoints, see mcpAuthMetadataRouter from @modelcontextprotocol/express. For full OAuth AS router, see @modelcontextprotocol/server-auth-legacy (PR #1908).'
    },
    '@modelcontextprotocol/sdk/server/auth/middleware.js': {
        target: '',
        status: 'removed',
        removalMessage:
            'Server auth middleware removed in v2. For bearer token validation, see requireBearerAuth from @modelcontextprotocol/express. For full OAuth AS, see @modelcontextprotocol/server-auth-legacy (PR #1908).'
    },
    '@modelcontextprotocol/sdk/server/auth/errors.js': {
        target: '',
        status: 'removed',
        removalMessage:
            'Auth error subclasses consolidated in v2. Use OAuthError + OAuthErrorCode from @modelcontextprotocol/server. See also @modelcontextprotocol/server-auth-legacy (PR #1908).'
    },

    '@modelcontextprotocol/sdk/types.js': {
        target: 'RESOLVE_BY_CONTEXT',
        status: 'moved'
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
