// v1 compat: `@modelcontextprotocol/sdk/shared/protocol.js`

export type {
    BaseContext,
    ClientContext,
    NotificationOptions,
    ProtocolOptions,
    ProtocolSpec,
    RequestOptions,
    ServerContext
} from '@modelcontextprotocol/server';
export { DEFAULT_REQUEST_TIMEOUT_MSEC, Protocol } from '@modelcontextprotocol/server';

/** @deprecated Use {@link ServerContext} (server handlers) or {@link ClientContext} (client handlers) in v2. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type RequestHandlerExtra<_ReqT = unknown, _NotifT = unknown> = import('@modelcontextprotocol/server').ServerContext;
