/**
 * Content-Type validation at the Streamable HTTP entry — the parsed media
 * type decides, never a substring search of the raw header.
 *
 * The shape pinned here: `Content-Type: text/plain; a=application/json`
 * contains the substring `application/json`, but its media type is
 * `text/plain` — the transport must answer it (and any other non-JSON media
 * type) with 415 before the body is dispatched, while values whose media type
 * is `application/json` keep working regardless of parameters or case.
 */
import { z } from 'zod';
import { McpServer } from '../../src/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/webStandardStreamableHttp.js';
import { CallToolResult } from '../../src/types.js';

const executed: string[] = [];

function factory(): McpServer {
    const mcpServer = new McpServer({ name: 'ct-fixture', version: '1.0.0' });
    mcpServer.tool('run', 'records each dispatch', { cmd: z.string() }, async ({ cmd }): Promise<CallToolResult> => {
        executed.push(cmd);
        return { content: [{ type: 'text', text: `ran: ${cmd}` }] };
    });
    return mcpServer;
}

const TOOL_CALL = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'run', arguments: { cmd: 'hello' } }
};

function postRequest(body: unknown, headers: Record<string, string>): Request {
    return new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
            Accept: 'application/json, text/event-stream',
            ...headers
        },
        body: JSON.stringify(body)
    });
}

async function sendToTransport(request: Request): Promise<Response> {
    const server = factory();
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    await server.close();
    return response;
}

async function postToTransport(headers: Record<string, string>): Promise<Response> {
    return sendToTransport(postRequest(TOOL_CALL, headers));
}

beforeEach(() => {
    executed.length = 0;
});

describe('WebStandardStreamableHTTPServerTransport Content-Type validation', () => {
    it('serves an application/json POST (control)', async () => {
        const response = await postToTransport({ 'Content-Type': 'application/json' });
        expect(response.status).toBe(200);
        expect(executed).toEqual(['hello']);
    });

    it('accepts application/json with parameters', async () => {
        const response = await postToTransport({ 'Content-Type': 'application/json; charset=utf-8' });
        expect(response.status).toBe(200);
        expect(executed).toEqual(['hello']);
    });

    it('rejects text/plain with 415', async () => {
        const response = await postToTransport({ 'Content-Type': 'text/plain' });
        expect(response.status).toBe(415);
        expect(executed).toEqual([]);
    });

    it('rejects a non-JSON media type whose parameters contain `application/json` and does not dispatch', async () => {
        const response = await postToTransport({ 'Content-Type': 'text/plain; a=application/json' });
        expect(response.status).toBe(415);
        const body = (await response.json()) as { error: { code: number; message: string } };
        expect(body.error.code).toBe(-32000);
        expect(body.error.message).toContain('Content-Type must be application/json');
        expect(executed).toEqual([]);
    });

    it('rejects a POST with no Content-Type header with 415', async () => {
        // A string body makes Request auto-attach `text/plain;charset=UTF-8`;
        // delete it so this actually exercises the absent-header branch.
        const request = postRequest(TOOL_CALL, {});
        request.headers.delete('content-type');
        expect(request.headers.get('content-type')).toBeNull();
        const response = await sendToTransport(request);
        expect(response.status).toBe(415);
        expect(executed).toEqual([]);
    });

    it('accepts an unambiguous media type with a malformed parameter section (trailing semicolon)', async () => {
        const response = await postToTransport({ 'Content-Type': 'application/json;' });
        expect(response.status).toBe(200);
        expect(executed).toEqual(['hello']);
    });

    it('rejects joined duplicate Content-Type headers', async () => {
        const response = await postToTransport({ 'Content-Type': 'application/json, application/json' });
        expect(response.status).toBe(415);
        expect(executed).toEqual([]);
    });
});
