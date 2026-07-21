/**
 * SEP-2792 i18n example server — per-request language negotiation.
 *
 * Demonstrates:
 * - Reading `acceptLanguage` from request `_meta`
 * - Negotiating the best match from available locales (RFC 4647)
 * - Returning localized tool title/description on `tools/list`
 * - Returning localized content + `contentLanguage` on `tools/call`
 * - Localized error responses via `error.data._meta`
 *
 * Supports both stdio and Streamable HTTP transports.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import {
    ACCEPT_LANGUAGE_META,
    CONTENT_LANGUAGE_META,
    createMcpHandler,
    McpServer,
    negotiateLanguage,
    setContentLanguage
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

// ---------------------------------------------------------------------------
// Translation dictionary (trivial in-memory, NOT gettext/ICU)
// ---------------------------------------------------------------------------

const TRANSLATIONS: Record<string, Record<string, string>> = {
    en: {
        toolTitle: 'Greeting',
        toolDescription: 'Returns a localized greeting',
        greeting: 'Hello, World!',
        errorUnknown: 'Unknown name provided'
    },
    fr: {
        toolTitle: 'Salutation',
        toolDescription: 'Retourne une salutation localisée',
        greeting: 'Bonjour le monde !',
        errorUnknown: 'Nom inconnu fourni'
    },
    de: {
        toolTitle: 'Begrüßung',
        toolDescription: 'Gibt eine lokalisierte Begrüßung zurück',
        greeting: 'Hallo Welt!',
        errorUnknown: 'Unbekannter Name angegeben'
    }
};

const AVAILABLE_LOCALES = Object.keys(TRANSLATIONS);
const DEFAULT_LOCALE = 'en';

function t(lang: string, key: string): string {
    return TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS[DEFAULT_LOCALE]![key]!;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

function buildServer(): McpServer {
    const server = new McpServer({ name: 'i18n-example', version: '1.0.0' });

    server.registerTool('get_greeting', {
        title: 'Greeting',
        description: 'Returns a localized greeting'
    }, async (ctx) => {
        // Read the client's language preference from request _meta.
        const acceptLang = ctx.mcpReq._meta?.[ACCEPT_LANGUAGE_META];
        const lang = typeof acceptLang === 'string'
            ? negotiateLanguage(acceptLang, AVAILABLE_LOCALES, DEFAULT_LOCALE)
            : DEFAULT_LOCALE;

        return {
            content: [{ type: 'text', text: t(lang, 'greeting') }],
            _meta: { [CONTENT_LANGUAGE_META]: lang }
        };
    });

    // A second tool that demonstrates localized error responses.
    server.registerTool('get_personal_greeting', {
        title: 'Personal Greeting',
        description: 'Returns a personalized greeting; errors if name is "unknown"'
    }, async (ctx) => {
        const acceptLang = ctx.mcpReq._meta?.[ACCEPT_LANGUAGE_META];
        const lang = typeof acceptLang === 'string'
            ? negotiateLanguage(acceptLang, AVAILABLE_LOCALES, DEFAULT_LOCALE)
            : DEFAULT_LOCALE;

        // Simulate a localized error.
        const errorData: Record<string, unknown> = {};
        setContentLanguage(errorData as { _meta?: Record<string, unknown> }, lang);
        return {
            content: [{ type: 'text', text: t(lang, 'errorUnknown') }],
            isError: true,
            _meta: { [CONTENT_LANGUAGE_META]: lang }
        };
    });

    return server;
}

// ---------------------------------------------------------------------------
// Entry point (stdio or HTTP)
// ---------------------------------------------------------------------------

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    void serveStdio(buildServer);
    console.error('[i18n-server] serving over stdio');
} else {
    const handler = createMcpHandler(buildServer);
    const app = createMcpHonoApp(handler);
    serve({ fetch: app.fetch, port }, () => {
        console.error(`[i18n-server] listening on http://localhost:${port}/mcp`);
    });
}
