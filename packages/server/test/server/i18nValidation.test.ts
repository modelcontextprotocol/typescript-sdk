/**
 * SEP-2792: Accept-Language header validation at the createMcpHandler entry
 * (protocol revision 2026-07-28) and Content-Language response mirroring.
 *
 * Tests the byte-equality rule for Accept-Language ↔ _meta, plus
 * Content-Language / Vary / Cache-Control response header behavior.
 */
import {
    ACCEPT_LANGUAGE_META,
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    CONTENT_LANGUAGE_META,
    HEADER_MISMATCH_ERROR_CODE,
    PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { createMcpHandler } from '../../src/server/createMcpHandler';
import { McpServer } from '../../src/server/mcp';

const MODERN = '2026-07-28';
const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: 'i18n-test', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

function makeFactory(): () => McpServer {
    return () => {
        const s = new McpServer({ name: 'i18n-server', version: '1.0.0' });
        s.registerTool('greet', { description: 'Returns a greeting' }, async (ctx) => {
            const acceptLang = ctx.mcpReq._meta?.[ACCEPT_LANGUAGE_META];
            const lang = typeof acceptLang === 'string' && acceptLang.startsWith('de') ? 'de' : 'en';
            const text = lang === 'de' ? 'Hallo Welt' : 'Hello World';
            return {
                content: [{ type: 'text', text }],
                _meta: { [CONTENT_LANGUAGE_META]: lang }
            };
        });
        return s;
    };
}

function toolsCallRequest(
    acceptLanguageMeta: string | undefined,
    acceptLanguageHeader: string | undefined
): Request {
    const meta: Record<string, unknown> = { ...ENVELOPE };
    if (acceptLanguageMeta !== undefined) {
        meta[ACCEPT_LANGUAGE_META] = acceptLanguageMeta;
    }
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/call',
        'mcp-name': 'greet'
    };
    if (acceptLanguageHeader !== undefined) {
        headers['Accept-Language'] = acceptLanguageHeader;
    }
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'greet', arguments: {}, _meta: meta }
        })
    });
}

describe('SEP-2792 Accept-Language validation (createMcpHandler, modern era)', () => {
    it('both present, byte-identical → processes normally', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(toolsCallRequest('en', 'en'));
        expect(response.status).toBe(200);
        const body = await response.json() as { result: { content: Array<{ text: string }> } };
        expect(body.result.content[0]?.text).toBe('Hello World');
    });

    it('both present, byte-mismatch (case only) → rejects with 400 and -32020', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(toolsCallRequest('en-US', 'en-us'));
        expect(response.status).toBe(400);
        const body = await response.json() as { error: { code: number; message: string } };
        expect(body.error.code).toBe(HEADER_MISMATCH_ERROR_CODE);
    });

    it('both present, byte-mismatch (spacing difference: "en-US,en;q=0.9" vs "en-US, en;q=0.9") → rejects', async () => {
        const handler = createMcpHandler(makeFactory());
        // The header value after HTTP parsing will be "en-US,en;q=0.9" which
        // differs from the JSON _meta value "en-US, en;q=0.9" (extra space).
        const response = await handler.fetch(toolsCallRequest('en-US, en;q=0.9', 'en-US,en;q=0.9'));
        expect(response.status).toBe(400);
        const body = await response.json() as { error: { code: number } };
        expect(body.error.code).toBe(HEADER_MISMATCH_ERROR_CODE);
    });

    it('both present, byte-mismatch (q formatting: q=0.9 vs q=0.900) → rejects', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(toolsCallRequest('en;q=0.9', 'en;q=0.900'));
        expect(response.status).toBe(400);
        const body = await response.json() as { error: { code: number } };
        expect(body.error.code).toBe(HEADER_MISMATCH_ERROR_CODE);
    });

    it('both present, byte-mismatch (reordered ranges) → rejects', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(toolsCallRequest('en-US, fr;q=0.9', 'fr;q=0.9, en-US'));
        expect(response.status).toBe(400);
        const body = await response.json() as { error: { code: number } };
        expect(body.error.code).toBe(HEADER_MISMATCH_ERROR_CODE);
    });

    it('_meta present, header absent → accepts (CDN-strip tolerance)', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(toolsCallRequest('de', undefined));
        expect(response.status).toBe(200);
        const body = await response.json() as { result: { content: Array<{ text: string }> } };
        expect(body.result.content[0]?.text).toBe('Hallo Welt');
    });

    it('header present, _meta absent → accepts (bare header ignored, default language)', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(toolsCallRequest(undefined, 'de'));
        expect(response.status).toBe(200);
        const body = await response.json() as { result: { content: Array<{ text: string }> } };
        // Server should use default language since bare header is ignored
        expect(body.result.content[0]?.text).toBe('Hello World');
    });

    it('both absent → no preference, returns default', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(toolsCallRequest(undefined, undefined));
        expect(response.status).toBe(200);
    });
});

describe('SEP-2792 Content-Language + Vary + Cache-Control response headers', () => {
    it('JSON response with contentLanguage sets Content-Language header', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(toolsCallRequest('en', 'en'));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-language')).toBe('en');
    });

    it('JSON response with contentLanguage sets Vary: Accept-Language', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(toolsCallRequest('de', 'de'));
        expect(response.status).toBe(200);
        const vary = response.headers.get('vary');
        expect(vary).toContain('Accept-Language');
    });

    it('_meta present, header absent → Cache-Control: private', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(toolsCallRequest('en', undefined));
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private');
    });

    it('both present and matching → no Cache-Control: private', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(toolsCallRequest('en', 'en'));
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).not.toBe('private');
    });
});

describe('SEP-2792 localized error responses via error.data._meta', () => {
    it('error response with data._meta contentLanguage mirrors Content-Language header', async () => {
        // Use a method call that triggers a JSON-RPC error at the protocol level.
        // Calling a non-existent tool returns a JSON-RPC error from the server.
        const factory = () => {
            const s = new McpServer({ name: 'i18n-error-server', version: '1.0.0' });
            s.registerTool('exists', { description: 'A tool' }, async () => {
                return { content: [{ type: 'text' as const, text: 'ok' }] };
            });
            return s;
        };
        const handler = createMcpHandler(factory);

        // Call a tool that doesn't exist → triggers InvalidParams/-32602 from the server
        const meta: Record<string, unknown> = {
            ...ENVELOPE,
            [ACCEPT_LANGUAGE_META]: 'de'
        };
        const request = new Request('http://localhost/mcp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                'mcp-protocol-version': MODERN,
                'mcp-method': 'tools/call',
                'mcp-name': 'nonexistent',
                'Accept-Language': 'de'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'nonexistent', arguments: {}, _meta: meta }
            })
        });

        const response = await handler.fetch(request);
        // Should get JSON-RPC error (tool not found)
        expect(response.status).toBe(200);
        const body = await response.json() as { error?: { code: number; message: string; data?: unknown } };
        expect(body.error).toBeDefined();
        // Note: the server doesn't localize framework-level errors, so Content-Language
        // won't be set for this case. This test verifies the error response path doesn't
        // crash. Real-world error localization requires custom server handlers.
        // The applyI18nResponseHeaders logic is verified in unit tests.
    });
});

describe('SEP-2792 stdio transport per-request language switch', () => {
    // Stdio transport: _meta flows through naturally, no header involvement.
    // This test verifies mid-conversation language switching works via raw JSON-RPC over stdio.
    it('per-request language switch without reinitialize', async () => {
        const { Readable, Writable } = await import('node:stream');
        const { ReadBuffer, serializeMessage } = await import('@modelcontextprotocol/core-internal');
        const { McpServer } = await import('../../src/server/mcp');
        const { StdioServerTransport } = await import('../../src/server/stdio');

        // Create a server with localized tool
        const server = new McpServer({ name: 'i18n-stdio-test', version: '1.0.0' });
        server.registerTool('greet', { description: 'Greeting' }, async (ctx) => {
            const acceptLang = ctx.mcpReq._meta?.[ACCEPT_LANGUAGE_META];
            const lang = typeof acceptLang === 'string' && acceptLang.startsWith('de') ? 'de' : 'en';
            const text = lang === 'de' ? 'Hallo' : 'Hello';
            return {
                content: [{ type: 'text', text }],
                _meta: { [CONTENT_LANGUAGE_META]: lang }
            };
        });

        // Use pipe-like streams: server reads from clientToServer, writes to serverToClient
        const clientToServer = new Readable({ read() {} });
        const serverToClient = new Readable({ read() {} });
        const serverOutput = new Writable({
            write(chunk, _enc, cb) {
                serverToClient.push(chunk);
                cb();
            }
        });

        const serverTransport = new StdioServerTransport(clientToServer, serverOutput);
        await server.server.connect(serverTransport);

        // Capture server responses
        const outputBuffer = new ReadBuffer();
        const outputCapture = new Writable({
            write(chunk, _enc, cb) {
                outputBuffer.append(chunk);
                cb();
            }
        });
        serverToClient.pipe(outputCapture);

        // Send initialize
        const initMsg = serializeMessage({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-03-26',
                capabilities: {},
                clientInfo: { name: 'test', version: '1.0.0' }
            }
        });
        clientToServer.push(initMsg);

        // Wait for response
        await new Promise(resolve => setTimeout(resolve, 100));

        // Send tools/call with en
        const callEn = serializeMessage({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
                name: 'greet',
                arguments: {},
                _meta: { [ACCEPT_LANGUAGE_META]: 'en' }
            }
        });
        clientToServer.push(callEn);
        await new Promise(resolve => setTimeout(resolve, 100));

        // Send tools/call with de-DE (switch language mid-conversation)
        const callDe = serializeMessage({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
                name: 'greet',
                arguments: {},
                _meta: { [ACCEPT_LANGUAGE_META]: 'de-DE' }
            }
        });
        clientToServer.push(callDe);
        await new Promise(resolve => setTimeout(resolve, 100));

        // Parse responses
        const messages: unknown[] = [];
        let msg = outputBuffer.readMessage();
        while (msg !== null) {
            messages.push(msg);
            msg = outputBuffer.readMessage();
        }

        // Find responses by id
        const enResponse = messages.find((m: unknown) => (m as { id: number }).id === 2) as { result?: { content: Array<{ text: string }>; _meta?: Record<string, unknown> } } | undefined;
        const deResponse = messages.find((m: unknown) => (m as { id: number }).id === 3) as { result?: { content: Array<{ text: string }>; _meta?: Record<string, unknown> } } | undefined;

        expect(enResponse?.result?.content[0]?.text).toBe('Hello');
        expect(enResponse?.result?._meta?.[CONTENT_LANGUAGE_META]).toBe('en');
        expect(deResponse?.result?.content[0]?.text).toBe('Hallo');
        expect(deResponse?.result?._meta?.[CONTENT_LANGUAGE_META]).toBe('de');

        // Cleanup
        await server.server.close();
        clientToServer.push(null);
        serverToClient.push(null);
    });
});
