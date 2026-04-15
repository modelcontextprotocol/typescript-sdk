export * from './streamableHttp.js';

// v1-compat re-exports.
export {
    /** @deprecated Use {@linkcode NodeStreamableHTTPServerTransport}. */
    NodeStreamableHTTPServerTransport as StreamableHTTPServerTransport
} from './streamableHttp.js';
export type { EventId, EventStore, StreamId } from '@modelcontextprotocol/server';
