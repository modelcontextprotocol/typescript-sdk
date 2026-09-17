import { randomUUID } from 'node:crypto';

import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/core-internal';

import { McpServer } from '../../src/server/mcp';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp';

/**
 * Wire-level continuity tests for the "Unsupported protocol version" rejection.
 *
 * The load-bearing surface is the HTTP 400 status plus the literal substring
 * `Unsupported protocol version` in the response body: the go-sdk client
 * substring-matches exactly that phrase on non-2xx bodies to drive its
 * protocol-version fallback (`streamableClientConn.checkResponse` in
 * go-sdk's `mcp/streamable.go`). Its structured JSON-RPC parse path rejects
 * this server's `id: null` error body, so the substring is the operative
 * interop signal — it must keep appearing verbatim in the wire bytes across
 * refactors of the transport internals.
 *
 * The rest of the message (prefix, echoed version, supported-versions list)
 * is asserted against a string derived from `SUPPORTED_PROTOCOL_VERSIONS`
 * rather than a frozen byte literal, so these tests survive additions to the
 * supported-versions list while still catching any rewording.
 */

const INITIALIZE_MESSAGE = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
        clientInfo: { name: 'test-client', version: '1.0' },
        protocolVersion: '2025-11-25',
        capabilities: {}
    },
    id: 'init-1'
} as JSONRPCMessage;

const TOOLS_LIST_MESSAGE = {
    jsonrpc: '2.0',
    method: 'tools/list',
    params: {},
    id: 'tools-1'
} as JSONRPCMessage;

interface JSONRPCErrorBody {
    jsonrpc: string;
    id: unknown;
    error: { code: number; message: string };
}

function postRequest(body: JSONRPCMessage, headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...headers
        },
        body: JSON.stringify(body)
    });
}

async function initializeServer(transport: WebStandardStreamableHTTPServerTransport): Promise<string> {
    const response = await transport.handleRequest(postRequest(INITIALIZE_MESSAGE));
    expect(response.status).toBe(200);
    return response.headers.get('mcp-session-id') as string;
}

async function connectedTransport(supportedProtocolVersions?: string[]): Promise<WebStandardStreamableHTTPServerTransport> {
    // `connect()` passes the server's supported protocol versions down to the
    // transport, so a custom list is configured on the server options.
    const mcpServer = new McpServer(
        { name: 'test-server', version: '1.0.0' },
        { capabilities: {}, ...(supportedProtocolVersions ? { supportedProtocolVersions } : {}) }
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID()
    });
    await mcpServer.connect(transport);
    return transport;
}

describe('Unsupported protocol version - wire literal continuity', () => {
    it('rejects an unsupported MCP-Protocol-Version header with HTTP 400, code -32000, and the sniffed literal substring', async () => {
        const transport = await connectedTransport();
        try {
            const sessionId = await initializeServer(transport);

            const response = await transport.handleRequest(
                postRequest(TOOLS_LIST_MESSAGE, {
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2099-01-01'
                })
            );

            expect(response.status).toBe(400);
            expect(response.headers.get('content-type')).toContain('application/json');

            const rawBody = await response.text();
            // The substring deployed clients (go-sdk) sniff must appear
            // verbatim in the wire bytes.
            expect(rawBody).toContain('Unsupported protocol version');

            const body = JSON.parse(rawBody) as JSONRPCErrorBody;
            expect(body.jsonrpc).toBe('2.0');
            expect(body.id).toBeNull();
            expect(body.error.code).toBe(-32_000);
            expect(body.error.message).toBe(
                `Bad Request: Unsupported protocol version: 2099-01-01 (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`
            );
        } finally {
            await transport.close();
        }
    });

    it('derives the supported-versions suffix from the per-instance supportedProtocolVersions', async () => {
        const transport = await connectedTransport(['2025-11-25', '2025-06-18']);
        try {
            const sessionId = await initializeServer(transport);

            const response = await transport.handleRequest(
                postRequest(TOOLS_LIST_MESSAGE, {
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '1999-01-01'
                })
            );

            expect(response.status).toBe(400);

            const body = (await response.json()) as JSONRPCErrorBody;
            expect(body.error.code).toBe(-32_000);
            expect(body.error.message).toBe(
                'Bad Request: Unsupported protocol version: 1999-01-01 (supported versions: 2025-11-25, 2025-06-18)'
            );
        } finally {
            await transport.close();
        }
    });
});
