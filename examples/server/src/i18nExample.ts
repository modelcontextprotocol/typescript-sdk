/**
 * SEP-2792 i18n Example Server
 *
 * Demonstrates per-request language negotiation using the MCP i18n helpers.
 * Supports three languages (en, fr, de) and exposes a `get_greeting` tool
 * with localized title, description, and response content.
 *
 * Run via stdio:   tsx src/i18nExample.ts stdio
 * Run via HTTP:    tsx src/i18nExample.ts http
 */

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/server';
import {
    ACCEPT_LANGUAGE_META,
    getAcceptLanguage,
    McpServer,
    negotiateLanguage,
    ProtocolError,
    setContentLanguage,
    setErrorContentLanguage
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

// ---------- Localization dictionaries ----------

const AVAILABLE_LANGUAGES = ['en', 'fr', 'de'];

const STRINGS: Record<string, Record<string, string>> = {
    'tool.get_greeting.title': {
        en: 'Get Greeting',
        fr: 'Obtenir un salut',
        de: 'Begrüßung erhalten'
    },
    'tool.get_greeting.description': {
        en: 'Returns a greeting in the negotiated language',
        fr: 'Retourne un salut dans la langue négociée',
        de: 'Gibt eine Begrüßung in der ausgehandelten Sprache zurück'
    },
    greeting: {
        en: 'Hello, {name}! Welcome.',
        fr: 'Bonjour, {name} ! Bienvenue.',
        de: 'Hallo, {name}! Willkommen.'
    },
    'error.name_required': {
        en: 'A name is required to generate a greeting.',
        fr: 'Un nom est requis pour générer un salut.',
        de: 'Ein Name ist erforderlich, um eine Begrüßung zu erzeugen.'
    }
};

function t(key: string, lang: string, replacements?: Record<string, string>): string {
    let template = STRINGS[key]?.[lang] ?? STRINGS[key]?.['en'] ?? key;
    if (!replacements) return template;
    for (const [k, v] of Object.entries(replacements)) {
        template = template.replace(`{${k}}`, v);
    }
    return template;
}

// ---------- Server setup ----------

function createI18nServer(): McpServer {
    const server = new McpServer(
        {
            name: 'i18n-example-server',
            version: '1.0.0'
        },
        { capabilities: { tools: {} } }
    );

    // Override tools/list to support per-request localized metadata
    server.server.setRequestHandler('tools/list', (request, ctx): ListToolsResult => {
        const acceptLang = ctx.mcpReq._meta?.[ACCEPT_LANGUAGE_META] as string | undefined;
        const lang = negotiateLanguage(acceptLang ?? '', AVAILABLE_LANGUAGES, 'en')!;

        const result: ListToolsResult = {
            tools: [
                {
                    name: 'get_greeting',
                    title: t('tool.get_greeting.title', lang),
                    description: t('tool.get_greeting.description', lang),
                    inputSchema: {
                        type: 'object' as const,
                        properties: {
                            name: { type: 'string', description: 'Name to greet' }
                        },
                        required: ['name']
                    }
                }
            ]
        };
        setContentLanguage(result, lang);
        return result;
    });

    // Register the tool for tools/call via McpServer
    server.registerTool(
        'get_greeting',
        {
            title: 'Get Greeting',
            description: 'Returns a greeting in the negotiated language',
            inputSchema: z.object({
                name: z.string().describe('Name to greet')
            })
        },
        async ({ name }, ctx): Promise<CallToolResult> => {
            const acceptLang = getAcceptLanguage(ctx.mcpReq as { _meta?: Record<string, unknown> }) ?? '';
            const lang = negotiateLanguage(acceptLang, AVAILABLE_LANGUAGES, 'en')!;

            // Demonstrate localized error: empty name triggers a localized error response
            if (!name || name.trim() === '') {
                const errorMessage = t('error.name_required', lang);
                const errorData = setErrorContentLanguage({}, lang);
                throw new ProtocolError(-32_602, errorMessage, errorData);
            }

            const result: CallToolResult = {
                content: [
                    {
                        type: 'text',
                        text: t('greeting', lang, { name })
                    }
                ]
            };
            setContentLanguage(result, lang);
            return result;
        }
    );

    return server;
}

// ---------- Transport entry points ----------

// ---------- Main ----------

const mode = process.argv[2] || 'stdio';
if (mode === 'http') {
    const app = createMcpExpressApp();

    app.post('/mcp', async (req, res) => {
        const server = createI18nServer();
        const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: undefined // stateless
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on('close', () => {
            transport.close();
            server.close();
        });
    });

    app.get('/mcp', (_req, res) => {
        res.writeHead(405).end(
            JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32_000, message: 'Method not allowed.' },
                id: null
            })
        );
    });

    app.delete('/mcp', (_req, res) => {
        res.writeHead(405).end(
            JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32_000, message: 'Method not allowed.' },
                id: null
            })
        );
    });

    const PORT = Number.parseInt(process.env.PORT ?? '3456', 10);
    app.listen(PORT, () => {
        console.error(`i18n example server running on http://localhost:${PORT}/mcp`);
    });
} else {
    const server = createI18nServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('i18n example server running on stdio');
}
