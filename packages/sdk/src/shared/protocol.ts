// v1 compat: `@modelcontextprotocol/sdk/shared/protocol.js`
// Protocol class is no longer public in v2; subclass Client or Server instead.
// Re-exporting the option types and context types that v1 callers commonly
// imported from this path.

export type {
    BaseContext,
    ClientContext,
    NotificationOptions,
    ProtocolOptions,
    RequestOptions,
    ServerContext
} from '@modelcontextprotocol/server';

/** @deprecated Use {@link ServerContext} (server handlers) or {@link ClientContext} (client handlers) in v2. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type RequestHandlerExtra<_ReqT = unknown, _NotifT = unknown> = import('@modelcontextprotocol/server').ServerContext;
