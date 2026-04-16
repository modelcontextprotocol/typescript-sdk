import { NodeStreamableHTTPServerTransport } from './streamableHttp.js';

export * from './streamableHttp.js';

/** @deprecated Use {@linkcode NodeStreamableHTTPServerTransport}. */
export const StreamableHTTPServerTransport = NodeStreamableHTTPServerTransport;
/** @deprecated Use {@linkcode NodeStreamableHTTPServerTransport}. */
export type StreamableHTTPServerTransport = NodeStreamableHTTPServerTransport;

export type { EventId, EventStore, StreamId } from '@modelcontextprotocol/server';
