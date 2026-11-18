import type { EventDescriptor, EventOccurrence } from '@modelcontextprotocol/core/ext/events';
import { EVENTS_EXTENSION_ID } from '@modelcontextprotocol/core/ext/events';
import type { JSONRPCRequest, RequestId, ServerCapabilities, Transport } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';

import type { ClientOptions } from '../../../src/client/client';
import { Client } from '../../../src/client/client';
import type { EventsClientOptions } from '../../../src/ext/events/index';
import { EventsClientExtension } from '../../../src/ext/events/index';

export const MODERN = '2026-07-28';
export const LEGACY = '2025-11-25';

export const EVENTS_CAPABILITIES: ServerCapabilities = { extensions: { [EVENTS_EXTENSION_ID]: {} } };

/** One request the scripted server received, with the per-request headers the client handed its transport. */
export interface Call {
    id: RequestId;
    method: string;
    params: Record<string, unknown>;
    headers: Record<string, string>;
}

/** A notification the scripted server received. */
export interface Notification {
    method: string;
    params: Record<string, unknown>;
}

export type Handler = (params: Record<string, unknown>, call: Call) => Record<string, unknown> | Promise<Record<string, unknown>>;

/** A JSON-RPC error for the scripted server to answer with. */
export class RpcError extends Error {
    constructor(
        readonly code: number,
        message: string,
        readonly data?: Record<string, unknown>
    ) {
        super(message);
    }
}

export interface ScriptedOptions {
    /** What `server/discover` (or `initialize`) declares. Default: the events extension. */
    capabilities?: ServerCapabilities;
    revision?: typeof MODERN | typeof LEGACY;
    clientOptions?: ClientOptions;
    /** Runs on the client before it connects. */
    beforeConnect?: (client: Client) => void;
}

/**
 * A client connected over an in-memory pair to a scripted server: the handshake declares
 * `capabilities`, every other request goes to `handlers` and is recorded in `calls`. On
 * 2026-07-28 results carry `resultType: "complete"`, as a conforming server's do.
 */
export async function scriptedClient(
    handlers: Record<string, Handler>,
    options: ScriptedOptions = {}
): Promise<{ client: Client; calls: Call[]; notifications: Notification[] }> {
    const { capabilities = EVENTS_CAPABILITIES, revision = MODERN } = options;
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const calls: Call[] = [];
    const notifications: Notification[] = [];
    const headersById = new Map<RequestId, Record<string, string>>();
    const transport: Transport = clientTx;
    const send = transport.send.bind(transport);
    transport.send = (message, sendOptions) => {
        if ('id' in message && 'method' in message) headersById.set(message.id, { ...sendOptions?.headers });
        return send(message, sendOptions);
    };
    const answer = async (request: JSONRPCRequest): Promise<Record<string, unknown>> => {
        if (revision === MODERN && request.method === 'server/discover') {
            return {
                supportedVersions: [MODERN],
                capabilities,
                _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'scripted', version: '1.0.0' } }
            };
        }
        if (revision === LEGACY && request.method === 'initialize') {
            return { protocolVersion: LEGACY, capabilities, serverInfo: { name: 'scripted', version: '1.0.0' } };
        }
        const call = {
            id: request.id,
            method: request.method,
            params: (request.params ?? {}) as Record<string, unknown>,
            headers: headersById.get(request.id) ?? {}
        };
        calls.push(call);
        const handler = handlers[request.method];
        if (handler === undefined) throw new RpcError(-32_601, `Method not found: ${request.method}`);
        return handler(call.params, call);
    };
    serverTx.onmessage = message => {
        const request = message as JSONRPCRequest;
        if (request.id === undefined) {
            notifications.push({ method: request.method, params: (request.params ?? {}) as Record<string, unknown> });
            return;
        }
        void answer(request).then(
            result =>
                serverTx.send({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: revision === MODERN ? { resultType: 'complete', ...result } : result
                }),
            (error: unknown) =>
                serverTx.send({
                    jsonrpc: '2.0',
                    id: request.id,
                    error: {
                        code: error instanceof RpcError ? error.code : -32_603,
                        message: error instanceof Error ? error.message : String(error),
                        ...(error instanceof RpcError && error.data !== undefined && { data: error.data })
                    }
                })
        );
    };
    await serverTx.start();
    const client = new Client(
        { name: 'events-test-client', version: '1.0.0' },
        revision === MODERN ? { versionNegotiation: { mode: { pin: MODERN } }, ...options.clientOptions } : options.clientOptions
    );
    options.beforeConnect?.(client);
    await client.connect(clientTx);
    return { client, calls, notifications };
}

/** An `EventsClientExtension` attached to a scripted client before it connects. */
export async function connectEvents(
    handlers: Record<string, Handler>,
    options: ScriptedOptions & { events?: EventsClientOptions } = {}
): Promise<{ events: EventsClientExtension; client: Client; calls: Call[]; notifications: Notification[] }> {
    const events = new EventsClientExtension(options.events);
    const connected = await scriptedClient(handlers, { ...options, beforeConnect: client => events.attach(client) });
    return { events, ...connected };
}

export function descriptor(name: string, overrides: Partial<EventDescriptor> = {}): EventDescriptor {
    return {
        name,
        delivery: ['poll'],
        inputSchema: { type: 'object' },
        payloadSchema: { type: 'object' },
        ...overrides
    };
}

export function occurrence(eventId: string, name = 'tick'): EventOccurrence {
    return { eventId, name, timestamp: '2026-11-18T00:00:00Z', data: { id: eventId } };
}

/** An `events/list` handler serving `events` in one page. */
export function listing(...events: EventDescriptor[]): Handler {
    return () => ({ events });
}

/** An `events/poll` handler with nothing to deliver, asking for the next poll in a minute. */
export const quietPoll: Handler = () => ({ events: [], cursor: null, nextPollMs: 60_000 });

/** Answers each request with the next scripted result or error; once they run out, never answers. */
export function script(...answers: Array<Record<string, unknown> | RpcError>): Handler {
    return () => {
        const next = answers.shift();
        if (next === undefined) return new Promise<never>(() => {});
        if (next instanceof RpcError) throw next;
        return next;
    };
}

export const callsTo = (calls: Call[], method: string): Call[] => calls.filter(call => call.method === method);
