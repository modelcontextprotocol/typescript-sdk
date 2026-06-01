/**
 * Integration tests for SEP-2792: i18n per-request language negotiation.
 *
 * Tests HTTP transport header mirroring/mismatch and stdio per-request switching.
 */
import { randomUUID } from 'node:crypto';

import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import {
    ACCEPT_LANGUAGE_META,
    CONTENT_LANGUAGE_META,
    HEADER_MISMATCH_ERROR_CODE,
    setErrorContentLanguage
} from '@modelcontextprotocol/core';

import { ProtocolError } from '../../src/index.js';
import { Server } from '../../src/server/server.js';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp.js';

// ---------- helpers ----------

function createRequest(
    method: string,
    body?: JSONRPCMessage | JSONRPCMessage[],
    options?: {
        sessionId?: string;
        accept?: string;
        contentType?: string;
        extraHeaders?: Record<string, string>;
    }
): Request {
    const headers: Record<string, string> = {};

    if (options?.accept) {
        headers['Accept'] = options.accept;
    } else if (method === 'POST') {
        headers['Accept'] = 'application/json, text/event-stream';
    }

    if (options?.contentType) {
        headers['Content-Type'] = options.contentType;
    } else if (body) {
        headers['Content-Type'] = 'application/json';
    }

    if (options?.sessionId) {
        headers['mcp-session-id'] = options.sessionId;
        headers['mcp-protocol-version'] = '2025-11-25';
    }

    if (options?.extraHeaders) {
        Object.assign(headers, options.extraHeaders);
    }

    return new Request('http://localhost/mcp', {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });
}

function createI18nServer(): { server: Server; transport: WebStandardStreamableHTTPServerTransport } {
    const server = new Server({ name: 'i18n-test-server', version: '1.0.0' }, { capabilities: { tools: {} } });

    server.setRequestHandler('tools/list', (_request, ctx) => {
        const lang = (ctx.mcpReq._meta?.[ACCEPT_LANGUAGE_META] as string) ?? 'en';
        const titles: Record<string, string> = { en: 'Greet', fr: 'Saluer', de: 'Grüßen' };
        const resolved = lang.startsWith('fr') ? 'fr' : lang.startsWith('de') ? 'de' : 'en';

        return {
            tools: [{ name: 'greet', title: titles[resolved] ?? 'Greet', inputSchema: { type: 'object' as const } }],
            _meta: { [CONTENT_LANGUAGE_META]: resolved }
        };
    });

    server.setRequestHandler('tools/call', (request, ctx) => {
        const lang = (ctx.mcpReq._meta?.[ACCEPT_LANGUAGE_META] as string) ?? 'en';
        const name = (request.params as { arguments?: { name?: string } }).arguments?.name ?? 'World';
        const greetings: Record<string, string> = { en: `Hello, ${name}!`, fr: `Bonjour, ${name}!`, de: `Hallo, ${name}!` };
        const resolved = lang.startsWith('fr') ? 'fr' : lang.startsWith('de') ? 'de' : 'en';
        return {
            content: [{ type: 'text' as const, text: greetings[resolved] ?? greetings.en! }],
            _meta: { [CONTENT_LANGUAGE_META]: resolved }
        } as never;
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true
    });

    return { server, transport };
}

// ---------- HTTP transport integration tests ----------

describe('SEP-2792 i18n HTTP transport integration', () => {
    let transport: WebStandardStreamableHTTPServerTransport;
    let server: Server;
    let sessionId: string;

    beforeEach(async () => {
        ({ server, transport } = createI18nServer());
        await server.connect(transport);

        // Initialize
        const initReq = createRequest('POST', {
            jsonrpc: '2.0',
            method: 'initialize',
            params: { clientInfo: { name: 'test', version: '1.0' }, protocolVersion: '2025-11-25', capabilities: {} },
            id: 'init-1'
        } as JSONRPCMessage);
        const initResp = await transport.handleRequest(initReq);
        expect(initResp.status).toBe(200);
        sessionId = initResp.headers.get('mcp-session-id')!;

        // Send initialized notification
        const notifReq = createRequest(
            'POST',
            {
                jsonrpc: '2.0',
                method: 'notifications/initialized',
                params: {}
            } as JSONRPCMessage,
            { sessionId }
        );
        await transport.handleRequest(notifReq);
    });

    afterEach(async () => {
        await transport.close();
    });

    it('request: both present, byte-identical — processes normally', async () => {
        const req = createRequest(
            'POST',
            { jsonrpc: '2.0', method: 'tools/list', params: { _meta: { [ACCEPT_LANGUAGE_META]: 'fr' } }, id: 'tl-1' } as JSONRPCMessage,
            { sessionId, extraHeaders: { 'Accept-Language': 'fr' } }
        );

        const resp = await transport.handleRequest(req);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { result?: { tools?: Array<{ title?: string }>; _meta?: Record<string, unknown> } };
        expect(body.result?.tools?.[0]?.title).toBe('Saluer');
        expect(body.result?._meta?.[CONTENT_LANGUAGE_META]).toBe('fr');
    });

    it('request: both present, byte-mismatch (different tag) — rejects 400 with -32005', async () => {
        const req = createRequest(
            'POST',
            {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: { _meta: { [ACCEPT_LANGUAGE_META]: 'fr' } },
                id: 'tl-2'
            } as JSONRPCMessage,
            { sessionId, extraHeaders: { 'Accept-Language': 'de' } }
        );

        const resp = await transport.handleRequest(req);
        expect(resp.status).toBe(400);
        const body = (await resp.json()) as { error?: { code?: number; message?: string } };
        expect(body.error?.code).toBe(HEADER_MISMATCH_ERROR_CODE);
        expect(body.error?.message).toMatch(/Accept-Language/);
    });

    it('request: both present, byte-mismatch (extra space in value) — rejects', async () => {
        // "fr, en;q=0.5" vs "fr,en;q=0.5" — semantically equivalent but not byte-equal
        const req = createRequest(
            'POST',
            {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: { _meta: { [ACCEPT_LANGUAGE_META]: 'fr,en;q=0.5' } },
                id: 'tl-3'
            } as JSONRPCMessage,
            { sessionId, extraHeaders: { 'Accept-Language': 'fr, en;q=0.5' } }
        );

        const resp = await transport.handleRequest(req);
        expect(resp.status).toBe(400);
        const body = (await resp.json()) as { error?: { code?: number } };
        expect(body.error?.code).toBe(HEADER_MISMATCH_ERROR_CODE);
    });

    it('request: both present, byte-mismatch (lowercased tag) — rejects', async () => {
        const req = createRequest(
            'POST',
            {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: { _meta: { [ACCEPT_LANGUAGE_META]: 'fr-CA' } },
                id: 'tl-4'
            } as JSONRPCMessage,
            { sessionId, extraHeaders: { 'Accept-Language': 'fr-ca' } }
        );

        const resp = await transport.handleRequest(req);
        expect(resp.status).toBe(400);
        const body = (await resp.json()) as { error?: { code?: number } };
        expect(body.error?.code).toBe(HEADER_MISMATCH_ERROR_CODE);
    });

    it('request: both present, byte-mismatch (reordered ranges) — rejects', async () => {
        const req = createRequest(
            'POST',
            {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: { _meta: { [ACCEPT_LANGUAGE_META]: 'fr,en;q=0.5' } },
                id: 'tl-5'
            } as JSONRPCMessage,
            { sessionId, extraHeaders: { 'Accept-Language': 'en;q=0.5,fr' } }
        );

        const resp = await transport.handleRequest(req);
        expect(resp.status).toBe(400);
        const body = (await resp.json()) as { error?: { code?: number } };
        expect(body.error?.code).toBe(HEADER_MISMATCH_ERROR_CODE);
    });

    it('request: both present, byte-mismatch (q=1.0 vs q=1) — rejects', async () => {
        const req = createRequest(
            'POST',
            {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: { _meta: { [ACCEPT_LANGUAGE_META]: 'fr;q=1.0' } },
                id: 'tl-6'
            } as JSONRPCMessage,
            { sessionId, extraHeaders: { 'Accept-Language': 'fr;q=1' } }
        );

        const resp = await transport.handleRequest(req);
        expect(resp.status).toBe(400);
        const body = (await resp.json()) as { error?: { code?: number } };
        expect(body.error?.code).toBe(HEADER_MISMATCH_ERROR_CODE);
    });

    it('request: _meta present, header absent (CDN-strip tolerance) — honors _meta', async () => {
        const req = createRequest(
            'POST',
            {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: { _meta: { [ACCEPT_LANGUAGE_META]: 'de' } },
                id: 'tl-7'
            } as JSONRPCMessage,
            { sessionId }
        );

        const resp = await transport.handleRequest(req);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { result?: { tools?: Array<{ title?: string }>; _meta?: Record<string, unknown> } };
        expect(body.result?.tools?.[0]?.title).toBe('Grüßen');
        expect(body.result?._meta?.[CONTENT_LANGUAGE_META]).toBe('de');
    });

    it('request: header present, _meta absent — ignores header (no MCP preference)', async () => {
        const req = createRequest('POST', { jsonrpc: '2.0', method: 'tools/list', params: {}, id: 'tl-8' } as JSONRPCMessage, {
            sessionId,
            extraHeaders: { 'Accept-Language': 'fr' }
        });

        const resp = await transport.handleRequest(req);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { result?: { tools?: Array<{ title?: string }>; _meta?: Record<string, unknown> } };
        // Server returns default (en), ignoring the bare header
        expect(body.result?.tools?.[0]?.title).toBe('Greet');
        expect(body.result?._meta?.[CONTENT_LANGUAGE_META]).toBe('en');
    });

    it('response: JSON, Content-Language header mirrors _meta[contentLanguage]', async () => {
        const req = createRequest(
            'POST',
            { jsonrpc: '2.0', method: 'tools/list', params: { _meta: { [ACCEPT_LANGUAGE_META]: 'de' } }, id: 'tl-9' } as JSONRPCMessage,
            { sessionId, extraHeaders: { 'Accept-Language': 'de' } }
        );

        const resp = await transport.handleRequest(req);
        expect(resp.status).toBe(200);
        expect(resp.headers.get('content-language')).toBe('de');
    });

    it('response: Content-Language header from error response data._meta', async () => {
        // Create a server that throws a localized error
        const errorServer = new Server({ name: 'i18n-error-test', version: '1.0.0' }, { capabilities: { tools: {} } });
        errorServer.setRequestHandler('tools/call', (_request, ctx) => {
            const lang = (ctx.mcpReq._meta?.[ACCEPT_LANGUAGE_META] as string) ?? 'en';
            const resolved = lang.startsWith('fr') ? 'fr' : 'en';
            const errorData = setErrorContentLanguage({}, resolved);
            throw new ProtocolError(-32_602, `Localized error in ${resolved}`, errorData);
        });

        const errorTransport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true
        });
        await errorServer.connect(errorTransport);

        // Initialize
        const initReq = createRequest('POST', {
            jsonrpc: '2.0',
            method: 'initialize',
            params: { clientInfo: { name: 'test', version: '1.0' }, protocolVersion: '2025-11-25', capabilities: {} },
            id: 'init-err'
        } as JSONRPCMessage);
        const initResp = await errorTransport.handleRequest(initReq);
        const errSessionId = initResp.headers.get('mcp-session-id')!;

        await errorTransport.handleRequest(
            createRequest('POST', { jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as JSONRPCMessage, {
                sessionId: errSessionId
            })
        );

        // Call tool that throws localized error
        const req = createRequest(
            'POST',
            {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 'greet', arguments: {}, _meta: { [ACCEPT_LANGUAGE_META]: 'fr' } },
                id: 'err-1'
            } as JSONRPCMessage,
            { sessionId: errSessionId, extraHeaders: { 'Accept-Language': 'fr' } }
        );

        const resp = await errorTransport.handleRequest(req);
        expect(resp.status).toBe(200);
        expect(resp.headers.get('content-language')).toBe('fr');

        const body = (await resp.json()) as { error?: { code?: number; data?: unknown } };
        expect(body.error?.code).toBe(-32_602);

        await errorTransport.close();
    });
});

// ---------- stdio transport integration test ----------

describe('SEP-2792 i18n stdio transport integration', () => {
    it('supports mid-session language switching via _meta', async () => {
        // Use InMemoryTransport to simulate stdio-like transport (no HTTP headers)
        const server = new Server({ name: 'i18n-test-server', version: '1.0.0' }, { capabilities: { tools: {} } });

        server.setRequestHandler('tools/list', (_request, ctx) => {
            const lang = (ctx.mcpReq._meta?.[ACCEPT_LANGUAGE_META] as string) ?? 'en';
            const titles: Record<string, string> = { en: 'Greet', fr: 'Saluer', de: 'Grüßen' };
            const resolved = lang.startsWith('fr') ? 'fr' : lang.startsWith('de') ? 'de' : 'en';
            return {
                tools: [{ name: 'greet', title: titles[resolved] ?? 'Greet', inputSchema: { type: 'object' as const } }],
                _meta: { [CONTENT_LANGUAGE_META]: resolved }
            };
        });

        const { InMemoryTransport } = await import('@modelcontextprotocol/core');

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await server.connect(serverTransport);

        // Simulate client initialization
        const initMessage: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'initialize',
            params: { clientInfo: { name: 'test', version: '1.0' }, protocolVersion: '2025-11-25', capabilities: {} },
            id: 'init-1'
        };

        const responses: JSONRPCMessage[] = [];
        clientTransport.onmessage = msg => {
            responses.push(msg as JSONRPCMessage);
        };
        await clientTransport.start();
        await clientTransport.send(initMessage);

        // Wait for init response
        await new Promise(resolve => setTimeout(resolve, 100));

        // Send initialized notification
        await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as JSONRPCMessage);
        await new Promise(resolve => setTimeout(resolve, 50));

        responses.length = 0;

        // Request tools/list in English
        await clientTransport.send({
            jsonrpc: '2.0',
            method: 'tools/list',
            params: { _meta: { [ACCEPT_LANGUAGE_META]: 'en' } },
            id: 'en-1'
        } as JSONRPCMessage);
        await new Promise(resolve => setTimeout(resolve, 100));

        const enResp = responses.find(r => 'id' in r && r.id === 'en-1') as
            | { result?: { tools?: Array<{ title?: string }>; _meta?: Record<string, unknown> } }
            | undefined;
        expect(enResp?.result?.tools?.[0]?.title).toBe('Greet');
        expect(enResp?.result?._meta?.[CONTENT_LANGUAGE_META]).toBe('en');

        // Request tools/list in French on the SAME connection
        await clientTransport.send({
            jsonrpc: '2.0',
            method: 'tools/list',
            params: { _meta: { [ACCEPT_LANGUAGE_META]: 'fr' } },
            id: 'fr-1'
        } as JSONRPCMessage);
        await new Promise(resolve => setTimeout(resolve, 100));

        const frResp = responses.find(r => 'id' in r && r.id === 'fr-1') as
            | { result?: { tools?: Array<{ title?: string }>; _meta?: Record<string, unknown> } }
            | undefined;
        expect(frResp?.result?.tools?.[0]?.title).toBe('Saluer');
        expect(frResp?.result?._meta?.[CONTENT_LANGUAGE_META]).toBe('fr');

        // Request tools/list in German on the SAME connection
        await clientTransport.send({
            jsonrpc: '2.0',
            method: 'tools/list',
            params: { _meta: { [ACCEPT_LANGUAGE_META]: 'de' } },
            id: 'de-1'
        } as JSONRPCMessage);
        await new Promise(resolve => setTimeout(resolve, 100));

        const deResp = responses.find(r => 'id' in r && r.id === 'de-1') as
            | { result?: { tools?: Array<{ title?: string }>; _meta?: Record<string, unknown> } }
            | undefined;
        expect(deResp?.result?.tools?.[0]?.title).toBe('Grüßen');
        expect(deResp?.result?._meta?.[CONTENT_LANGUAGE_META]).toBe('de');

        await clientTransport.close();
    });
});
