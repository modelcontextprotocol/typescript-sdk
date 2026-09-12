import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { normalizeHeaders } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export function createTransport(): StreamableHTTPServerTransport {
    return new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'strict-transport-test' });
}

export async function connect(server: Server, transport: StreamableHTTPServerTransport): Promise<void> {
    await server.connect(transport);
}

export function handle(transport: StreamableHTTPServerTransport, request: IncomingMessage, response: ServerResponse): Promise<void> {
    return transport.handleRequest(request, response);
}

export function configure(transport: Transport): void {
    transport.onclose = () => {};
    transport.onerror = (error: Error) => {
        error.message.toUpperCase();
    };
    transport.onmessage = <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => {
        const sameMessage: T = message;
        sameMessage.jsonrpc.toUpperCase();
        extra?.authInfo?.token.toUpperCase();
    };
    transport.onclose = undefined;
    transport.onerror = undefined;
    transport.onmessage = undefined;
}

export function configureNode(transport: StreamableHTTPServerTransport): void {
    configure(transport);
    transport.onclose = undefined;
    transport.onerror = undefined;
    transport.onmessage = undefined;
    const sessionId: string | undefined = transport.sessionId;
    sessionId?.toUpperCase();
}

export const withoutCallbacks: Transport = {
    async start() {},
    async send() {},
    async close() {}
};

export const clearedCallbacks: Transport = {
    ...withoutCallbacks,
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
    sessionId: undefined
};

export function headers(input: Parameters<typeof normalizeHeaders>[0]): Record<string, string> {
    normalizeHeaders(new Headers({ authorization: 'example' }));
    normalizeHeaders([['authorization', 'example']]);
    normalizeHeaders({ authorization: 'example' });
    normalizeHeaders(undefined);
    return normalizeHeaders(input);
}
