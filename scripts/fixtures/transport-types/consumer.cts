import Http = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
import ServerModule = require('@modelcontextprotocol/sdk/server/index.js');
import TransportModule = require('@modelcontextprotocol/sdk/shared/transport.js');
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

function createTransport(): Http.StreamableHTTPServerTransport {
    return new Http.StreamableHTTPServerTransport({ sessionIdGenerator: () => 'strict-transport-test' });
}

async function connect(server: ServerModule.Server, transport: Http.StreamableHTTPServerTransport): Promise<void> {
    await server.connect(transport);
}

function handle(transport: Http.StreamableHTTPServerTransport, request: IncomingMessage, response: ServerResponse): Promise<void> {
    return transport.handleRequest(request, response);
}

function configure(transport: Transport): void {
    transport.onclose = () => {};
    transport.onerror = error => {
        error.message.toUpperCase();
    };
    transport.onmessage = (message, extra) => {
        message.jsonrpc.toUpperCase();
        extra?.authInfo?.token.toUpperCase();
    };
    transport.onclose = undefined;
    transport.onerror = undefined;
    transport.onmessage = undefined;
}

function headers(input: Parameters<typeof TransportModule.normalizeHeaders>[0]): Record<string, string> {
    return TransportModule.normalizeHeaders(input);
}

export = { createTransport, connect, handle, configure, headers };
