import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import {
    ACCEPT_LANGUAGE_META,
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    CONTENT_LANGUAGE_META,
    HEADER_MISMATCH_ERROR_CODE,
    inputRequired,
    negotiateLanguage,
    PROTOCOL_VERSION_META_KEY,
    ProtocolError,
    setErrorContentLanguage
} from '@modelcontextprotocol/core-internal';
import { afterEach, describe, expect, it } from 'vitest';

import { createMcpHandler } from '../../src/server/createMcpHandler';
import { Server } from '../../src/server/server';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp';

const MODERN = '2026-07-28';
const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: 'i18n-test-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } }
};

function languageFromMeta(meta: Record<string, unknown> | undefined): string {
    const preference = meta?.[ACCEPT_LANGUAGE_META];
    return negotiateLanguage(typeof preference === 'string' ? preference : undefined, ['en', 'fr', 'de'], 'en');
}

function makeServer(): Server {
    const server = new Server(
        { name: 'i18n-test-server', version: '1.0.0' },
        { capabilities: { tools: {} }, cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'public' } } }
    );

    server.setRequestHandler('tools/list', (_request, ctx) => {
        const language = languageFromMeta(ctx.mcpReq._meta);
        return {
            tools: [
                {
                    name: 'trivia_quiz',
                    title: { en: 'Trivia quiz', fr: 'Quiz', de: 'Quizfrage' }[language],
                    inputSchema: { type: 'object' }
                }
            ],
            _meta: { [CONTENT_LANGUAGE_META]: language }
        };
    });

    server.setRequestHandler('tools/call', async (request, ctx) => {
        const explicitLanguage = request.params.arguments?.['language'];
        const language =
            typeof explicitLanguage === 'string' && ['en', 'fr', 'de'].includes(explicitLanguage)
                ? explicitLanguage
                : languageFromMeta(ctx.mcpReq._meta);
        const mode = request.params.arguments?.['mode'];
        if (mode === 'error') {
            throw new ProtocolError(-32_602, 'Localized error', setErrorContentLanguage({ reason: 'test' }, language));
        }
        if (mode === 'input') {
            return {
                ...inputRequired({
                    inputRequests: {
                        answer: inputRequired.elicit({
                            message: language === 'fr' ? 'Votre réponse ?' : 'Your answer?',
                            requestedSchema: {
                                type: 'object',
                                properties: { answer: { type: 'string' } },
                                required: ['answer']
                            }
                        })
                    }
                }),
                _meta: { [CONTENT_LANGUAGE_META]: language }
            };
        }
        const progressToken = ctx.mcpReq._meta?.progressToken;
        if (mode === 'stream' && (typeof progressToken === 'string' || typeof progressToken === 'number')) {
            await ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: {
                    progressToken,
                    progress: 0.5,
                    message: language === 'fr' ? 'En cours' : 'Working',
                    _meta: { [CONTENT_LANGUAGE_META]: language }
                }
            });
        }
        return {
            content: [{ type: 'text', text: language === 'fr' ? 'Bonjour' : language === 'de' ? 'Hallo' : 'Hello' }],
            _meta: { [CONTENT_LANGUAGE_META]: language }
        };
    });
    return server;
}

function modernRequest(
    method: 'tools/list' | 'tools/call',
    options: { metadata?: string; header?: string; arguments?: Record<string, unknown>; progress?: boolean } = {}
): Request {
    const meta: Record<string, unknown> = { ...ENVELOPE };
    if (options.metadata !== undefined) meta[ACCEPT_LANGUAGE_META] = options.metadata;
    if (options.progress) meta.progressToken = 'progress-1';

    const headers: Record<string, string> = {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'mcp-protocol-version': MODERN,
        'mcp-method': method
    };
    if (method === 'tools/call') headers['mcp-name'] = 'trivia_quiz';
    if (options.header !== undefined) headers['Accept-Language'] = options.header;

    return new Request('http://example.test/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            params: method === 'tools/list' ? { _meta: meta } : { name: 'trivia_quiz', arguments: options.arguments ?? {}, _meta: meta }
        })
    });
}

describe('SEP-2792 createMcpHandler integration', () => {
    const handlers: Array<ReturnType<typeof createMcpHandler>> = [];

    afterEach(async () => {
        await Promise.all(handlers.splice(0).map(handler => handler.close()));
    });

    function handler(responseMode: 'auto' | 'sse' | 'json' = 'json'): ReturnType<typeof createMcpHandler> {
        const created = createMcpHandler(makeServer, { responseMode });
        handlers.push(created);
        return created;
    }

    it.each([
        ['en-US', 'en-us'],
        ['en-US,en;q=0.9', 'en-US, en;q=0.9'],
        ['en;q=0.9', 'en;q=0.900'],
        ['fr, en;q=0.5', 'en;q=0.5, fr']
    ])('rejects an exact mirror mismatch (%s vs %s) with HeaderMismatch -32020', async (metadata, header) => {
        const response = await handler().fetch(modernRequest('tools/list', { metadata, header }));
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: { code: HEADER_MISMATCH_ERROR_CODE } });
    });

    it('evaluates agreement before grammar and treats an agreed malformed preference as absent', async () => {
        const response = await handler().fetch(modernRequest('tools/list', { metadata: '!!!', header: '!!!' }));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-language')).toBe('en');
        const body = (await response.json()) as { result: { tools: Array<{ title?: string }> } };
        expect(body.result.tools[0]?.title).toBe('Trivia quiz');
    });

    it('still rejects a malformed canonical value when its present mirror disagrees', async () => {
        const response = await handler().fetch(modernRequest('tools/list', { metadata: '!!!', header: 'en' }));
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: { code: HEADER_MISMATCH_ERROR_CODE } });
    });

    it('uses the complete combined value for repeated field lines in received order', async () => {
        const matching = modernRequest('tools/list', { metadata: 'en-US, en;q=0.9' });
        const matchingHeaders = new Headers(matching.headers);
        matchingHeaders.append('Accept-Language', 'en-US');
        matchingHeaders.append('Accept-Language', 'en;q=0.9');
        const response = await handler().fetch(new Request(matching, { headers: matchingHeaders }));
        expect(matchingHeaders.get('accept-language')).toBe('en-US, en;q=0.9');
        expect(response.status).toBe(200);

        const mismatching = modernRequest('tools/list', { metadata: 'en-US,en;q=0.9' });
        const mismatchingHeaders = new Headers(mismatching.headers);
        mismatchingHeaders.append('Accept-Language', 'en-US');
        mismatchingHeaders.append('Accept-Language', 'en;q=0.9');
        const mismatch = await handler().fetch(new Request(mismatching, { headers: mismatchingHeaders }));
        expect(mismatch.status).toBe(400);
    });

    it('ignores surrounding field-line OWS removed by HTTP parsing', async () => {
        const request = modernRequest('tools/list', { metadata: 'en' });
        const headers = new Headers(request.headers);
        headers.set('Accept-Language', ' \t en \t ');
        expect(headers.get('accept-language')).toBe('en');
        const response = await handler().fetch(new Request(request, { headers }));
        expect(response.status).toBe(200);
    });

    it('mirrors the selected language on JSON and preserves stable identifiers', async () => {
        const response = await handler().fetch(
            modernRequest('tools/list', { metadata: 'fr-CA, fr;q=0.9, en;q=0.5', header: 'fr-CA, fr;q=0.9, en;q=0.5' })
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('content-language')).toBe('fr');
        expect(response.headers.get('vary')).toContain('Accept-Language');
        const body = (await response.json()) as {
            result: { tools: Array<{ name: string; title?: string }>; _meta?: Record<string, unknown> };
        };
        expect(body.result.tools[0]).toMatchObject({ name: 'trivia_quiz', title: 'Quiz' });
        expect(body.result._meta?.[CONTENT_LANGUAGE_META]).toBe('fr');
    });

    it('tolerates a stripped request header, uses canonical metadata, and prevents unsafe shared caching', async () => {
        const response = await handler().fetch(modernRequest('tools/list', { metadata: 'de' }));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-language')).toBe('de');
        expect(response.headers.get('vary')).toContain('Accept-Language');
        expect(response.headers.get('cache-control')).toBe('private');
    });

    it('ignores a bare request header and falls back without error', async () => {
        const response = await handler().fetch(modernRequest('tools/list', { header: 'fr' }));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-language')).toBe('en');
        expect(response.headers.get('vary')).toBeNull();
        const body = (await response.json()) as { result: { tools: Array<{ title?: string }> } };
        expect(body.result.tools[0]?.title).toBe('Trivia quiz');
    });

    it('reports actual default language for an unsupported preference', async () => {
        const response = await handler().fetch(modernRequest('tools/list', { metadata: 'ja', header: 'ja' }));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-language')).toBe('en');
    });

    it('lets an explicit domain language argument take precedence for the content it controls', async () => {
        const response = await handler().fetch(
            modernRequest('tools/call', { metadata: 'fr', header: 'fr', arguments: { language: 'de' } })
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('content-language')).toBe('de');
        await expect(response.json()).resolves.toMatchObject({
            result: { content: [{ type: 'text', text: 'Hallo' }], _meta: { [CONTENT_LANGUAGE_META]: 'de' } }
        });
    });

    it('mirrors content language from object-shaped error.data._meta', async () => {
        const response = await handler().fetch(modernRequest('tools/call', { metadata: 'fr', header: 'fr', arguments: { mode: 'error' } }));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-language')).toBe('fr');
        await expect(response.json()).resolves.toMatchObject({
            error: { code: -32_602, data: { _meta: { [CONTENT_LANGUAGE_META]: 'fr' } } }
        });
    });

    it('reports language on an InputRequiredResult used for MRTR elicitation', async () => {
        const response = await handler().fetch(modernRequest('tools/call', { metadata: 'fr', header: 'fr', arguments: { mode: 'input' } }));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-language')).toBe('fr');
        await expect(response.json()).resolves.toMatchObject({
            result: {
                resultType: 'input_required',
                inputRequests: { answer: { method: 'elicitation/create', params: { message: 'Votre réponse ?' } } },
                _meta: { [CONTENT_LANGUAGE_META]: 'fr' }
            }
        });
    });

    it('keeps SSE reporting per-message and omits a stream-wide header', async () => {
        const response = await handler('sse').fetch(
            modernRequest('tools/call', {
                metadata: 'fr',
                header: 'fr',
                arguments: { mode: 'stream' },
                progress: true
            })
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(response.headers.get('content-language')).toBeNull();
        const body = await response.text();
        expect(body).toContain(`"${CONTENT_LANGUAGE_META}":"fr"`);
        expect(body).toContain('"method":"notifications/progress"');
        expect(body).toContain('"result"');
    });
});

describe('legacy WebStandardStreamableHTTPServerTransport integration', () => {
    it('applies the same exact request validation and JSON response mirroring', async () => {
        const server = makeServer();
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true
        });
        await server.connect(transport);

        const body: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/list',
            params: { _meta: { [ACCEPT_LANGUAGE_META]: 'fr' } }
        };
        const request = (header: string) =>
            new Request('http://example.test/mcp', {
                method: 'POST',
                headers: {
                    Accept: 'application/json, text/event-stream',
                    'Content-Type': 'application/json',
                    'mcp-protocol-version': '2025-11-25',
                    'Accept-Language': header
                },
                body: JSON.stringify(body)
            });

        const mismatch = await transport.handleRequest(request('FR'));
        expect(mismatch.status).toBe(400);
        await expect(mismatch.json()).resolves.toMatchObject({ error: { code: HEADER_MISMATCH_ERROR_CODE } });

        const response = await transport.handleRequest(request('fr'));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-language')).toBe('fr');
        await transport.close();
    });
});
