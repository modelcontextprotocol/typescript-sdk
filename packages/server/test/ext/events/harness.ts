import type {
    AuthInfo,
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse
} from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    MCP_NAME_HEADER_SOURCE,
    PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/core-internal';

import type { EventsExtension } from '../../../src/ext/events/index';
import { createMcpHandler } from '../../../src/server/createMcpHandler';
import { McpServer } from '../../../src/server/mcp';

export const MODERN = '2026-07-28';
export const LEGACY = '2025-11-25';

const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: 'events-test-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

/** Per-request options: the era (default `'modern'`), extra headers, and an abort signal. */
export interface PostInit {
    era?: 'modern' | 'legacy';
    headers?: Record<string, string>;
    signal?: AbortSignal;
}

export interface Served {
    /** Posts one JSON-RPC message; modern messages carry the envelope and the standard headers derived from the body. */
    post(message: JSONRPCRequest | JSONRPCNotification, init?: PostInit): Promise<Response>;
    /** Sends a request and resolves with its response, read from a JSON body or from the SSE stream. */
    rpc(method: string, params?: object, init?: PostInit): Promise<JSONRPCResponse>;
}

let nextId = 1;

function modernHeaders(message: JSONRPCRequest | JSONRPCNotification): Record<string, string> {
    const headers: Record<string, string> = { 'mcp-protocol-version': MODERN, 'mcp-method': message.method };
    const field = MCP_NAME_HEADER_SOURCE[message.method];
    const name = field === undefined ? undefined : (message.params as Record<string, unknown> | undefined)?.[field];
    if (typeof name === 'string') headers['mcp-name'] = name;
    return headers;
}

/** Serves `events` through `createMcpHandler`, attaching it to the fresh `McpServer` built for each request; `setup` adds more to each. */
export function serve(
    events: EventsExtension,
    options: { authInfo?: AuthInfo; responseMode?: 'auto' | 'json'; setup?: (mcp: McpServer) => void } = {}
): Served {
    const handler = createMcpHandler(
        () => {
            const mcp = new McpServer({ name: 'events-test', version: '1.0.0' });
            events.attach(mcp);
            options.setup?.(mcp);
            return mcp;
        },
        options.responseMode === undefined ? {} : { responseMode: options.responseMode }
    );

    const post = (message: JSONRPCRequest | JSONRPCNotification, init: PostInit = {}): Promise<Response> => {
        const modern = (init.era ?? 'modern') === 'modern';
        const params = (message.params ?? {}) as Record<string, unknown>;
        const body = modern
            ? { ...message, params: { ...params, _meta: { ...ENVELOPE, ...(params._meta as object | undefined) } } }
            : message;
        const request = new Request('http://localhost/mcp', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                ...(modern ? modernHeaders(message) : {}),
                ...init.headers
            },
            body: JSON.stringify(body),
            ...(init.signal === undefined ? {} : { signal: init.signal })
        });
        return handler.fetch(request, options.authInfo === undefined ? undefined : { authInfo: options.authInfo });
    };

    const rpc = async (method: string, params: object = {}, init?: PostInit): Promise<JSONRPCResponse> => {
        const id = nextId++;
        const response = await post({ jsonrpc: '2.0', id, method, params } as JSONRPCRequest, init);
        if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) return (await response.json()) as JSONRPCResponse;
        for await (const message of readFrames(response)) {
            if ('id' in message && message.id === id && ('result' in message || 'error' in message)) return message as JSONRPCResponse;
        }
        throw new Error(`${method}: the stream ended without a response`);
    };

    return { post, rpc };
}

/** The JSON-RPC messages of an SSE response, parsed from its `data:` lines as frames arrive. */
export async function* readFrames(response: Response): AsyncGenerator<JSONRPCMessage> {
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            buffer += value;
            let end: number;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const data = frame
                    .split('\n')
                    .filter(line => line.startsWith('data:'))
                    .map(line => line.slice(5).trimStart())
                    .join('\n');
                if (data !== '') yield JSON.parse(data) as JSONRPCMessage;
            }
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
}

/** The result of a response that must succeed. */
export function resultOf(reply: JSONRPCResponse): Record<string, unknown> {
    if (!('result' in reply)) throw new Error(`expected a result, got ${JSON.stringify(reply)}`);
    return reply.result as Record<string, unknown>;
}

/** The error of a response that must fail. */
export function errorOf(reply: JSONRPCResponse): JSONRPCErrorResponse['error'] {
    if (!('error' in reply)) throw new Error(`expected an error, got ${JSON.stringify(reply)}`);
    return reply.error;
}
