/**
 * SEP-2243 standard-header server-side validation at the createMcpHandler
 * entry (protocol revision 2026-07-28).
 *
 * The presence and `Mcp-Name` cross-check half of the standard-header rung,
 * evaluated by the entry on a modern-classified request immediately after the
 * body-primary classifier returns a modern route. A missing
 * `MCP-Protocol-Version` header, a missing `Mcp-Method`
 * header, a missing `Mcp-Name` header on a `tools/call` / `prompts/get` /
 * `resources/read` request or (SEP-2663) a `tasks/get` / `tasks/update` /
 * `tasks/cancel` request, an `Mcp-Name` value disagreeing with
 * `params.name` / `params.uri` / `params.taskId`, and an invalid `Mcp-Name`
 * Base64 sentinel are
 * all rejected `400` / `-32020` (`HeaderMismatch`) on the
 * `standard-header-validation` rung — the same shape the classifier already
 * emits for the `MCP-Protocol-Version` and `Mcp-Method` mismatch cells on the
 * edge `era-classification` rung. Legacy-era traffic is byte-unchanged.
 */
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    encodeMcpParamValue,
    PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { createMcpHandler } from '../../src/server/createMcpHandler';
import { McpServer } from '../../src/server/mcp';

const MODERN = '2026-07-28';
const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: 'std-header-test', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

function makeFactory(): () => McpServer {
    return () => {
        const s = new McpServer({ name: 'std-header-server', version: '1.0.0' });
        s.registerTool('echo', { inputSchema: z.object({ text: z.string().optional() }) }, async ({ text }) => ({
            content: [{ type: 'text', text: text ?? 'ok' }]
        }));
        return s;
    };
}

function modernRequest(method: string, params: Record<string, unknown>, headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'mcp-protocol-version': MODERN,
            ...headers
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 5, method, params: { ...params, _meta: ENVELOPE } })
    });
}

async function expectHeaderMismatch(response: Response): Promise<{ code: number; message: string }> {
    expect(response.status).toBe(400);
    const body = (await response.json()) as { id: unknown; error: { code: number; message: string } };
    expect(body.id).toBe(5);
    expect(body.error.code).toBe(-32_020);
    return body.error;
}

describe('SEP-2243 standard-header validation (createMcpHandler, modern era)', () => {
    it('a fully conformant tools/call passes and dispatches', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(
            modernRequest('tools/call', { name: 'echo', arguments: { text: 'hi' } }, { 'mcp-method': 'tools/call', 'mcp-name': 'echo' })
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
        expect(body.result.content[0]?.text).toBe('hi');
    });

    it('a missing MCP-Protocol-Version header is rejected 400/-32020', async () => {
        const handler = createMcpHandler(makeFactory());
        const error = await expectHeaderMismatch(
            await handler.fetch(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'mcp-method': 'tools/list'
                    },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: ENVELOPE } })
                })
            )
        );
        expect(error.message).toContain('MCP-Protocol-Version header is absent');
    });

    it('a missing MCP-Protocol-Version header is rejected under the strict (legacy: reject) posture', async () => {
        // The spec's "MAY treat a header-less request as 2025-03-26" allowance
        // is available only to a server that also serves pre-2025-06-18
        // clients; a modern-only endpoint MUST reject.
        const handler = createMcpHandler(makeFactory(), { legacy: 'reject' });
        await expectHeaderMismatch(
            await handler.fetch(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'mcp-method': 'tools/list'
                    },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: ENVELOPE } })
                })
            )
        );
    });

    it('a tools/call missing the MCP-Protocol-Version header never reaches the handler', async () => {
        let ran = false;
        const handler = createMcpHandler(() => {
            const s = new McpServer({ name: 'std-header-server', version: '1.0.0' });
            s.registerTool('echo', { inputSchema: z.object({ text: z.string().optional() }) }, async ({ text }) => {
                ran = true;
                return { content: [{ type: 'text', text: text ?? 'ok' }] };
            });
            return s;
        });
        await expectHeaderMismatch(
            await handler.fetch(
                new Request('http://localhost/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'mcp-method': 'tools/call',
                        'mcp-name': 'echo'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 5,
                        method: 'tools/call',
                        params: { name: 'echo', arguments: { text: 'ran' }, _meta: ENVELOPE }
                    })
                })
            )
        );
        expect(ran).toBe(false);
    });

    it('a present and matching MCP-Protocol-Version header still dispatches', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(modernRequest('tools/list', {}, { 'mcp-method': 'tools/list' }));
        expect(response.status).toBe(200);
    });

    it('a present-but-disagreeing MCP-Protocol-Version header is still rejected 400/-32020', async () => {
        // The absence cell added above must not displace the pre-existing
        // disagreement cell, which the classifier still answers on its edge
        // `era-classification` rung before serveModern runs this rung at all.
        const handler = createMcpHandler(makeFactory());
        const error = await expectHeaderMismatch(
            await handler.fetch(modernRequest('tools/list', {}, { 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'tools/list' }))
        );
        expect(error.message).toContain('MCP-Protocol-Version header names 2025-11-25');
    });

    it('a missing Mcp-Method header is rejected 400/-32020', async () => {
        const handler = createMcpHandler(makeFactory());
        const error = await expectHeaderMismatch(await handler.fetch(modernRequest('tools/list', {})));
        expect(error.message).toContain('Mcp-Method header is absent');
    });

    it('a missing Mcp-Name header on tools/call is rejected 400/-32020', async () => {
        const handler = createMcpHandler(makeFactory());
        const error = await expectHeaderMismatch(
            await handler.fetch(modernRequest('tools/call', { name: 'echo', arguments: {} }, { 'mcp-method': 'tools/call' }))
        );
        expect(error.message).toContain('Mcp-Name header is absent');
    });

    it('an Mcp-Name header disagreeing with params.name is rejected 400/-32020', async () => {
        const handler = createMcpHandler(makeFactory());
        const error = await expectHeaderMismatch(
            await handler.fetch(
                modernRequest('tools/call', { name: 'echo', arguments: {} }, { 'mcp-method': 'tools/call', 'mcp-name': 'wrong' })
            )
        );
        expect(error.message).toContain('Mcp-Name header names "wrong"');
    });

    it('Mcp-Name accepts an OWS-padded value (RFC 9110 §5.5; Fetch Headers normalises)', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(
            modernRequest('tools/call', { name: 'echo', arguments: {} }, { 'mcp-method': 'tools/call', 'mcp-name': '  echo  ' })
        );
        expect(response.status).toBe(200);
    });

    it('Mcp-Name decodes a Base64 sentinel before comparison', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(
            modernRequest(
                'tools/call',
                { name: 'echo', arguments: {} },
                { 'mcp-method': 'tools/call', 'mcp-name': encodeMcpParamValue('echo') }
            )
        );
        // `encodeMcpParamValue('echo')` is plain ASCII, so the sentinel is not
        // applied; assert the explicit-sentinel case below instead.
        expect(response.status).toBe(200);
        const sentinel = await handler.fetch(
            modernRequest(
                'tools/call',
                { name: 'echo', arguments: {} },
                { 'mcp-method': 'tools/call', 'mcp-name': `=?base64?${Buffer.from('echo').toString('base64')}?=` }
            )
        );
        expect(sentinel.status).toBe(200);
    });

    it('an invalid Mcp-Name Base64 sentinel is rejected 400/-32020', async () => {
        const handler = createMcpHandler(makeFactory());
        await expectHeaderMismatch(
            await handler.fetch(
                modernRequest(
                    'tools/call',
                    { name: 'echo', arguments: {} },
                    { 'mcp-method': 'tools/call', 'mcp-name': '=?base64?SGVsbG8?=' }
                )
            )
        );
    });

    it('Mcp-Name is not required for methods outside its source map', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(modernRequest('tools/list', {}, { 'mcp-method': 'tools/list' }));
        expect(response.status).toBe(200);
    });

    it('a missing Mcp-Name header on tasks/get is rejected 400/-32020 at the entry (SEP-2663)', async () => {
        const handler = createMcpHandler(makeFactory());
        const error = await expectHeaderMismatch(
            await handler.fetch(modernRequest('tasks/get', { taskId: 'task-123' }, { 'mcp-method': 'tasks/get' }))
        );
        expect(error.message).toContain('params.taskId="task-123"');
        expect(error.message).toContain('Mcp-Name header is absent');
    });
});

describe('SEP-2243 standard-header validation is era-gated', () => {
    it('legacy traffic is byte-untouched: a 2025-era initialize without standard headers still serves', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(
            new Request('http://localhost/mcp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 5,
                    method: 'initialize',
                    params: { protocolVersion: '2025-11-25', clientInfo: { name: 'c', version: '1' }, capabilities: {} }
                })
            })
        );
        // The default 'stateless' legacy posture answers initialize.
        expect(response.status).toBe(200);
    });

    it.each(['GET', 'DELETE'])('a body-less %s is method-routed, never standard-header validated', async httpMethod => {
        // The modern era is POST-only, so a body-less session operation never
        // reaches a modern route and the presence rung cannot fire on it —
        // whatever it lacks in standard headers. It is answered by the
        // http-method rung instead: 405 / -32000, never 400 / -32020.
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(new Request('http://localhost/mcp', { method: httpMethod }));
        expect(response.status).toBe(405);
        const body = (await response.json()) as { error: { code: number } };
        expect(body.error.code).toBe(-32_000);
    });
});
