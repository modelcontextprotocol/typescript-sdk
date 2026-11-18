import type { EventDescriptor, EventOccurrence } from '@modelcontextprotocol/core/ext/events';
import { EVENTS_EXTENSION_ID, WEBHOOK_SUBSCRIPTION_ID_HEADER } from '@modelcontextprotocol/core/ext/events';
import type { JSONRPCMessage, JSONRPCRequest, RequestId, ServerCapabilities, Transport } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { generateWebhookId, parseWebhookSecret, signWebhook } from '@modelcontextprotocol/core-internal/ext/events';

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

/** A scripted client, with the scripted server's side of its connection. */
export interface Scripted {
    client: Client;
    calls: Call[];
    notifications: Notification[];
    /** Sends a message from the server on the current connection. */
    send(message: JSONRPCMessage): Promise<void>;
    /** Connects the client again over a fresh pair to the same scripted server, without closing it first. */
    reconnect(): Promise<void>;
}

/**
 * A client connected over an in-memory pair to a scripted server: the handshake declares
 * `capabilities`, every other request goes to `handlers` and is recorded in `calls`. On
 * 2026-07-28 results carry `resultType: "complete"`, as a conforming server's do.
 */
export async function scriptedClient(handlers: Record<string, Handler>, options: ScriptedOptions = {}): Promise<Scripted> {
    const { capabilities = EVENTS_CAPABILITIES, revision = MODERN } = options;
    const calls: Call[] = [];
    const notifications: Notification[] = [];
    const headersById = new Map<RequestId, Record<string, string>>();
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
    let serverTx: Transport | undefined;
    // A fresh in-memory pair to the scripted server; its server side becomes the one `send` uses.
    const link = async (): Promise<Transport> => {
        const [clientTx, server] = InMemoryTransport.createLinkedPair();
        serverTx = server;
        const transport: Transport = clientTx;
        const send = transport.send.bind(transport);
        transport.send = (message, sendOptions) => {
            if ('id' in message && 'method' in message) headersById.set(message.id, { ...sendOptions?.headers });
            return send(message, sendOptions);
        };
        server.onmessage = message => {
            const request = message as JSONRPCRequest;
            if (request.id === undefined) {
                notifications.push({ method: request.method, params: (request.params ?? {}) as Record<string, unknown> });
                return;
            }
            void answer(request)
                .then(
                    result =>
                        server.send({
                            jsonrpc: '2.0',
                            id: request.id,
                            result: revision === MODERN ? { resultType: 'complete', ...result } : result
                        }),
                    (error: unknown) =>
                        server.send({
                            jsonrpc: '2.0',
                            id: request.id,
                            error: {
                                code: error instanceof RpcError ? error.code : -32_603,
                                message: error instanceof Error ? error.message : String(error),
                                ...(error instanceof RpcError && error.data !== undefined && { data: error.data })
                            }
                        })
                )
                // An answer that comes after the client closed has no one to go to.
                .catch(() => {});
        };
        await server.start();
        return transport;
    };
    const client = new Client(
        { name: 'events-test-client', version: '1.0.0' },
        revision === MODERN ? { versionNegotiation: { mode: { pin: MODERN } }, ...options.clientOptions } : options.clientOptions
    );
    options.beforeConnect?.(client);
    await client.connect(await link());
    return {
        client,
        calls,
        notifications,
        send: message => serverTx!.send(message),
        reconnect: async () => client.connect(await link())
    };
}

/** An `EventsClientExtension` attached to a scripted client before it connects. */
export async function connectEvents(
    handlers: Record<string, Handler>,
    options: ScriptedOptions & { events?: EventsClientOptions } = {}
): Promise<Scripted & { events: EventsClientExtension }> {
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

export const WEBHOOK_URL = 'https://hooks.example.com/mcp/client123';

export interface WebhookPostOptions {
    webhookId?: string;
    /** Unix seconds; default now. */
    timestamp?: number;
    /** A header to leave out. */
    omit?: string;
}

/** A webhook POST as the server sends it: `body` (a raw string, or JSON) signed with `secret` for subscription `id`. */
export async function webhookPost(body: unknown, secret: string, id: string, options: WebhookPostOptions = {}): Promise<Request> {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const webhookId = options.webhookId ?? generateWebhookId();
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'webhook-id': webhookId,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': await signWebhook([parseWebhookSecret(secret)!], webhookId, timestamp, raw),
        [WEBHOOK_SUBSCRIPTION_ID_HEADER]: id
    };
    if (options.omit !== undefined) delete headers[options.omit];
    return new Request(WEBHOOK_URL, { method: 'POST', headers, body: raw });
}
